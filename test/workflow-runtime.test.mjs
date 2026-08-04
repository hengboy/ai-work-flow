import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  claimAction,
  finishAction,
  recoverAction,
  resolveDecision,
  startRun,
  statusRun,
} from "../execution-runtime/lib/workflow-store.mjs";
import { createReviewPacket, verifyReviewPacket } from "../execution-runtime/lib/review-packet.mjs";
import { createArtifact, verifyArtifact } from "../execution-runtime/lib/artifact-store.mjs";

const run = promisify(execFile);
const contractPath = resolve("execution-runtime/workflow-contract.json");
const cliPath = resolve("execution-runtime/workflow-cli.mjs");
const runtimeRoot = resolve("execution-runtime");

async function runtimeIdentityRef() {
  const identity = JSON.parse(await readFile(resolve(runtimeRoot, "runtime-identity.json"), "utf8"));
  return { identity_digest: identity.identity_digest, source_revision: identity.source.revision };
}

function reviewContext() {
  return {
    spec_source: { path: "spec.md", sha256: "1".repeat(64) },
    requirements: ["README content must change"],
    standards_sources: ["MEMORY.md"],
    acceptance_evidence: [{ criterion: "content", evidence: "README changed" }],
    verification: [{ command: "test", result: "passed" }],
  };
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "workflow-runtime-"));
  await run("git", ["init", "-b", "main"], { cwd: root });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await run("git", ["config", "user.name", "Test User"], { cwd: root });
  await writeFile(join(root, "README.md"), "baseline\n");
  await run("git", ["add", "README.md"], { cwd: root });
  await run("git", ["commit", "-m", "baseline"], { cwd: root });
  return root;
}

function receipt(snapshot, claim, result = "completed", extra = {}) {
  return {
    run_id: snapshot.run_id,
    action_id: claim.action_id,
    attempt: claim.attempt,
    result,
    summary: `${claim.action_id} result`,
    artifacts: [],
    checks: [],
    ...extra,
  };
}

async function finishReady(root, snapshot, result = "completed", extra = {}) {
  const actionId = snapshot.ready_actions[0];
  const claim = await claimAction({ repository: root, run_id: snapshot.run_id, action_id: actionId, claimant: "driver", owner_pid: process.pid });
  return (await finishAction({ repository: root, receipt: receipt(snapshot, claim, result, extra) })).snapshot;
}

async function reachReview(root, digest) {
  let snapshot = await startRun({ repository: root, kind: "coding", plan_digest: digest, task_mode: "single" });
  for (let index = 0; index < 4; index += 1) snapshot = await finishReady(root, snapshot);
  assert.equal(snapshot.phase, "review_ready");
  return snapshot;
}

test("start is idempotent for one plan version and persists outside the worktree", async () => {
  const root = await repository();
  const input = { repository: root, kind: "coding", plan_digest: "a".repeat(64), task_mode: "single" };
  const first = await startRun(input);
  const second = await startRun(input);

  assert.deepEqual(second, first);
  assert.equal(first.revision, 0);
  assert.deepEqual(first.ready_actions, ["coding.prepare"]);
  assert.match(first.run_id, /^run_[0-9a-f]{24}$/);
  const common = (await run("git", ["rev-parse", "--git-common-dir"], { cwd: root })).stdout.trim();
  const runFile = join(root, common, "ai-work-flow", "runs", first.run_id, "run.json");
  assert.equal(JSON.parse(await readFile(runFile, "utf8")).run_id, first.run_id);
});

test("workflow storage rejects a symbolic-link path before writing outside Git common dir", async () => {
  const root = await repository();
  const outside = await mkdtemp(join(tmpdir(), "workflow-outside-"));
  await symlink(outside, join(root, ".git", "ai-work-flow"));
  await assert.rejects(
    startRun({ repository: root, kind: "coding", plan_digest: "9".repeat(64), task_mode: "single" }),
    /unsafe|symbolic link/,
  );
  await assert.rejects(access(join(outside, "runs")));
});

test("only one caller takes over a lock whose owner process is proven dead", async () => {
  const root = await repository();
  const snapshot = await startRun({ repository: root, kind: "coding", plan_digest: "8".repeat(64), task_mode: "single" });
  const lock = join(root, ".git", "ai-work-flow", "runs", snapshot.run_id, ".lock");
  await mkdir(lock);
  await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: 99999999, created_at: "stale" }));
  const results = await Promise.allSettled(["one", "two"].map((claimant) => claimAction({
    repository: root, run_id: snapshot.run_id, action_id: "coding.prepare", claimant, owner_pid: process.pid,
  })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
  assert.equal(results.filter((result) => result.status === "fulfilled" && result.value.claim_status === "claimed").length, 1);
  assert.equal(results.filter((result) => result.status === "fulfilled" && result.value.claim_status === "existing_claim").length, 1);
});

test("concurrent claims produce one claim and duplicate dispatch returns it", async () => {
  const root = await repository();
  const snapshot = await startRun({ repository: root, kind: "coding", plan_digest: "b".repeat(64), task_mode: "single" });
  const claims = await Promise.all(Array.from({ length: 8 }, (_, index) => claimAction({
    repository: root,
    run_id: snapshot.run_id,
    action_id: "coding.prepare",
    claimant: `session-${index}`,
    owner_pid: process.pid,
  })));

  assert.equal(claims.filter((entry) => entry.claim_status === "claimed").length, 1);
  assert.equal(claims.filter((entry) => entry.claim_status === "existing_claim").length, 7);
  assert.equal(new Set(claims.map((entry) => entry.claim_id)).size, 1);
});

test("finish advances monotonically and duplicate finish returns the canonical receipt", async () => {
  const root = await repository();
  const started = await startRun({ repository: root, kind: "coding", plan_digest: "c".repeat(64), task_mode: "single" });
  const claim = await claimAction({ repository: root, run_id: started.run_id, action_id: "coding.prepare", claimant: "session", owner_pid: process.pid });
  const completed = receipt(started, claim);
  const first = await finishAction({ repository: root, receipt: completed });
  const duplicate = await finishAction({ repository: root, receipt: completed });

  assert.equal(first.snapshot.revision, 1);
  assert.equal(first.snapshot.phase, "prepared");
  assert.deepEqual(first.snapshot.ready_actions, ["coding.implement"]);
  assert.deepEqual(duplicate.receipt, first.receipt);
  assert.deepEqual(duplicate.snapshot, first.snapshot);
  const recovered = await statusRun({ repository: root, run_id: started.run_id, action_id: "coding.prepare" });
  assert.deepEqual(recovered.result_receipt, completed);
});

test("illegal finish and live-owner recovery perform no state write", async () => {
  const root = await repository();
  const started = await startRun({ repository: root, kind: "coding", plan_digest: "d".repeat(64), task_mode: "single" });
  await assert.rejects(
    finishAction({ repository: root, receipt: { run_id: started.run_id, action_id: "coding.implement", attempt: 1, result: "completed", summary: "bad", artifacts: [], checks: [] } }),
    /not actively claimed/,
  );
  assert.equal((await statusRun({ repository: root, run_id: started.run_id })).revision, 0);

  await claimAction({ repository: root, run_id: started.run_id, action_id: "coding.prepare", claimant: "live", owner_pid: process.pid });
  await assert.rejects(recoverAction({ repository: root, run_id: started.run_id, action_id: "coding.prepare" }), /WORKFLOW_BUSY/);
  assert.equal((await statusRun({ repository: root, run_id: started.run_id })).revision, 0);
});

test("retry and recovery budgets persist and cannot reset on reload", async () => {
  const root = await repository();
  const started = await startRun({ repository: root, kind: "coding", plan_digest: "e".repeat(64), task_mode: "single" });
  const firstClaim = await claimAction({ repository: root, run_id: started.run_id, action_id: "coding.prepare", claimant: "first", owner_pid: 99999999 });
  const recovered = await recoverAction({ repository: root, run_id: started.run_id, action_id: "coding.prepare" });
  assert.equal(recovered.budgets.recover_remaining, 0);
  assert.equal(recovered.revision, 1);
  const secondClaim = await claimAction({ repository: root, run_id: started.run_id, action_id: "coding.prepare", claimant: "second", owner_pid: 99999999 });
  await assert.rejects(recoverAction({ repository: root, run_id: started.run_id, action_id: "coding.prepare" }), /RECOVERY_BUDGET_EXHAUSTED/);
  assert.equal(secondClaim.attempt, firstClaim.attempt + 1);
  assert.equal((await statusRun({ repository: root, run_id: started.run_id })).budgets.recover_remaining, 0);
});

test("generic artifacts stay local and are verified by digest", async () => {
  const root = await repository();
  const started = await startRun({ repository: root, kind: "coding", plan_digest: "7".repeat(64), task_mode: "single" });
  const ref = await createArtifact({
    repository: root,
    run_id: started.run_id,
    kind: "review_result",
    content: { verdict: "pass", findings: [] },
  });

  assert.equal(ref.kind, "review_result");
  assert.deepEqual(await verifyArtifact({ repository: root, run_id: started.run_id, ref }), { verdict: "pass", findings: [] });
  const cliCreate = spawnSync(process.execPath, [cliPath, "artifact-create", "--repository", root, "--run-id", started.run_id], {
    input: JSON.stringify({ kind: "spec_result", content: { verdict: "pass" } }), encoding: "utf8",
  });
  assert.equal(cliCreate.status, 0, cliCreate.stderr);
  const cliRef = JSON.parse(cliCreate.stdout);
  const cliVerify = spawnSync(process.execPath, [cliPath, "artifact-verify", "--repository", root, "--run-id", started.run_id], {
    input: JSON.stringify(cliRef), encoding: "utf8",
  });
  assert.equal(cliVerify.status, 0, cliVerify.stderr);
  assert.deepEqual(JSON.parse(cliVerify.stdout), { verdict: "pass" });
  await assert.rejects(verifyArtifact({ repository: root, run_id: started.run_id, ref: { ...ref, sha256: "0".repeat(64) } }), /digest/);
  await assert.rejects(createArtifact({ repository: root, run_id: started.run_id, kind: "review_packet", content: {} }), /reserved/);
});

test("review packets stay local, use current names, and reject tampering or Git drift", async () => {
  const root = await repository();
  const started = await startRun({ repository: root, kind: "coding", plan_digest: "f".repeat(64), task_mode: "single" });
  const base = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  await writeFile(join(root, "README.md"), "changed\n");
  await run("git", ["add", "README.md"], { cwd: root });
  await run("git", ["commit", "-m", "change"], { cwd: root });
  const reviewCommit = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const ref = await createReviewPacket({
    repository: root,
    run_id: started.run_id,
    review_base_commit: base,
    review_commit: reviewCommit,
    review_context: reviewContext(),
    review_slices: [{ id: "slice-1", paths: ["README.md"] }],
    runtime_identity: await runtimeIdentityRef(),
  });

  assert.equal(ref.kind, "review_packet");
  assert.ok(JSON.stringify(ref).length <= 1024);
  assert.doesNotMatch(JSON.stringify(ref), /review_context|acceptance_evidence/);
  const packet = await verifyReviewPacket({ repository: root, run_id: started.run_id, ref });
  assert.equal(packet.review_base_commit, base);
  assert.equal(packet.review_commit, reviewCommit);
  assert.equal(Object.hasOwn(packet, ["fixed", "point"].join("_")), false);
  assert.equal(Object.hasOwn(packet, ["bun", "dle"].join("")), false);

  const common = (await run("git", ["rev-parse", "--git-common-dir"], { cwd: root })).stdout.trim();
  const artifacts = join(root, common, "ai-work-flow", "runs", started.run_id, "artifacts");
  await writeFile(join(artifacts, `.${ref.id}.tmp`), "interrupted\n");
  assert.deepEqual(await createReviewPacket({
    repository: root,
    run_id: started.run_id,
    review_base_commit: base,
    review_commit: reviewCommit,
    review_context: reviewContext(),
    review_slices: [{ id: "slice-1", paths: ["README.md"] }],
    runtime_identity: await runtimeIdentityRef(),
  }), ref);

  await writeFile(join(root, "README.md"), "dirty\n");
  await assert.rejects(verifyReviewPacket({ repository: root, run_id: started.run_id, ref }), /worktree must be clean/);
  await assert.rejects(verifyReviewPacket({ repository: root, run_id: started.run_id, ref: { ...ref, sha256: "0".repeat(64) } }), /digest/);
});

test("review packet creation rejects runtime identity drift and incomplete slice coverage", async () => {
  const root = await repository();
  const started = await startRun({ repository: root, kind: "coding", plan_digest: "0".repeat(64), task_mode: "single" });
  const base = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  await writeFile(join(root, "README.md"), "changed\n");
  await run("git", ["add", "README.md"], { cwd: root });
  await run("git", ["commit", "-m", "change"], { cwd: root });
  const reviewCommit = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const baseInput = {
    repository: root,
    run_id: started.run_id,
    review_base_commit: base,
    review_commit: reviewCommit,
    review_context: reviewContext(),
    review_slices: [{ id: "slice-1", paths: ["README.md"] }],
    runtime_identity: await runtimeIdentityRef(),
  };
  await assert.rejects(createReviewPacket({ ...baseInput, runtime_identity: { identity_digest: "0".repeat(64), source_revision: "0".repeat(64) } }), /identity is drifted/);
  await assert.rejects(createReviewPacket({ ...baseInput, review_context: { ...reviewContext(), requirements: [] } }), /review context/);
  await assert.rejects(createReviewPacket({ ...baseInput, review_context: { ...reviewContext(), standards_sources: [] } }), /review context/);
  await assert.rejects(createReviewPacket({ ...baseInput, review_context: { ...reviewContext(), verification: [] } }), /review context/);
  await assert.rejects(createReviewPacket({ ...baseInput, review_slices: [{ id: "slice-1", paths: ["missing.md"] }] }), /cover every changed path/);
});

test("review packet creation rejects drift in a non-contract runtime file", async () => {
  const root = await repository();
  const copiedRoot = await mkdtemp(join(tmpdir(), "workflow-runtime-copy-"));
  const copiedRuntime = join(copiedRoot, "execution-runtime");
  await cp(runtimeRoot, copiedRuntime, { recursive: true });
  const copiedCli = join(copiedRuntime, "workflow-cli.mjs");
  const storePath = join(copiedRuntime, "lib", "workflow-store.mjs");
  await writeFile(storePath, `${await readFile(storePath, "utf8")}\n`);
  const started = JSON.parse((await run(process.execPath, [copiedCli, "start", "--repository", root, "--kind", "coding", "--plan-digest", "6".repeat(64), "--task-mode", "single"])).stdout);
  const base = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  await writeFile(join(root, "README.md"), "changed\n");
  await run("git", ["add", "README.md"], { cwd: root });
  await run("git", ["commit", "-m", "change"], { cwd: root });
  const reviewCommit = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const input = {
    review_base_commit: base,
    review_commit: reviewCommit,
    review_context: reviewContext(),
    review_slices: [{ id: "slice-1", paths: ["README.md"] }],
    runtime_identity: await runtimeIdentityRef(),
  };
  const result = spawnSync(process.execPath, [copiedCli, "review-packet-create", "--repository", root, "--run-id", started.run_id], {
    input: JSON.stringify(input), encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /runtime identity|runtime files/i);
});

test("workflow CLI resumes from canonical persisted state without prompt-carried JSON", async () => {
  const root = await repository();
  const started = JSON.parse((await run(process.execPath, [cliPath, "start", "--repository", root, "--kind", "coding", "--plan-digest", "1".repeat(64), "--task-mode", "single"])).stdout);
  const claimed = JSON.parse((await run(process.execPath, [cliPath, "claim", "--repository", root, "--run-id", started.run_id, "--action-id", "coding.prepare", "--claimant", "cli-session", "--owner-pid", String(process.pid)])).stdout);
  const finishResult = spawnSync(process.execPath, [cliPath, "finish", "--repository", root], {
    input: JSON.stringify(receipt(started, claimed)), encoding: "utf8",
  });
  assert.equal(finishResult.status, 0, finishResult.stderr);
  const finished = JSON.parse(finishResult.stdout);
  const resumed = JSON.parse((await run(process.execPath, [cliPath, "status", "--repository", root, "--run-id", started.run_id])).stdout);

  assert.deepEqual(resumed, finished.snapshot);
  assert.equal(resumed.phase, "prepared");
  assert.deepEqual(resumed.ready_actions, ["coding.implement"]);
});

test("a repeated review finding creates one resumable decision instead of another fix", async () => {
  const root = await repository();
  let snapshot = await reachReview(root, "2".repeat(64));
  snapshot = await finishReady(root, snapshot, "retryable_failure", { error: { finding_ids: ["F-001"] } });
  snapshot = await finishReady(root, snapshot);
  snapshot = await finishReady(root, snapshot);
  snapshot = await finishReady(root, snapshot, "retryable_failure", { error: { finding_ids: ["F-001"] } });

  assert.equal(snapshot.phase, "awaiting_decision");
  assert.equal(snapshot.decision_request.code, "REPEATED_REVIEW_FINDING");
  const resumed = await resolveDecision({ repository: root, run_id: snapshot.run_id, decision: { code: "REPEATED_REVIEW_FINDING", summary: "retry after explicit decision" } });
  assert.equal(resumed.phase, "rereview_ready_1");
  assert.deepEqual(resumed.ready_actions, ["coding.rereview_1"]);
});

test("two main resyncs use distinct actions and a third drift requests a decision", async () => {
  const root = await repository();
  let snapshot = await reachReview(root, "3".repeat(64));
  snapshot = await finishReady(root, snapshot);
  assert.equal(snapshot.phase, "review_passed");
  snapshot = await finishReady(root, snapshot, "retryable_failure");
  assert.equal(snapshot.budgets.main_resyncs_remaining, 1);
  for (let index = 0; index < 3; index += 1) snapshot = await finishReady(root, snapshot);
  assert.equal(snapshot.phase, "review_passed_1");
  snapshot = await finishReady(root, snapshot, "retryable_failure");
  assert.equal(snapshot.budgets.main_resyncs_remaining, 0);
  for (let index = 0; index < 3; index += 1) snapshot = await finishReady(root, snapshot);
  assert.equal(snapshot.phase, "review_passed_2");
  snapshot = await finishReady(root, snapshot, "retryable_failure");
  assert.equal(snapshot.phase, "awaiting_decision");
  assert.equal(snapshot.decision_request.code, "MAIN_RESYNC_BUDGET_EXHAUSTED");
});

test("planning and coding happy paths reach terminal state without duplicate action IDs", async () => {
  const root = await repository();
  let planning = await startRun({ repository: root, kind: "planning", plan_digest: "4".repeat(64) });
  const planningActions = [];
  while (planning.phase !== "complete") {
    planningActions.push(planning.ready_actions[0]);
    planning = await finishReady(root, planning);
  }
  assert.equal(new Set(planningActions).size, planningActions.length);

  let coding = await startRun({ repository: root, kind: "coding", plan_digest: "4".repeat(64), task_mode: "split" });
  const codingActions = [];
  while (coding.phase !== "complete") {
    codingActions.push(coding.ready_actions[0]);
    coding = await finishReady(root, coding);
  }
  assert.equal(new Set(codingActions).size, codingActions.length);
  assert.deepEqual(coding.active_claims, []);
});

test("maintenance Skill workflows use the same claim and receipt contract", async () => {
  const root = await repository();
  const cases = [
    ["agent_generation", "agents.generate"],
    ["environment_switch", "env.use"],
    ["project_initialization", "project.initialize"],
    ["navigation", "navigation.locate"],
  ];
  for (const [kind, action] of cases) {
    let snapshot = await startRun({ repository: root, kind, plan_digest: createHash("sha256").update(kind).digest("hex") });
    assert.deepEqual(snapshot.ready_actions, [action]);
    snapshot = await finishReady(root, snapshot);
    assert.equal(snapshot.phase, "complete");
  }
});
