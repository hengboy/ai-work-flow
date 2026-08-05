import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { dispatchWorkflowTool, handleBrokerRequest, workflowTools } from "../execution-runtime/lib/workflow-broker.mjs";

const run = promisify(execFile);

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "workflow-v2-broker-"));
  await run("git", ["init", "-b", "main"], { cwd: root });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await run("git", ["config", "user.name", "Test User"], { cwd: root });
  await writeFile(join(root, "README.md"), "baseline\n");
  await run("git", ["add", "README.md"], { cwd: root });
  await run("git", ["commit", "-m", "baseline"], { cwd: root });
  return root;
}

function call(name, args, cwd) {
  return handleBrokerRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { cwd });
}

test("broker exposes only narrow v2 tools", async () => {
  const names = (await workflowTools()).map((tool) => tool.name);
  assert.deepEqual(names.slice(0, 7), [
    "coding_start_direct", "coding_start_plan", "planning_start", "planning_start_handoff",
    "workflow_resume", "workflow_claim_next", "workflow_answer",
  ]);
  assert.ok(names.includes("workflow_complete_direct_triage"));
  assert.equal(JSON.stringify(await workflowTools()).includes(["workflow", "state"].join("_")), false);
  assert.equal(JSON.stringify(await workflowTools()).includes("repository"), false);
});

test("argument and state corrections are normal MCP results", async () => {
  const root = await repository();
  const missing = await call("coding_start_direct", {}, root);
  assert.equal(missing.result.isError, false);
  assert.equal(JSON.parse(missing.result.content[0].text).status, "correction_required");
  const extra = await call("coding_start_direct", { objective: "Fix it", repository: root }, root);
  assert.equal(extra.result.isError, false);
  assert.equal(JSON.parse(extra.result.content[0].text).status, "correction_required");
});

test("direct Coding start is idempotent and persists only below v2", async () => {
  const root = await repository();
  const first = await dispatchWorkflowTool("coding_start_direct", { objective: "Fix the reproducible save crash" }, { cwd: root });
  const again = await dispatchWorkflowTool("coding_start_direct", { objective: "Fix the reproducible save crash" }, { cwd: root });
  assert.equal(again.run_id, first.run_id);
  assert.equal(first.status, "claimed");
  const stored = JSON.parse(await readFile(join(root, ".git", "ai-work-flow", "v2", "runs", first.run_id, "run.json"), "utf8"));
  assert.equal(stored.source.type, "direct");
  await assert.rejects(readFile(join(root, ".git", "ai-work-flow", "runs", first.run_id, "run.json")), /ENOENT/);
});

test("claim derives action and completion tool and repeated completion is idempotent", async () => {
  const root = await repository();
  const started = await dispatchWorkflowTool("coding_start_direct", { objective: "Fix the reproducible save crash" }, { cwd: root });
  const claimed = await dispatchWorkflowTool("workflow_claim_next", { run_id: started.run_id }, { cwd: root });
  assert.equal(claimed.dispatch.action_id, "coding.triage");
  assert.equal(claimed.completion_tool, "workflow_complete_direct_triage");
  assert.equal(Object.hasOwn(claimed.dispatch, "attempt"), false);
  const payload = {
    lease_id: claimed.lease_id, result: "completed", summary: "reproducible bug",
    implementation_kind: "bug", objective: "Fix the reproducible save crash", implementation_ids: ["save"],
    acceptance: ["saving does not crash"], scope_evidence: ["one save path"],
  };
  const completed = await dispatchWorkflowTool(claimed.completion_tool, payload, { cwd: root });
  const repeated = await dispatchWorkflowTool(claimed.completion_tool, payload, { cwd: root });
  assert.equal(completed.receipt.receipt_id, repeated.receipt.receipt_id);
  assert.equal(completed.phase, "direct_bug_started");
  const wrong = await call("workflow_complete_implementation", { ...payload, lease_id: "lease_" + "0".repeat(32) }, root);
  assert.equal(JSON.parse(wrong.result.content[0].text).status, "correction_required");
});

test("resume auto-selects one unfinished run and lists multiple candidates", async () => {
  const root = await repository();
  const one = await dispatchWorkflowTool("coding_start_direct", { objective: "Fix one" }, { cwd: root });
  assert.equal((await dispatchWorkflowTool("workflow_resume", {}, { cwd: root })).run_id, one.run_id);
  await dispatchWorkflowTool("planning_start", { objective: "Plan two" }, { cwd: root });
  const selection = await dispatchWorkflowTool("workflow_resume", {}, { cwd: root });
  assert.equal(selection.status, "selection_required");
  assert.equal(selection.candidates.length, 2);
});

test("Planning handoff inherits the direct objective", async () => {
  const root = await repository();
  const started = await dispatchWorkflowTool("coding_start_direct", { objective: "Add a public authorization API" }, { cwd: root });
  const claimed = await dispatchWorkflowTool("workflow_claim_next", { run_id: started.run_id }, { cwd: root });
  const decision = await dispatchWorkflowTool(claimed.completion_tool, {
    lease_id: claimed.lease_id, result: "needs_decision", summary: "planning required",
    scope_evidence: ["public API"], open_decision: { code: "PLANNING_REQUIRED", reason: "public contract" },
  }, { cwd: root });
  assert.equal(decision.status, "decision_required");
  const handoff = await dispatchWorkflowTool("planning_start_handoff", { source_run_id: started.run_id }, { cwd: root });
  assert.equal(handoff.kind, "planning");
  assert.equal(handoff.phase, "started");
});
