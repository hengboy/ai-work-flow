import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { dispatchWorkflowTool } from "../execution-runtime/lib/workflow-broker.mjs";
import { parsePlanBundle, workflowLeaseMilliseconds } from "../execution-runtime/lib/workflow-v2-store.mjs";

const run = promisify(execFile);
const sha = (value) => createHash("sha256").update(value).digest("hex");

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "workflow-v2-runtime-"));
  await run("git", ["init", "-b", "main"], { cwd: root });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await run("git", ["config", "user.name", "Test User"], { cwd: root });
  await writeFile(join(root, "README.md"), "baseline\n");
  await run("git", ["add", "README.md"], { cwd: root });
  await run("git", ["commit", "-m", "baseline"], { cwd: root });
  return root;
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

test("completion creates internal artifacts without exposing refs", async () => {
  const root = await repository();
  const fixture = await planFixture(root);
  const started = await dispatchWorkflowTool("coding_start_plan", { plan_path: fixture.directory }, { cwd: root });
  const prepare = await dispatchWorkflowTool("workflow_claim_next", { run_id: started.run_id }, { cwd: root });
  await dispatchWorkflowTool(prepare.completion_tool, {
    lease_id: prepare.lease_id, result: "completed", summary: "prepared", worktree: root, branch: "main",
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
});

test("a broker restart recovers a lock owned by a dead process", async () => {
  const root = await repository();
  const lock = join(root, ".git", "ai-work-flow", "v2", ".lock");
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: 99999999, token: "dead", created_at: "2000-01-01T00:00:00.000Z" }));
  const started = await dispatchWorkflowTool("planning_start", { objective: "Recover after restart" }, { cwd: root });
  assert.equal(started.status, "claimed");
});
