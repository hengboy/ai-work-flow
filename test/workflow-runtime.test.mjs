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
  validateSupportAction,
} from "../execution-runtime/lib/workflow-store.mjs";
import { createReviewPacket, verifyReviewPacket } from "../execution-runtime/lib/review-packet.mjs";
import { createArtifact, verifyArtifact, writeReviewPacketArtifact } from "../execution-runtime/lib/artifact-store.mjs";
import { loadWorkflowContract } from "../execution-runtime/lib/workflow-contract.mjs";

const run = promisify(execFile);
const contractPath = resolve("execution-runtime/workflow-contract.json");
const cliPath = resolve("execution-runtime/workflow-cli.mjs");
const runtimeRoot = resolve("execution-runtime");
const contract = await loadWorkflowContract();
const TEST_PATH_CHANGE = { record_type: "1", index_status: ".", worktree_status: "M", path: "README.md" };

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

function fieldValue(field) {
  if (field === "task_mode" || field === "mode") return "single";
  if (field.endsWith("sha") || field === "base_sha" || field === "head_sha" || field === "commit_sha" || field === "resulting_sha") return "a".repeat(40);
  if (field.includes("digest") || field === "sha256") return "a".repeat(64);
  if (["terms", "known_paths", "entry_paths", "direct_dependencies", "facts", "open_decisions", "decision_history", "changed_paths", "committed_paths", "path_changes", "checks", "spec_or_task_ids", "acceptance", "finding_ids", "fixed_finding_ids", "assigned_axes", "slices", "platforms", "questions", "allowed_sources", "fact_sources", "assigned_slices", "refs", "coverage", "citation_urls", "deleted_paths"].includes(field)) return ["value"];
  if (["discovery_receipt", "source_ref", "evidence_ref", "review_context", "frozen_state", "initial_status", "clean_state", "cleanup_evidence", "state", "status", "drift", "open_decision", "acceptance_evidence", "verification"].includes(field)) return { value: true };
  return "value";
}

async function artifact(root, runId, kind, options = {}) {
  if (kind === "review_packet") return writeReviewPacketArtifact({ repository: root, run_id: runId, content: {
    review_base_commit: options.claim?.input.fields.base_sha ?? "a".repeat(40),
    review_commit: options.claim?.input.fields.review_sha ?? "b".repeat(40),
    review_context: options.claim?.input.fields.review_context ?? reviewContext(),
    review_slices: options.claim?.input.fields.slices ?? [{ id: "slice-1", paths: ["README.md"] }],
    runtime_identity: await runtimeIdentityRef(),
  } });
  if (kind === "planning_context") return createArtifact({ repository: root, run_id: runId, kind, content: {
    version: 1, plan_id: "plan", task_mode: options.taskMode ?? "single", goal: "goal", users_consumers: ["maintainer"], success_criteria: ["workflow completes"], scope: { included: ["workflow"] }, constraints: [], assumptions: [], acceptance_criteria: ["tests pass"], decisions: options.decisions ?? [], open_questions: [],
  } });
  if (kind === "change_evidence") return createArtifact({ repository: root, run_id: runId, kind, content: {
    base_sha: options.baseSha ?? options.claim?.input.fields.base_sha ?? "a".repeat(40),
    head_sha: options.headSha ?? "b".repeat(40),
    path_changes: options.pathChanges ?? [TEST_PATH_CHANGE],
    acceptance_evidence: [{ criterion: "requested behavior", evidence: "verified" }],
    verification: [{ command: "node --test", result: "passed" }],
  } });
  if (kind === "review_axis_result") {
    const packetRef = options.packetRef ?? await artifact(root, runId, "review_packet");
    return createArtifact({ repository: root, run_id: runId, kind, content: {
      axis: options.axis ?? "standards", review_packet_ref: packetRef, findings: options.findings ?? [], advisory_findings: [], coverage: options.coverage ?? ["slice-1"],
    } });
  }
  if (kind === "review_result") {
    const packetRef = options.packetRef ?? await artifact(root, runId, "review_packet");
    const findings = (options.findingIds ?? []).map((id) => ({ id, summary: "finding", observable_impact: "impact", slice_id: "slice-1", path: "README.md", hunk: "@@", minimum_fix: "fix" }));
    const coverage = options.coverage ?? ["slice-1"];
    const axisRefs = [
      await artifact(root, runId, "review_axis_result", { axis: "standards", packetRef, findings, coverage }),
      await artifact(root, runId, "review_axis_result", { axis: "spec", packetRef, coverage }),
    ];
    return createArtifact({ repository: root, run_id: runId, kind, content: { axis_result_refs: axisRefs, verdict: findings.length ? "blocking" : "passed", finding_ids: options.findingIds ?? [], coverage } });
  }
  throw new Error(`unsupported test artifact kind: ${kind}`);
}

async function actionInput(root, snapshot, actionId) {
  const inputContract = contract.io_contracts[contract.actions[actionId].io_contract].input_contract;
  const fields = Object.fromEntries(inputContract.required_fields.map((field) => [field, fieldValue(field)]));
  let artifacts = [];
  if (actionId === "coding.prepare") Object.assign(fields, { plan_digest: snapshot.plan_digest ?? "a".repeat(64), task_mode: snapshot.task_mode ?? "single" });
  if (actionId === "planning.confirm") {
    fields.decision_history = snapshot.decision_history;
    fields.discovery_receipt = (await statusRun({ repository: root, run_id: snapshot.run_id, action_id: "planning.discover" })).result_receipt;
  }
  if (["planning.write_spec", "planning.write_plan", "planning.write_tasks"].includes(actionId)) {
    artifacts = [snapshot.planning_context_ref];
    fields.mode = snapshot.task_mode;
    if (actionId === "planning.write_spec") {
      fields.source_ref = snapshot.planning_context_ref;
      fields.source_digest = snapshot.planning_context_ref.sha256;
    } else {
      const previousId = actionId === "planning.write_plan" ? "planning.write_spec" : "planning.write_plan";
      const previous = (await statusRun({ repository: root, run_id: snapshot.run_id, action_id: previousId })).result_receipt.outputs;
      fields.source_ref = previous.target;
      fields.source_digest = previous.sha256;
    }
  }
  if (actionId === "planning.commit") {
    const planningOutputs = await Promise.all(["planning.write_spec", "planning.write_plan", "planning.write_tasks"].map(async (id) => (
      await statusRun({ repository: root, run_id: snapshot.run_id, action_id: id })
    ).result_receipt.outputs));
    const paths = [...new Set(planningOutputs.flatMap((outputs) => [...outputs.changed_paths, ...(outputs.deleted_paths ?? [])]))].sort();
    const pathChanges = paths.map((path) => ({ record_type: "?", index_status: ".", worktree_status: ".", path }));
    const evidence = await artifact(root, snapshot.run_id, "change_evidence", { pathChanges });
    const content = await verifyArtifact({ repository: root, run_id: snapshot.run_id, ref: evidence });
    Object.assign(fields, { base_sha: content.base_sha, path_changes: content.path_changes, evidence_ref: evidence });
    artifacts = [evidence];
  }
  if (actionId === "coding.implement") {
    fields.base_sha = (await statusRun({ repository: root, run_id: snapshot.run_id, action_id: "coding.prepare" })).result_receipt.outputs.base_sha;
  }
  if (actionId === "coding.commit") {
    const implementation = (await statusRun({ repository: root, run_id: snapshot.run_id, action_id: "coding.implement" })).result_receipt.outputs;
    const content = await verifyArtifact({ repository: root, run_id: snapshot.run_id, ref: implementation.change_evidence_ref });
    Object.assign(fields, { base_sha: content.base_sha, path_changes: content.path_changes, evidence_ref: implementation.change_evidence_ref });
    artifacts = [implementation.change_evidence_ref];
  }
  if (contract.actions[actionId].io_contract === "review_prepare") {
    fields.review_context = reviewContext();
    fields.slices = [{ id: "slice-1", paths: ["README.md"] }];
  }
  if (["coding.fix_1", "coding.fix_2"].includes(actionId)) {
    const reviewId = actionId === "coding.fix_1" ? "coding.review" : "coding.rereview_1";
    const review = (await statusRun({ repository: root, run_id: snapshot.run_id, action_id: reviewId })).result_receipt.outputs;
    Object.assign(fields, { finding_ids: review.finding_ids, review_result_ref: review.review_result_ref });
    artifacts = [review.review_result_ref];
  }
  if (contract.actions[actionId].io_contract === "dual_axis_review") fields.assigned_axes = ["standards", "spec"];
  if (contract.actions[actionId].io_contract === "dual_axis_review") {
    const prepareIds = {
      "coding.review": "coding.prepare_review", "coding.rereview_1": "coding.prepare_rereview_1", "coding.rereview_2": "coding.prepare_rereview_2",
      "coding.resync_review_1": "coding.prepare_resync_review_1", "coding.resync_review_2": "coding.prepare_resync_review_2",
    };
    const packetRef = (await statusRun({ repository: root, run_id: snapshot.run_id, action_id: prepareIds[actionId] })).result_receipt.outputs.review_packet_ref;
    fields.review_packet_ref = packetRef;
    artifacts = [packetRef];
  }
  if (actionId === "planning.complete") {
    const outputs = {};
    for (const [name, id] of Object.entries({ spec: "planning.write_spec", plan: "planning.write_plan", tasks: "planning.write_tasks", commit: "planning.commit" })) {
      outputs[name] = (await statusRun({ repository: root, run_id: snapshot.run_id, action_id: id })).result_receipt.outputs;
    }
    fields.refs = { planning_context_ref: snapshot.planning_context_ref, task_mode: snapshot.task_mode, ...outputs };
  }
  return {
    fields,
    artifacts: artifacts.length ? artifacts : await Promise.all(inputContract.required_artifact_kinds.map((kind) => artifact(root, snapshot.run_id, kind))),
  };
}

async function actionResult(root, snapshot, claim, result) {
  const actionId = claim.action_id;
  const resultContract = contract.io_contracts[contract.actions[actionId].io_contract].result_contracts[result];
  const artifacts = await Promise.all(resultContract.required_artifact_kinds.map((kind) => artifact(root, snapshot.run_id, kind, {
    decisions: snapshot.decision_history,
    taskMode: snapshot.task_mode ?? "single",
    packetRef: claim.input.artifacts.find((ref) => ref.kind === "review_packet"),
    findingIds: result === "retryable_failure" ? ["F-001"] : [],
    claim,
  })));
  const refByKind = new Map(artifacts.map((ref) => [ref.kind, ref]));
  const refKinds = { planning_context_ref: "planning_context", change_evidence_ref: "change_evidence", review_packet_ref: "review_packet", review_result_ref: "review_result", axis_result_ref: "review_axis_result" };
  const outputs = Object.fromEntries(resultContract.required_fields.map((field) => [field, refKinds[field] ? refByKind.get(refKinds[field]) : fieldValue(field)]));
  const reviewResultRef = refByKind.get("review_result");
  if (reviewResultRef) {
    const reviewResult = await verifyArtifact({ repository: root, run_id: snapshot.run_id, ref: reviewResultRef });
    if (Object.hasOwn(outputs, "finding_ids")) outputs.finding_ids = reviewResult.finding_ids;
    if (Object.hasOwn(outputs, "coverage")) outputs.coverage = reviewResult.coverage;
  }
  const planningContextRef = refByKind.get("planning_context");
  if (planningContextRef) {
    const planningContext = await verifyArtifact({ repository: root, run_id: snapshot.run_id, ref: planningContextRef });
    outputs.plan_id = planningContext.plan_id;
    outputs.task_mode = planningContext.task_mode;
  }
  if (["planning.write_spec", "planning.write_plan", "planning.write_tasks"].includes(actionId) && result === "completed") {
    outputs.target = claim.input.fields.target;
    outputs.mode = claim.input.fields.mode;
  }
  if (actionId === "planning.complete" && result === "completed") outputs.refs = claim.input.fields.refs;
  const changeEvidenceRef = refByKind.get("change_evidence");
  if (changeEvidenceRef && result === "completed") {
    const evidence = await verifyArtifact({ repository: root, run_id: snapshot.run_id, ref: changeEvidenceRef });
    outputs.head_sha = evidence.head_sha;
    outputs.changed_paths = [...new Set(evidence.path_changes.map((change) => change.path))].sort();
    if (Object.hasOwn(outputs, "fixed_finding_ids")) outputs.fixed_finding_ids = claim.input.fields.finding_ids;
  }
  if (contract.actions[actionId].io_contract === "local_commit" && result === "completed") {
    outputs.commit_sha = "c".repeat(40);
    outputs.committed_paths = [...new Set(claim.input.fields.path_changes.map((change) => change.path))].sort();
  }
  const error = resultContract.required_error_fields ? Object.fromEntries(resultContract.required_error_fields.map((field) => [field, field === "finding_ids" ? ["F-001"] : "test error"])) : undefined;
  return { outputs, artifacts, ...(error ? { error } : {}) };
}

async function receipt(root, snapshot, claim, result = "completed", extra = {}) {
  const generated = await actionResult(root, snapshot, claim, result);
  const { outputs: extraOutputs, error: extraError, ...rest } = extra;
  return {
    run_id: snapshot.run_id,
    action_id: claim.action_id,
    attempt: claim.attempt,
    result,
    summary: `${claim.action_id} result`,
    outputs: { ...generated.outputs, ...extraOutputs },
    artifacts: generated.artifacts,
    checks: [],
    ...rest,
    ...(generated.error || extraError ? { error: { ...generated.error, ...extraError } } : {}),
  };
}

async function finishReady(root, snapshot, result = "completed", extra = {}) {
  const actionId = snapshot.ready_actions[0];
  const input = await actionInput(root, snapshot, actionId);
  const claim = await claimAction({ repository: root, run_id: snapshot.run_id, action_id: actionId, claimant: "driver", owner_pid: process.pid, input });
  return (await finishAction({ repository: root, receipt: await receipt(root, snapshot, claim, result, extra) })).snapshot;
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
  const input = await actionInput(root, snapshot, "coding.prepare");
  const lock = join(root, ".git", "ai-work-flow", "runs", snapshot.run_id, ".lock");
  await mkdir(lock);
  await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: 99999999, created_at: "stale" }));
  const results = await Promise.allSettled(["one", "two"].map((claimant) => claimAction({
    repository: root, run_id: snapshot.run_id, action_id: "coding.prepare", claimant, owner_pid: process.pid, input,
  })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
  assert.equal(results.filter((result) => result.status === "fulfilled" && result.value.claim_status === "claimed").length, 1);
  assert.equal(results.filter((result) => result.status === "fulfilled" && result.value.claim_status === "existing_claim").length, 1);
});

test("concurrent claims produce one claim and duplicate dispatch returns it", async () => {
  const root = await repository();
  const snapshot = await startRun({ repository: root, kind: "coding", plan_digest: "b".repeat(64), task_mode: "single" });
  const input = await actionInput(root, snapshot, "coding.prepare");
  const claims = await Promise.all(Array.from({ length: 8 }, (_, index) => claimAction({
    repository: root,
    run_id: snapshot.run_id,
    action_id: "coding.prepare",
    claimant: `session-${index}`,
    owner_pid: process.pid,
    input,
  })));

  assert.equal(claims.filter((entry) => entry.claim_status === "claimed").length, 1);
  assert.equal(claims.filter((entry) => entry.claim_status === "existing_claim").length, 7);
  assert.equal(new Set(claims.map((entry) => entry.claim_id)).size, 1);
  assert.ok(claims.every((entry) => JSON.stringify(entry.input) === JSON.stringify(input)));
  const replacement = await claimAction({
    repository: root, run_id: snapshot.run_id, action_id: "coding.prepare", claimant: "replacement", owner_pid: process.pid,
    input: { ...input, fields: { ...input.fields, target_base: "replacement" } },
  });
  assert.deepEqual(replacement.input, input);
});

test("finish advances monotonically and duplicate finish returns the canonical receipt", async () => {
  const root = await repository();
  const started = await startRun({ repository: root, kind: "coding", plan_digest: "c".repeat(64), task_mode: "single" });
  const input = await actionInput(root, started, "coding.prepare");
  const claim = await claimAction({ repository: root, run_id: started.run_id, action_id: "coding.prepare", claimant: "session", owner_pid: process.pid, input });
  const completed = await receipt(root, started, claim);
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

test("action contracts reject missing or extra inputs, outputs, artifacts, and retry errors", async () => {
  const root = await repository();
  const started = await startRun({ repository: root, kind: "coding", plan_digest: "5".repeat(64), task_mode: "single" });
  const input = await actionInput(root, started, "coding.prepare");
  const missing = structuredClone(input);
  delete missing.fields.target_base;
  await assert.rejects(claimAction({ repository: root, run_id: started.run_id, action_id: "coding.prepare", claimant: "missing", owner_pid: process.pid, input: missing }), /target_base/);
  await assert.rejects(claimAction({ repository: root, run_id: started.run_id, action_id: "coding.prepare", claimant: "extra", owner_pid: process.pid, input: { ...input, fields: { ...input.fields, extra: true } } }), /unsupported field/);
  const unrelated = await createArtifact({ repository: root, run_id: started.run_id, kind: "test_evidence", content: { ok: true } });
  await assert.rejects(claimAction({ repository: root, run_id: started.run_id, action_id: "coding.prepare", claimant: "artifact", owner_pid: process.pid, input: { ...input, artifacts: [unrelated] } }), /unsupported artifact kind/);

  const claim = await claimAction({ repository: root, run_id: started.run_id, action_id: "coding.prepare", claimant: "valid", owner_pid: process.pid, input });
  const valid = await receipt(root, started, claim);
  const missingOutput = structuredClone(valid);
  delete missingOutput.outputs.worktree;
  await assert.rejects(finishAction({ repository: root, receipt: missingOutput }), /worktree/);
  await assert.rejects(finishAction({ repository: root, receipt: {
    ...valid, outputs: { worktree: null, branch: null, base_sha: null, initial_status: null },
  } }), /non-empty/);
  await assert.rejects(finishAction({ repository: root, receipt: { ...valid, outputs: { ...valid.outputs, extra: true } } }), /unsupported field/);
  await assert.rejects(finishAction({ repository: root, receipt: { ...valid, artifacts: [unrelated] } }), /unsupported artifact kind/);
  await finishAction({ repository: root, receipt: valid });

  const review = await reachReview(root, "6".repeat(64));
  const reviewInput = await actionInput(root, review, "coding.review");
  const reviewClaim = await claimAction({ repository: root, run_id: review.run_id, action_id: "coding.review", claimant: "review", owner_pid: process.pid, input: reviewInput });
  const retry = await receipt(root, review, reviewClaim, "retryable_failure");
  const missingError = structuredClone(retry);
  delete missingError.error.code;
  await assert.rejects(finishAction({ repository: root, receipt: missingError }), /error.code/);
  await assert.rejects(finishAction({ repository: root, receipt: { ...retry, error: { ...retry.error, extra: true } } }), /error is invalid/);
  await finishAction({ repository: root, receipt: retry });
});

test("required collection inputs reject empty values unless the field has defined empty semantics", async () => {
  const root = await repository();
  const started = await startRun({ repository: root, kind: "navigation", plan_digest: "3".repeat(64) });
  const input = await actionInput(root, started, "navigation.locate");
  await assert.rejects(claimAction({
    repository: root, run_id: started.run_id, action_id: "navigation.locate", claimant: "empty-terms", owner_pid: process.pid,
    input: { ...input, fields: { ...input.fields, terms: [] } },
  }), /terms/);
  const claim = await claimAction({
    repository: root, run_id: started.run_id, action_id: "navigation.locate", claimant: "empty-known-paths", owner_pid: process.pid,
    input: { ...input, fields: { ...input.fields, known_paths: [] } },
  });
  assert.deepEqual(claim.input.fields.known_paths, []);
});

test("planning confirmation persists zero, one, or multiple decisions and binds context", async () => {
  const root = await repository();
  for (const count of [0, 1, 2]) {
    let snapshot = await startRun({ repository: root, kind: "planning", plan_digest: String(count + 7).repeat(64) });
    snapshot = await finishReady(root, snapshot);
    for (let index = 0; index < count; index += 1) {
      const input = await actionInput(root, snapshot, "planning.confirm");
      const claim = await claimAction({ repository: root, run_id: snapshot.run_id, action_id: "planning.confirm", claimant: `decision-${index}`, owner_pid: process.pid, input });
      const pending = await receipt(root, snapshot, claim, "needs_decision", { decision_request: { code: "PRODUCT_DECISION_REQUIRED", summary: `question ${index + 1}` } });
      snapshot = (await finishAction({ repository: root, receipt: pending })).snapshot;
      assert.equal(snapshot.phase, "awaiting_decision");
      snapshot = await resolveDecision({ repository: root, run_id: snapshot.run_id, decision: { code: "PRODUCT_DECISION_REQUIRED", summary: `answer ${index + 1}` } });
      assert.equal(snapshot.phase, "facts_ready");
      assert.equal(snapshot.decision_history.length, index + 1);
      assert.deepEqual((await statusRun({ repository: root, run_id: snapshot.run_id })).decision_history, snapshot.decision_history);
    }
    snapshot = await finishReady(root, snapshot);
    assert.equal(snapshot.phase, "context_ready");
    assert.equal(snapshot.decision_history.length, count);
    assert.equal(snapshot.task_mode, "single");
    assert.equal(snapshot.planning_context_ref.kind, "planning_context");
    const specInput = await actionInput(root, snapshot, "planning.write_spec");
    await assert.rejects(claimAction({
      repository: root, run_id: snapshot.run_id, action_id: "planning.write_spec", claimant: "stale-context", owner_pid: process.pid,
      input: { ...specInput, fields: { ...specInput.fields, source_digest: "0".repeat(64) } },
    }), /planning context/);
  }
  await assert.rejects(startRun({ repository: root, kind: "planning", plan_digest: "f".repeat(64), task_mode: "split" }), /start input/);
});

test("implementation and commit receipts must match canonical change evidence", async () => {
  const root = await repository();
  let snapshot = await startRun({ repository: root, kind: "coding", plan_digest: "2".repeat(64), task_mode: "single" });
  snapshot = await finishReady(root, snapshot);
  const implementInput = await actionInput(root, snapshot, "coding.implement");
  const implementClaim = await claimAction({ repository: root, run_id: snapshot.run_id, action_id: "coding.implement", claimant: "implement", owner_pid: process.pid, input: implementInput });
  const implementReceipt = await receipt(root, snapshot, implementClaim);
  await assert.rejects(finishAction({ repository: root, receipt: {
    ...implementReceipt, outputs: { ...implementReceipt.outputs, head_sha: "d".repeat(40) },
  } }), /change_evidence/);
  snapshot = (await finishAction({ repository: root, receipt: implementReceipt })).snapshot;
  const commitInput = await actionInput(root, snapshot, "coding.commit");
  const commitClaim = await claimAction({ repository: root, run_id: snapshot.run_id, action_id: "coding.commit", claimant: "commit", owner_pid: process.pid, input: commitInput });
  const commitReceipt = await receipt(root, snapshot, commitClaim);
  await assert.rejects(finishAction({ repository: root, receipt: {
    ...commitReceipt, outputs: { ...commitReceipt.outputs, committed_paths: ["other.md"] },
  } }), /PathChange/);
});

test("support validation derives owner from the active caller and rejects undelegated actions or artifact tampering", async () => {
  const root = await repository();
  let snapshot = await startRun({ repository: root, kind: "coding", plan_digest: "a".repeat(64), task_mode: "single" });
  snapshot = await finishReady(root, snapshot);
  const parent = await claimAction({ repository: root, run_id: snapshot.run_id, action_id: "coding.implement", claimant: "parent", owner_pid: process.pid, input: await actionInput(root, snapshot, "coding.implement") });
  const input = await actionInput(root, snapshot, "support.locate");
  const support = {
    run_id: snapshot.run_id,
    caller_ref: parent.claim_id,
    call_id: "location-call-001",
    action_id: "support.locate",
    result: "completed",
    summary: "location complete",
    outputs: { entry_paths: ["README.md"], direct_dependencies: ["package.json"], facts: ["located"], open_decisions: [] },
    artifacts: [],
    checks: ["read-back"],
  };
  assert.deepEqual(await validateSupportAction({ repository: root, caller_ref: parent.claim_id, input, receipt: support }), support);
  assert.deepEqual(await validateSupportAction({ repository: root, caller_ref: parent.claim_id, input, receipt: support }), support);
  const researchInput = await actionInput(root, snapshot, "support.research");
  const researchReceipt = {
    ...support, call_id: "research-call-001", action_id: "support.research", summary: "research complete",
    outputs: { report_path: researchInput.fields.report_path, citation_urls: ["https://example.com"], changed_paths: [researchInput.fields.report_path], checks: ["read-back"] },
  };
  await assert.rejects(validateSupportAction({ repository: root, caller_ref: parent.claim_id, input: researchInput, receipt: researchReceipt }), /not delegated/);
  await assert.rejects(validateSupportAction({ repository: root, caller_ref: parent.claim_id, input: { ...input, fields: { ...input.fields, objective: "replacement" } }, receipt: support }), /different input/);

  const review = await reachReview(root, "1".repeat(64));
  const reviewParent = await claimAction({ repository: root, run_id: review.run_id, action_id: "coding.review", claimant: "review-parent", owner_pid: process.pid, input: await actionInput(root, review, "coding.review") });
  const packetRef = reviewParent.input.artifacts[0];
  const axisRef = await artifact(root, review.run_id, "review_axis_result", { axis: "standards", packetRef });
  const axisInput = { fields: { review_packet_ref: packetRef, assigned_slices: ["slice-1"], axis: "standards" }, artifacts: [packetRef] };
  const tampered = { ...axisRef, sha256: "0".repeat(64) };
  const axisReceipt = {
    run_id: review.run_id, caller_ref: reviewParent.claim_id, call_id: "axis-call-0001", action_id: "support.review_standards", result: "completed", summary: "axis complete",
    outputs: { axis_result_ref: tampered, finding_ids: [], coverage: ["slice-1"] }, artifacts: [tampered], checks: [],
  };
  await assert.rejects(validateSupportAction({ repository: root, caller_ref: reviewParent.claim_id, input: axisInput, receipt: axisReceipt }), /digest/);
});

test("illegal finish and live-owner recovery perform no state write", async () => {
  const root = await repository();
  const started = await startRun({ repository: root, kind: "coding", plan_digest: "d".repeat(64), task_mode: "single" });
  await assert.rejects(
    finishAction({ repository: root, receipt: { run_id: started.run_id, action_id: "coding.implement", attempt: 1, result: "completed", summary: "bad", outputs: {}, artifacts: [], checks: [] } }),
    /requires|invalid/,
  );
  assert.equal((await statusRun({ repository: root, run_id: started.run_id })).revision, 0);

  await claimAction({ repository: root, run_id: started.run_id, action_id: "coding.prepare", claimant: "live", owner_pid: process.pid, input: await actionInput(root, started, "coding.prepare") });
  await assert.rejects(recoverAction({ repository: root, run_id: started.run_id, action_id: "coding.prepare" }), /WORKFLOW_BUSY/);
  assert.equal((await statusRun({ repository: root, run_id: started.run_id })).revision, 0);
});

test("retry and recovery budgets persist and cannot reset on reload", async () => {
  const root = await repository();
  const started = await startRun({ repository: root, kind: "coding", plan_digest: "e".repeat(64), task_mode: "single" });
  const input = await actionInput(root, started, "coding.prepare");
  const firstClaim = await claimAction({ repository: root, run_id: started.run_id, action_id: "coding.prepare", claimant: "first", owner_pid: 99999999, input });
  const recovered = await recoverAction({ repository: root, run_id: started.run_id, action_id: "coding.prepare" });
  assert.equal(recovered.budgets.recover_remaining, 0);
  assert.equal(recovered.revision, 1);
  const secondClaim = await claimAction({ repository: root, run_id: started.run_id, action_id: "coding.prepare", claimant: "second", owner_pid: 99999999, input });
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
    kind: "spec_result",
    content: { verdict: "pass", findings: [] },
  });

  assert.equal(ref.kind, "spec_result");
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

test("review artifacts require two axes, stable findings, aggregate coverage, and untampered refs", async () => {
  const root = await repository();
  const started = await startRun({ repository: root, kind: "coding", plan_digest: "b".repeat(64), task_mode: "single" });
  const packetRef = await artifact(root, started.run_id, "review_packet");
  const finding = { id: "STD-slice-1-001", summary: "issue", observable_impact: "failure", slice_id: "slice-1", path: "README.md", hunk: "@@ -1 +1 @@", minimum_fix: "correct output" };
  await assert.rejects(createArtifact({ repository: root, run_id: started.run_id, kind: "review_axis_result", content: {
    axis: "standards", review_packet_ref: packetRef, findings: [], advisory_findings: [], coverage: ["wrong-slice"],
  } }), /ReviewPacket slices/);
  const standards = await createArtifact({ repository: root, run_id: started.run_id, kind: "review_axis_result", content: {
    axis: "standards", review_packet_ref: packetRef, findings: [finding], advisory_findings: [], coverage: ["slice-1"],
  } });
  const spec = await createArtifact({ repository: root, run_id: started.run_id, kind: "review_axis_result", content: {
    axis: "spec", review_packet_ref: packetRef, findings: [], advisory_findings: [], coverage: ["slice-1"],
  } });
  const result = await createArtifact({ repository: root, run_id: started.run_id, kind: "review_result", content: {
    axis_result_refs: [standards, spec], verdict: "blocking", finding_ids: [finding.id], coverage: ["slice-1"],
  } });
  assert.equal((await verifyArtifact({ repository: root, run_id: started.run_id, ref: result })).verdict, "blocking");
  await assert.rejects(createArtifact({ repository: root, run_id: started.run_id, kind: "review_result", content: {
    axis_result_refs: [standards, spec], verdict: "blocking", finding_ids: [finding.id, finding.id], coverage: ["slice-1"],
  } }), /finding IDs/);
  await assert.rejects(createArtifact({ repository: root, run_id: started.run_id, kind: "review_result", content: {
    axis_result_refs: [standards, spec], verdict: "blocking", finding_ids: [finding.id], coverage: ["wrong-slice"],
  } }), /coverage/);
  await assert.rejects(createArtifact({ repository: root, run_id: started.run_id, kind: "review_result", content: {
    axis_result_refs: [{ ...standards, sha256: "0".repeat(64) }, spec], verdict: "blocking", finding_ids: [finding.id], coverage: ["slice-1"],
  } }), /digest/);
});

test("review receipt coverage must match the packet-bound aggregate result", async () => {
  const root = await repository();
  const snapshot = await reachReview(root, "6".repeat(64));
  const input = await actionInput(root, snapshot, "coding.review");
  const claim = await claimAction({ repository: root, run_id: snapshot.run_id, action_id: "coding.review", claimant: "coverage", owner_pid: process.pid, input });
  const completed = await receipt(root, snapshot, claim);
  await assert.rejects(finishAction({ repository: root, receipt: {
    ...completed, outputs: { ...completed.outputs, coverage: ["wrong-slice"] },
  } }), /review_result/);
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
  const input = await actionInput(root, started, "coding.prepare");
  const claimed = JSON.parse((await run(process.execPath, [cliPath, "claim", "--repository", root, "--run-id", started.run_id, "--action-id", "coding.prepare", "--claimant", "cli-session", "--owner-pid", String(process.pid), "--input-json", JSON.stringify(input)])).stdout);
  const completed = await receipt(root, started, claimed);
  const finishResult = spawnSync(process.execPath, [cliPath, "finish", "--repository", root], {
    input: JSON.stringify(completed), encoding: "utf8",
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
