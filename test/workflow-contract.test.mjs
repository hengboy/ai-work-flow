import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  loadWorkflowContract,
  validateActionInput,
  validateSupportTaskResult,
  validateStructuredContent,
  validateTaskResult,
} from "../execution-runtime/lib/workflow-contract.mjs";

const sha = (character) => character.repeat(40);
const pathChange = { record_type: "1", index_status: "M", worktree_status: ".", path: "src/app.mjs" };

test("contract is generation-only and assigns valid action transitions", async () => {
  const contract = await loadWorkflowContract();
  assert.equal(Object.hasOwn(contract, "version"), false);
  assert.equal(Object.hasOwn(contract, "lease_minutes"), false);
  assert.equal(JSON.stringify(contract).includes("_ref"), false);
  assert.deepEqual(contract.task_result.results, ["completed", "retryable_failure", "needs_decision", "failed"]);
  assert.ok(Object.keys(contract.actions).length > 20);
  for (const [id, action] of Object.entries(contract.actions)) {
    assert.equal(contract.workflows[action.workflow].phase_actions[action.from].includes(id), true, id);
    assert.ok(action.owner, id);
    assert.ok(contract.io_contracts[action.io_contract], id);
  }
});

test("TaskResult carries direct structured content", async () => {
  const contract = await loadWorkflowContract();
  const planningContext = {
    plan_id: "example",
    task_mode: "single",
    goal: "Implement the example",
    users_consumers: ["users"],
    success_criteria: ["behavior works"],
    scope: { included: ["example"] },
    constraints: [],
    assumptions: [],
    acceptance_criteria: ["tests pass"],
    decisions: [],
    open_questions: [],
  };
  const result = {
    result: "completed",
    summary: "Planning facts confirmed",
    plan_id: "example",
    task_mode: "single",
    planning_context: planningContext,
  };
  assert.equal(validateTaskResult("planning.confirm", result, contract), result);
  assert.equal(validateStructuredContent("planning_context", planningContext, contract), planningContext);
  assert.throws(() => validateTaskResult("planning.confirm", { ...result, planning_context_ref: {} }, contract), /unsupported field/);
  assert.throws(() => validateStructuredContent("planning_context", { version: 1, ...planningContext }, contract), /unsupported field/);
});

test("action inputs and change evidence use complete objects", async () => {
  const contract = await loadWorkflowContract();
  const changeEvidence = {
    base_sha: sha("a"),
    head_sha: sha("b"),
    path_changes: [pathChange],
    acceptance_evidence: [{ criterion: "tests pass", evidence: "focused test passed" }],
    verification: [{ command: "npm test", result: "passed" }],
  };
  const input = { base_sha: sha("a"), path_changes: [pathChange], checks: changeEvidence.verification, change_evidence: changeEvidence };
  assert.equal(validateActionInput("coding.commit", input, contract), input);
  assert.equal(validateTaskResult("coding.implement", {
    result: "completed", summary: "Implemented", head_sha: sha("b"), changed_paths: ["src/app.mjs"], change_evidence: changeEvidence,
  }, contract).change_evidence, changeEvidence);
  assert.throws(() => validateTaskResult("coding.implement", {
    result: "completed", summary: "Implemented", head_sha: sha("b"), changed_paths: "src/app.mjs", change_evidence: changeEvidence,
  }, contract), /TaskResult\.changed_paths must be array/);
  assert.throws(() => validateTaskResult("coding.implement", {
    result: "completed", summary: "Implemented", head_sha: sha("b"), changed_paths: ["src/app.mjs"],
    change_evidence: { ...changeEvidence, verification: [{ command: "npm test", result: 1 }] },
  }, contract), /TaskResult\.change_evidence\.verification\[0\]\.result must be string/);
});

test("support TaskResult fields use the same typed schemas", async () => {
  const contract = await loadWorkflowContract();
  const result = {
    result: "completed", summary: "Research complete", report_path: "docs/report.md",
    citation_urls: ["https://example.test/source"], changed_paths: ["docs/report.md"], checks: ["citations verified"],
  };
  assert.equal(validateSupportTaskResult("researcher", result, contract), result);
  assert.throws(() => validateSupportTaskResult("researcher", { ...result, checks: "citations verified" }, contract), /TaskResult\.checks must be array/);
});

test("review result contains two raw review axes", async () => {
  const contract = await loadWorkflowContract();
  const standards = { axis: "standards", findings: [], advisory_findings: [], coverage: ["slice-1"] };
  const spec = { axis: "spec", findings: [], advisory_findings: [], coverage: ["slice-1"] };
  const reviewResult = { axis_results: [standards, spec], verdict: "passed", finding_ids: [], coverage: ["slice-1"] };
  assert.equal(validateStructuredContent("review_result", reviewResult, contract), reviewResult);
  assert.throws(() => validateStructuredContent("review_result", {
    ...reviewResult,
    axis_results: [{ result: "completed", summary: "ok", review_axis_result: standards }, spec],
  }, contract), /review_axis_result/);
});

test("execution-runtime contains only the contract, typed schemas, and validator", async () => {
  const root = resolve(import.meta.dirname, "..", "execution-runtime");
  const entries = [];
  async function visit(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(resolve(directory, entry.name), relative);
      else entries.push(relative);
    }
  }
  await visit(root);
  assert.deepEqual(entries.sort(), ["lib/workflow-contract.mjs", "task-result-schemas.json", "workflow-contract.json"]);
});
