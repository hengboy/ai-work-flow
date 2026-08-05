import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { dispatchWorkflowTool } from "../execution-runtime/lib/workflow-broker.mjs";
import { loadWorkflowContract, validateArtifactContent } from "../execution-runtime/lib/workflow-contract.mjs";
import { parsePlanBundle, workflowLeaseMilliseconds } from "../execution-runtime/lib/workflow-v2-store.mjs";

const run = promisify(execFile);
const sha = (value) => createHash("sha256").update(value).digest("hex");

test("review_result requires raw canonical axis objects", async () => {
  const contract = await loadWorkflowContract();
  const standards = { axis: "standards", findings: [], advisory_findings: [], coverage: ["mapper", "integration-test"] };
  const spec = { axis: "spec", findings: [], advisory_findings: [], coverage: ["mapper", "integration-test"] };
  const canonical = { axis_results: [standards, spec], verdict: "passed", finding_ids: [], coverage: ["mapper", "integration-test"] };

  assert.equal(validateArtifactContent("review_result", canonical, contract), canonical);
  assert.throws(() => validateArtifactContent("review_result", {
    ...canonical,
    axis_results: [
      { result: "completed", summary: "standards passed", review_axis_result: standards },
      { result: "completed", summary: "spec passed", review_axis_result: spec },
    ],
  }, contract), /review_axis_result/);
});

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "workflow-v2-runtime-"));
  await run("git", ["init", "-b", "main"], { cwd: root });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await run("git", ["config", "user.name", "Test User"], { cwd: root });
  await writeFile(join(root, "README.md"), "baseline\n");
  await run("git", ["add", "README.md"], { cwd: root });
  await run("git", ["commit", "-m", "baseline"], { cwd: root });
  await writeFile(join(root, ".git", "info", "exclude"), "/.worktrees/\n", { flag: "a" });
  return realpath(root);
}

async function linkedWorktree(root, name) {
  const worktree = join(root, ".worktrees", name);
  await mkdir(join(root, ".worktrees"), { recursive: true });
  await run("git", ["worktree", "add", "--detach", worktree, "HEAD"], { cwd: root });
  return worktree;
}

async function planFixture(root, taskMode = "single") {
  const directory = join(root, ".ai-work-flow", "plans", "example");
  await mkdir(directory, { recursive: true });
  const spec = "# Example\n\n## Spec Metadata\n\n- plan-id: `example`\n- status: `approved`\n\n## Acceptance Criteria\n\n- Tests pass\n";
  await writeFile(join(directory, "spec.md"), spec);
  const plan = `# Example\n\n## Plan Metadata\n\n- plan-id: \`example\`\n- status: \`ready-for-implementation\`\n- source_spec: \`.ai-work-flow/plans/example/spec.md\`\n- source_spec_digest: \`${sha(spec)}\`\n- task_mode: \`${taskMode}\`\n\n## Acceptance Criteria\n\n- Tests pass\n`;
  await writeFile(join(directory, "plan.md"), plan);
  if (taskMode === "split") {
    await mkdir(join(directory, "tasks"));
    await writeFile(join(directory, "tasks", "01-implement.md"), `# Implement\n\n- source_plan_digest: \`${sha(plan)}\`\n`);
  }
  return { directory, spec, plan };
}

test("plan start deterministically derives and validates the PlanBundle", async () => {
  const root = await repository();
  const fixture = await planFixture(root, "split");
  const bundle = await parsePlanBundle(root, fixture.directory);
  assert.equal(bundle.task_mode, "split");
  assert.deepEqual(bundle.implementation_ids, ["01-implement"]);
  assert.deepEqual(bundle.acceptance, ["Tests pass"]);
  const started = await dispatchWorkflowTool("coding_start_plan", { plan_path: join(fixture.directory, "plan.md") }, { cwd: root });
  assert.equal(started.phase, "started");
  await writeFile(join(fixture.directory, "spec.md"), fixture.spec + "tampered\n");
  await assert.rejects(dispatchWorkflowTool("coding_start_plan", { plan_path: fixture.directory }, { cwd: root }), /digest/);
});

test("plan start accepts the managed Chinese acceptance heading", async () => {
  const root = await repository();
  const fixture = await planFixture(root);
  const chineseSpec = fixture.spec.replace("## Acceptance Criteria", "## 验收标准");
  await writeFile(join(fixture.directory, "spec.md"), chineseSpec);
  const chinesePlan = fixture.plan.replace(sha(fixture.spec), sha(chineseSpec)).replace("## Acceptance Criteria\n\n- Tests pass\n", "");
  await writeFile(join(fixture.directory, "plan.md"), chinesePlan);
  const started = await dispatchWorkflowTool("coding_start_plan", { plan_path: fixture.directory }, { cwd: root });
  assert.equal(started.phase, "started");
});

test("claim uses a fixed 30-minute lease and reports busy", async () => {
  assert.equal(workflowLeaseMilliseconds, 1_800_000);
  const root = await repository();
  const started = await dispatchWorkflowTool("planning_start", { objective: "Plan a feature" }, { cwd: root });
  const first = await dispatchWorkflowTool("workflow_claim_next", { run_id: started.run_id }, { cwd: root });
  const busy = await dispatchWorkflowTool("workflow_claim_next", { run_id: started.run_id }, { cwd: root });
  assert.equal(busy.status, "busy");
  assert.equal(busy.action_id, first.dispatch.action_id);
});

test("an expired result can finish until a replacement lease supersedes it", async () => {
  const root = await repository();
  const started = await dispatchWorkflowTool("planning_start", { objective: "Plan a feature" }, { cwd: root });
  const first = await dispatchWorkflowTool("workflow_claim_next", { run_id: started.run_id }, { cwd: root });
  const runPath = join(root, ".git", "ai-work-flow", "v2", "runs", started.run_id, "run.json");
  const stored = JSON.parse(await readFile(runPath, "utf8"));
  stored.leases[first.dispatch.action_id].expires_at = "2000-01-01T00:00:00.000Z";
  await writeFile(runPath, JSON.stringify(stored, null, 2) + "\n");
  const replacement = await dispatchWorkflowTool("workflow_claim_next", { run_id: started.run_id }, { cwd: root });
  assert.notEqual(replacement.lease_id, first.lease_id);
  const superseded = await dispatchWorkflowTool(first.completion_tool, {
    lease_id: first.lease_id, result: "completed", summary: "late", entry_paths: [], direct_dependencies: [], facts: ["fact"], open_decisions: [],
  }, { cwd: root });
  assert.equal(superseded.status, "superseded");
});

test("completion rejects extra fields without advancing state", async () => {
  const root = await repository();
  const started = await dispatchWorkflowTool("coding_start_direct", { objective: "Fix it" }, { cwd: root });
  const claim = await dispatchWorkflowTool("workflow_claim_next", { run_id: started.run_id }, { cwd: root });
  await assert.rejects(dispatchWorkflowTool(claim.completion_tool, {
    lease_id: claim.lease_id, result: "completed", summary: "triaged", implementation_kind: "bug", objective: "Fix it",
    implementation_ids: ["id"], acceptance: ["works"], scope_evidence: ["small"], action_id: "coding.triage",
  }, { cwd: root }), /do not match/);
  assert.equal((await dispatchWorkflowTool("workflow_resume", { run_id: started.run_id }, { cwd: root })).phase, "direct_started");
});

test("prepare accepts only registered direct children of the managed worktree directory", async () => {
  const root = await repository();
  const fixture = await planFixture(root);
  const started = await dispatchWorkflowTool("coding_start_plan", { plan_path: fixture.directory }, { cwd: root });
  const prepare = await dispatchWorkflowTool("workflow_claim_next", { run_id: started.run_id }, { cwd: root });
  const complete = (worktree) => dispatchWorkflowTool(prepare.completion_tool, {
    lease_id: prepare.lease_id, result: "completed", summary: "prepared", worktree, branch: "feature/example",
    base_sha: "a".repeat(40), initial_status: { clean: true },
  }, { cwd: root });

  await assert.rejects(complete(root), /\.worktrees/);
  await assert.rejects(complete(join(root, "..", "sibling-worktree")), /\.worktrees/);
  await assert.rejects(complete(join(root, ".worktrees", "nested", "child")), /direct child/);
  const unregistered = join(root, ".worktrees", "unregistered");
  await mkdir(unregistered, { recursive: true });
  await assert.rejects(complete(unregistered), /registered, ignored worktree/);

  const worktree = await linkedWorktree(root, "managed");
  const completed = await complete(worktree);
  assert.equal(completed.phase, "prepared");
});

test("completion creates internal artifacts without exposing refs", async () => {
  const root = await repository();
  const worktree = await linkedWorktree(root, "implementation");
  const fixture = await planFixture(root);
  const started = await dispatchWorkflowTool("coding_start_plan", { plan_path: fixture.directory }, { cwd: root });
  const prepare = await dispatchWorkflowTool("workflow_claim_next", { run_id: started.run_id }, { cwd: root });
  await dispatchWorkflowTool(prepare.completion_tool, {
    lease_id: prepare.lease_id, result: "completed", summary: "prepared", worktree, branch: "feature/example",
    base_sha: "a".repeat(40), initial_status: { clean: true },
  }, { cwd: root });
  const implementation = await dispatchWorkflowTool("workflow_claim_next", { run_id: started.run_id }, { cwd: root });
  const evidence = {
    base_sha: "a".repeat(40), head_sha: "b".repeat(40),
    path_changes: [{ record_type: "1", index_status: "M", worktree_status: ".", path: "README.md" }],
    acceptance_evidence: [{ criterion: "Tests pass", evidence: "verified" }],
    verification: [{ command: "npm test", result: "passed" }],
  };
  const completed = await dispatchWorkflowTool(implementation.completion_tool, {
    lease_id: implementation.lease_id, result: "completed", summary: "implemented",
    head_sha: "b".repeat(40), changed_paths: ["README.md"], change_evidence: evidence,
  }, { cwd: root });
  assert.deepEqual(completed.receipt.fields.change_evidence, evidence);
  assert.equal(JSON.stringify(completed).includes("change_evidence_ref"), false);
  const artifactDirectory = join(root, ".git", "ai-work-flow", "v2", "runs", started.run_id, "artifacts");
  assert.equal((await readdir(artifactDirectory)).length, 1);
  const stored = JSON.parse(await readFile(join(root, ".git", "ai-work-flow", "v2", "runs", started.run_id, "run.json"), "utf8"));
  assert.equal(stored.receipts["coding.implement"].fields.change_evidence_ref.kind, "change_evidence");

  const commit = await dispatchWorkflowTool("workflow_claim_next", { run_id: started.run_id }, { cwd: root });
  assert.deepEqual(commit.dispatch.input.path_changes, evidence.path_changes);
  assert.deepEqual(commit.dispatch.input.checks, evidence.verification);
  assert.deepEqual(commit.dispatch.input.change_evidence, evidence);
  await dispatchWorkflowTool(commit.completion_tool, {
    lease_id: commit.lease_id, result: "completed", summary: "committed", commit_sha: "c".repeat(40),
    committed_paths: ["README.md"], clean_state: { clean: true },
  }, { cwd: root });

  const prepareReview = await dispatchWorkflowTool("workflow_claim_next", { run_id: started.run_id }, { cwd: root });
  assert.equal(prepareReview.dispatch.input.base_sha, "a".repeat(40));
  assert.equal(prepareReview.dispatch.input.review_sha, "c".repeat(40));
  assert.equal(prepareReview.dispatch.input.slices.length, 1);
  const packet = {
    base_sha: "a".repeat(40), review_sha: "c".repeat(40),
    review_context: prepareReview.dispatch.input.review_context, slices: prepareReview.dispatch.input.slices,
  };
  await dispatchWorkflowTool(prepareReview.completion_tool, {
    lease_id: prepareReview.lease_id, result: "completed", summary: "review prepared", review_packet: packet,
  }, { cwd: root });

  const review = await dispatchWorkflowTool("workflow_claim_next", { run_id: started.run_id }, { cwd: root });
  assert.deepEqual(review.dispatch.input.assigned_axes, ["standards", "spec"]);
  assert.deepEqual(review.dispatch.input.review_packet, packet);
  const reviewResult = {
    axis_results: [
      { axis: "standards", findings: [], advisory_findings: [], coverage: ["all"] },
      { axis: "spec", findings: [], advisory_findings: [], coverage: ["all"] },
    ],
    verdict: "passed", finding_ids: [], coverage: ["all"],
  };
  await dispatchWorkflowTool(review.completion_tool, {
    lease_id: review.lease_id, result: "completed", summary: "review passed", review_result: reviewResult,
    finding_ids: [], coverage: ["all"],
  }, { cwd: root });

  const integrate = await dispatchWorkflowTool("workflow_claim_next", { run_id: started.run_id }, { cwd: root });
  assert.deepEqual(integrate.dispatch.input, {
    main_sha: "a".repeat(40), feature_sha: "c".repeat(40), review_sha: "c".repeat(40), frozen_state: reviewResult,
  });
  await dispatchWorkflowTool(integrate.completion_tool, {
    lease_id: integrate.lease_id, result: "completed", summary: "integrated", resulting_sha: "c".repeat(40),
    state: { integrated: true }, cleanup_evidence: { performed: false },
  }, { cwd: root });

  const cleanup = await dispatchWorkflowTool("workflow_claim_next", { run_id: started.run_id }, { cwd: root });
  assert.deepEqual(cleanup.dispatch.input, {
    main_sha: "c".repeat(40), feature_sha: "c".repeat(40), review_sha: "c".repeat(40), frozen_state: reviewResult,
  });
});

test("review fixes are committed before rereview preparation", async () => {
  const contract = await loadWorkflowContract();
  assert.deepEqual(contract.workflows.coding.phase_actions.fixed_1, ["coding.commit_fix_1"]);
  assert.equal(contract.actions["coding.commit_fix_1"].completed_to, "fixed_committed_1");
  assert.deepEqual(contract.workflows.coding.phase_actions.fixed_committed_1, ["coding.prepare_rereview_1"]);
  assert.deepEqual(contract.workflows.coding.phase_actions.fixed_2, ["coding.commit_fix_2"]);
  assert.equal(contract.actions["coding.commit_fix_2"].completed_to, "fixed_committed_2");
  assert.deepEqual(contract.workflows.coding.phase_actions.fixed_committed_2, ["coding.prepare_rereview_2"]);
});

test("implementation infrastructure failures remain retryable", async () => {
  const root = await repository();
  const worktree = await linkedWorktree(root, "retryable");
  const fixture = await planFixture(root);
  const started = await dispatchWorkflowTool("coding_start_plan", { plan_path: fixture.directory }, { cwd: root });
  const prepare = await dispatchWorkflowTool("workflow_claim_next", { run_id: started.run_id }, { cwd: root });
  await dispatchWorkflowTool(prepare.completion_tool, {
    lease_id: prepare.lease_id, result: "completed", summary: "prepared", worktree, branch: "feature/retryable",
    base_sha: "a".repeat(40), initial_status: { clean: true },
  }, { cwd: root });
  const implementation = await dispatchWorkflowTool("workflow_claim_next", { run_id: started.run_id }, { cwd: root });
  const retried = await dispatchWorkflowTool(implementation.completion_tool, {
    lease_id: implementation.lease_id, result: "retryable_failure", summary: "browser unavailable",
    code: "BROWSER_UNAVAILABLE", message: "No browser backend is available",
  }, { cwd: root });
  assert.equal(retried.phase, "prepared");
  assert.equal(retried.status, "claimed");
  const next = await dispatchWorkflowTool("workflow_claim_next", { run_id: started.run_id }, { cwd: root });
  assert.equal(next.dispatch.action_id, "coding.implement");
  assert.notEqual(next.lease_id, implementation.lease_id);
});

test("a broker restart recovers a lock owned by a dead process", async () => {
  const root = await repository();
  const lock = join(root, ".git", "ai-work-flow", "v2", ".lock");
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: 99999999, token: "dead", created_at: "2000-01-01T00:00:00.000Z" }));
  const started = await dispatchWorkflowTool("planning_start", { objective: "Recover after restart" }, { cwd: root });
  assert.equal(started.status, "claimed");
});
