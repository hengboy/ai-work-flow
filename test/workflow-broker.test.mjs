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
  const tools = await workflowTools();
  const names = tools.map((tool) => tool.name);
  assert.deepEqual(names.slice(0, 7), [
    "coding_start_direct", "coding_start_plan", "planning_start", "planning_start_handoff",
    "workflow_resume", "workflow_claim_next", "workflow_answer",
  ]);
  assert.ok(names.includes("workflow_complete_direct_triage"));
  assert.equal(JSON.stringify(await workflowTools()).includes(["workflow", "state"].join("_")), false);
  assert.equal(JSON.stringify(await workflowTools()).includes("repository"), false);
  const confirmation = tools.find((tool) => tool.name === "workflow_complete_planning_confirmation");
  assert.deepEqual(confirmation.inputSchema.properties.planning_context.required, [
    "version", "plan_id", "task_mode", "goal", "users_consumers", "success_criteria", "scope", "constraints",
    "assumptions", "acceptance_criteria", "decisions", "open_questions",
  ]);
  assert.deepEqual(confirmation.inputSchema.properties.planning_context.properties.task_mode.enum, ["single", "split"]);
  assert.ok(confirmation.inputSchema.allOf.some((branch) => branch.if.properties.result.const === "completed" && branch.then.required.includes("planning_context")));
  const reviewPrepare = tools.find((tool) => tool.name === "workflow_complete_review_prepare");
  assert.deepEqual(reviewPrepare.inputSchema.properties.review_packet.required, ["base_sha", "review_sha", "review_context", "slices"]);
});

test("planning context mistakes are correctable and a valid context completes", async () => {
  const root = await repository();
  const started = await dispatchWorkflowTool("planning_start", { objective: "Plan a snake game" }, { cwd: root });
  const discovery = await dispatchWorkflowTool("workflow_claim_next", { run_id: started.run_id }, { cwd: root });
  await dispatchWorkflowTool(discovery.completion_tool, {
    lease_id: discovery.lease_id, result: "completed", summary: "empty repository",
    entry_paths: [], direct_dependencies: [], facts: ["repository has no application files"], open_decisions: [],
  }, { cwd: root });
  const confirmation = await dispatchWorkflowTool("workflow_claim_next", { run_id: started.run_id }, { cwd: root });
  const incomplete = await call(confirmation.completion_tool, {
    lease_id: confirmation.lease_id, result: "completed", summary: "confirmed", plan_id: "snake", task_mode: "single",
    planning_context: {},
  }, root);
  assert.equal(incomplete.result.isError, false);
  const correction = JSON.parse(incomplete.result.content[0].text);
  assert.equal(correction.status, "correction_required");
  assert.match(correction.message, /version, plan_id, task_mode, goal/);

  const planningContext = {
    version: 1, plan_id: "snake", task_mode: "single", goal: "Build a snake game", users_consumers: ["players"],
    success_criteria: ["game is playable"], scope: { included: ["browser game"] }, constraints: [], assumptions: [],
    acceptance_criteria: ["keyboard controls work"], decisions: [], open_questions: [],
  };
  const invalidMode = await call(confirmation.completion_tool, {
    lease_id: confirmation.lease_id, result: "completed", summary: "confirmed", plan_id: "snake", task_mode: "full",
    planning_context: { ...planningContext, task_mode: "full" },
  }, root);
  assert.equal(invalidMode.result.isError, false);
  assert.equal(JSON.parse(invalidMode.result.content[0].text).status, "correction_required");

  const completed = await dispatchWorkflowTool(confirmation.completion_tool, {
    lease_id: confirmation.lease_id, result: "completed", summary: "confirmed", plan_id: "snake", task_mode: "single",
    planning_context: planningContext,
  }, { cwd: root });
  assert.equal(completed.phase, "context_ready");
  assert.deepEqual(completed.receipt.fields.planning_context, planningContext);

  const spec = await dispatchWorkflowTool("workflow_claim_next", { run_id: started.run_id }, { cwd: root });
  await dispatchWorkflowTool(spec.completion_tool, {
    lease_id: spec.lease_id, result: "completed", summary: "spec written", target: ".ai-work-flow/plans/snake/spec.md",
    sha256: "a".repeat(64), changed_paths: [".ai-work-flow/plans/snake/spec.md"], mode: "single",
  }, { cwd: root });
  const plan = await dispatchWorkflowTool("workflow_claim_next", { run_id: started.run_id }, { cwd: root });
  const planned = await dispatchWorkflowTool(plan.completion_tool, {
    lease_id: plan.lease_id, result: "completed", summary: "plan written", target: ".ai-work-flow/plans/snake/plan.md",
    sha256: "b".repeat(64), changed_paths: [".ai-work-flow/plans/snake/plan.md"], mode: "single",
  }, { cwd: root });
  assert.equal(planned.phase, "tasks_ready");

  const runPath = join(root, ".git", "ai-work-flow", "v2", "runs", started.run_id, "run.json");
  const stored = JSON.parse(await readFile(runPath, "utf8"));
  delete stored.phase;
  await writeFile(runPath, `${JSON.stringify(stored, null, 2)}\n`);
  assert.equal((await dispatchWorkflowTool("workflow_resume", { run_id: started.run_id }, { cwd: root })).phase, "tasks_ready");
  const commit = await dispatchWorkflowTool("workflow_claim_next", { run_id: started.run_id }, { cwd: root });
  assert.equal(commit.dispatch.action_id, "planning.commit");
  assert.deepEqual(commit.dispatch.input.paths, [".ai-work-flow/plans/snake/spec.md", ".ai-work-flow/plans/snake/plan.md"]);
  assert.equal(commit.dispatch.input.task_mode, "single");
  assert.equal(commit.dispatch.input.checks.length, 2);
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

test("an explicit start retries the latest failed run with the same source", async () => {
  const root = await repository();
  const first = await dispatchWorkflowTool("coding_start_direct", { objective: "Fix it" }, { cwd: root });
  const claim = await dispatchWorkflowTool("workflow_claim_next", { run_id: first.run_id }, { cwd: root });
  await dispatchWorkflowTool(claim.completion_tool, {
    lease_id: claim.lease_id, result: "failed", summary: "failed", code: "TEST_FAILURE", message: "retry this run",
  }, { cwd: root });
  const retry = await dispatchWorkflowTool("coding_start_direct", { objective: "Fix it" }, { cwd: root });
  assert.notEqual(retry.run_id, first.run_id);
  const stored = JSON.parse(await readFile(join(root, ".git", "ai-work-flow", "v2", "runs", retry.run_id, "run.json"), "utf8"));
  assert.equal(stored.retry_of, first.run_id);
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
