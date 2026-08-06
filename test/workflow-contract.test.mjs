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
const smallChangeNotice = "本次变更符合低风险小改动快速通道，未执行 Standards/Spec 双轴审查；已完成聚焦自动化验证和 Git 状态校验。";
const criterionNames = [
  "direct_request_origin", "initial_review_stage", "full_review_not_requested", "modified_text_files_only", "changed_file_limit",
  "changed_line_limit", "no_sensitive_changes", "triage_scope_match", "automated_verification_passed",
];
const sensitiveAreaNames = [
  "public_api_contract", "data_schema", "permissions_security", "dependencies", "build_release", "cross_module_behavior", "persistence",
];

function reviewDisposition({
  origin = "direct_bug", stage = "initial", changedFileCount = 1, changedLineCount = 10, changeTypes = ["modified"],
  criterionStatuses = {}, areaStatuses = {}, mode,
} = {}) {
  const direct = ["direct_bug", "direct_small_feature"].includes(origin);
  const statuses = {
    direct_request_origin: direct ? "passed" : "failed",
    initial_review_stage: stage === "initial" ? "passed" : "failed",
    full_review_not_requested: "passed",
    modified_text_files_only: changeTypes.length === 1 && changeTypes[0] === "modified" ? "passed" : "failed",
    changed_file_limit: changedFileCount >= 1 && changedFileCount <= 2 ? "passed" : "failed",
    changed_line_limit: changedLineCount <= 50 ? "passed" : "failed",
    no_sensitive_changes: "passed",
    triage_scope_match: "passed",
    automated_verification_passed: "passed",
    ...criterionStatuses,
  };
  const sensitiveAreas = sensitiveAreaNames.map((area) => ({ area, status: areaStatuses[area] ?? "clear", evidence: `${area} checked` }));
  if (sensitiveAreas.some((area) => area.status === "present")) statuses.no_sensitive_changes = "failed";
  else if (sensitiveAreas.some((area) => area.status === "unknown")) statuses.no_sensitive_changes = "indeterminate";
  const eligible = direct && stage === "initial" && changedFileCount >= 1 && changedFileCount <= 2 && changedLineCount <= 50 &&
    changeTypes.length === 1 && changeTypes[0] === "modified" && Object.values(statuses).every((status) => status === "passed") &&
    sensitiveAreas.every((area) => area.status === "clear");
  const selectedMode = mode ?? (eligible ? "skipped_small_change" : "dual_axis");
  return {
    mode: selectedMode, origin, stage, changed_file_count: changedFileCount, changed_line_count: changedLineCount, change_types: changeTypes,
    sensitive_areas: sensitiveAreas,
    criteria: criterionNames.map((criterion) => ({ criterion, status: statuses[criterion], evidence: `${criterion} checked` })),
    user_notice: selectedMode === "skipped_small_change" ? smallChangeNotice : "Standards/Spec dual-axis review required.",
  };
}

function reviewBasis({
  origin = "direct_bug", stage = "initial", userRequestedFullReview = false, scopeMatchStatus = "passed",
  verification = [{ command: "node --test test/focused.test.mjs", result: "passed", focused: true }],
} = {}) {
  return {
    origin, stage, objective: "Fix the behavior", implementation_ids: ["REQ-1"], acceptance: ["Behavior is fixed"],
    scope_evidence: ["src/app.mjs is in scope"], user_requested_full_review: userRequestedFullReview,
    scope_match_status: scopeMatchStatus, verification,
  };
}

function reviewPacketFor(disposition, basis = reviewBasis({ origin: disposition.origin, stage: disposition.stage })) {
  return {
    base_sha: sha("a"), review_sha: sha("b"),
    review_context: {
      ...basis, changed_file_count: disposition.changed_file_count, changed_line_count: disposition.changed_line_count,
      change_types: disposition.change_types,
    },
    slices: [{ id: "slice-1", path: "src/app.mjs" }],
  };
}
const passedReviewResult = {
  axis_results: [
    { axis: "standards", findings: [], advisory_findings: [], coverage: ["slice-1"] },
    { axis: "spec", findings: [], advisory_findings: [], coverage: ["slice-1"] },
  ],
  verdict: "passed", finding_ids: [], coverage: ["slice-1"],
};
const blockingFinding = {
  id: "STD-1", summary: "Blocking issue", observable_impact: "Behavior is incorrect", slice_id: "slice-1",
  path: "src/app.mjs", hunk: "@@ -1 +1 @@", minimum_fix: "Correct the behavior",
};
const blockingReviewResult = {
  axis_results: [
    { axis: "standards", findings: [blockingFinding], advisory_findings: [], coverage: ["slice-1"] },
    { axis: "spec", findings: [], advisory_findings: [], coverage: ["slice-1"] },
  ],
  verdict: "blocking", finding_ids: ["STD-1"], coverage: ["slice-1"],
};

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
    context_id: "context-example",
    plan_id: "example",
    task_mode: "single",
    task_mode_selection: { selected: "single", confirmed_by: "user", user_response: "Use single mode" },
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
  assert.throws(() => validateStructuredContent("planning_context", {
    ...planningContext, task_mode_selection: { ...planningContext.task_mode_selection, selected: "split" },
  }, contract), /planning_context is invalid/);
  assert.throws(() => validateTaskResult("planning.confirm", {
    ...result, task_mode: "split",
  }, contract), /not bound to the user selection/);
  const { context_id, ...missingContextId } = planningContext;
  assert.throws(() => validateStructuredContent("planning_context", missingContextId, contract), /context_id/);
  assert.throws(() => validateTaskResult("planning.confirm", { ...result, planning_context_ref: {} }, contract), /unsupported field/);
  assert.throws(() => validateStructuredContent("planning_context", { version: 1, ...planningContext }, contract), /unsupported field/);
});

test("action inputs and change evidence use complete objects", async () => {
  const contract = await loadWorkflowContract();
  const planningWriteInput = {
    target: ".ai-work-flow/plans/example/plan.md",
    source_content: "# Approved spec",
    source_digest: "a".repeat(64),
    task_mode: "split",
  };
  assert.equal(validateActionInput("planning.write_plan", planningWriteInput, contract), planningWriteInput);
  assert.throws(() => validateActionInput("planning.write_plan", {
    ...planningWriteInput, task_mode: "invalid",
  }, contract), /Action input\.task_mode/);
  const { task_mode, ...legacyPlanningWriteInput } = planningWriteInput;
  assert.throws(() => validateActionInput("planning.write_plan", {
    ...legacyPlanningWriteInput, mode: "split",
  }, contract), /requires fields: task_mode/);
  const planningWriteResult = {
    result: "completed",
    summary: "Plan written",
    target: planningWriteInput.target,
    sha256: "b".repeat(64),
    changed_paths: [planningWriteInput.target],
    task_mode: "split",
  };
  assert.equal(validateTaskResult("planning.write_plan", planningWriteResult, contract), planningWriteResult);
  assert.throws(() => validateTaskResult("planning.write_plan", {
    ...planningWriteResult, task_mode: undefined, mode: "split",
  }, contract), /unsupported field|task_mode/);
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
  }, contract), /axis is required|review_axis_result/);
});

test("initial direct bug and small feature may skip dual-axis review", async () => {
  const contract = await loadWorkflowContract();
  for (const origin of ["direct_bug", "direct_small_feature"]) {
    const disposition = reviewDisposition({ origin });
    const reviewPacket = reviewPacketFor(disposition);
    const result = {
      result: "completed", summary: "Review prepared", review_packet: reviewPacket,
      review_mode: "skipped_small_change", review_disposition: disposition,
    };
    assert.equal(validateTaskResult("coding.prepare_review", result, contract), result);
  }
});

test("small-change review disposition fails closed", async (t) => {
  const contract = await loadWorkflowContract();
  const cases = [
    ["more than two files", { changedFileCount: 3 }],
    ["more than fifty changed lines", { changedLineCount: 51 }],
    ["added file", { changeTypes: ["added"] }],
    ["binary file", { changeTypes: ["binary"] }],
    ["sensitive area", { areaStatuses: { permissions_security: "present" } }],
    ["unknown sensitive area", { areaStatuses: { public_api_contract: "unknown" } }],
    ["scope drift", { criterionStatuses: { triage_scope_match: "failed" } }],
    ["missing focused verification", { criterionStatuses: { automated_verification_passed: "indeterminate" } }],
    ["failed verification", { criterionStatuses: { automated_verification_passed: "failed" } }],
    ["full review requested", { criterionStatuses: { full_review_not_requested: "failed" } }],
    ["approved plan", { origin: "approved_plan" }],
    ["finding fix", { origin: "finding_fix" }],
    ["rereview", { origin: "rereview", stage: "rereview" }],
    ["main resync", { origin: "resync", stage: "resync" }],
  ];
  for (const [name, options] of cases) await t.test(name, () => {
    const disposition = reviewDisposition(options);
    assert.equal(disposition.mode, "dual_axis");
    assert.equal(validateStructuredContent("review_disposition", disposition, contract), disposition);
    assert.throws(() => validateStructuredContent("review_disposition", {
      ...disposition, mode: "skipped_small_change", user_notice: smallChangeNotice,
    }, contract), /fail-closed criteria/);
  });
});

test("review preparation prevents mode mismatch and skips outside the initial action", async () => {
  const contract = await loadWorkflowContract();
  const disposition = reviewDisposition();
  const reviewPacket = reviewPacketFor(disposition);
  const result = {
    result: "completed", summary: "Review prepared", review_packet: reviewPacket,
    review_mode: "skipped_small_change", review_disposition: disposition,
  };
  assert.throws(() => validateTaskResult("coding.prepare_review", {
    ...result, review_mode: "dual_axis",
  }, contract), /must match/);
  assert.throws(() => validateTaskResult("coding.prepare_rereview_1", result, contract), /Only coding\.prepare_review/);
  for (const [action, disposition] of [
    ["coding.prepare_rereview_1", reviewDisposition({ origin: "rereview", stage: "rereview" })],
    ["coding.prepare_rereview_2", reviewDisposition({ origin: "rereview", stage: "rereview" })],
    ["coding.prepare_resync_review_1", reviewDisposition({ origin: "resync", stage: "resync" })],
    ["coding.prepare_resync_review_2", reviewDisposition({ origin: "resync", stage: "resync" })],
  ]) {
    const packet = reviewPacketFor(disposition);
    assert.equal(validateTaskResult(action, {
      result: "completed", summary: "Review prepared", review_packet: packet,
      review_mode: "dual_axis", review_disposition: disposition,
    }, contract).review_mode, "dual_axis");
  }
  const failedCriterion = reviewDisposition({ criterionStatuses: { triage_scope_match: "failed" }, mode: "skipped_small_change" });
  assert.throws(() => validateStructuredContent("review_disposition", failedCriterion, contract), /fail-closed criteria/);
});

test("review integration enforces mode-specific evidence", async () => {
  const contract = await loadWorkflowContract();
  const skipped = reviewDisposition();
  const dual = reviewDisposition({ origin: "approved_plan" });
  const skippedBase = {
    main_sha: sha("a"), feature_sha: sha("b"), review_sha: sha("b"), frozen_state: { clean: true },
    review_packet: reviewPacketFor(skipped), review_disposition: skipped,
  };
  const dualBase = {
    main_sha: sha("a"), feature_sha: sha("b"), review_sha: sha("b"), frozen_state: { clean: true },
    review_packet: reviewPacketFor(dual), review_disposition: dual,
  };
  assert.equal(validateActionInput("coding.integrate", skippedBase, contract).review_disposition, skipped);
  assert.throws(() => validateActionInput("coding.integrate", {
    ...skippedBase, review_result: passedReviewResult,
  }, contract), /must not include review_result/);
  assert.equal(validateActionInput("coding.integrate", {
    ...dualBase, review_result: passedReviewResult,
  }, contract).review_result, passedReviewResult);
  assert.throws(() => validateActionInput("coding.integrate", dualBase, contract), /requires a passed review_result/);
  assert.throws(() => validateActionInput("coding.integrate", {
    ...dualBase, review_result: blockingReviewResult,
  }, contract), /requires a passed review_result/);
  assert.throws(() => validateActionInput("coding.integrate", {
    ...skippedBase, feature_sha: sha("c"),
  }, contract), /SHA identity/);
});

test("review evidence binding rejects conflicting or incomplete handoffs", async () => {
  const contract = await loadWorkflowContract();
  const disposition = reviewDisposition();
  const basis = reviewBasis();
  const prepareInput = { base_sha: sha("a"), review_sha: sha("b"), review_basis: basis, slices: [{ id: "slice-1" }] };
  assert.equal(validateActionInput("coding.prepare_review", prepareInput, contract), prepareInput);
  assert.throws(() => validateActionInput("coding.prepare_review", {
    ...prepareInput, review_basis: { origin: "direct_bug" },
  }, contract), /review_basis/);
  const conflictingPacket = reviewPacketFor(disposition, reviewBasis({ origin: "approved_plan" }));
  assert.throws(() => validateTaskResult("coding.prepare_review", {
    result: "completed", summary: "Claimed safe", review_packet: conflictingPacket,
    review_mode: "skipped_small_change", review_disposition: disposition,
  }, contract), /not bound/);
  const noVerificationPacket = reviewPacketFor(disposition, reviewBasis({ verification: [] }));
  assert.throws(() => validateTaskResult("coding.prepare_review", {
    result: "completed", summary: "Claimed safe", review_packet: noVerificationPacket,
    review_mode: "skipped_small_change", review_disposition: disposition,
  }, contract), /not bound/);
  const fullReviewDisposition = reviewDisposition({ criterionStatuses: { full_review_not_requested: "failed" } });
  const fullReviewPacket = reviewPacketFor(fullReviewDisposition, reviewBasis({ userRequestedFullReview: true }));
  assert.equal(validateTaskResult("coding.prepare_review", {
    result: "completed", summary: "Full review required", review_packet: fullReviewPacket,
    review_mode: "dual_axis", review_disposition: fullReviewDisposition,
  }, contract).review_mode, "dual_axis");
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
