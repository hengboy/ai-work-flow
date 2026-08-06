import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const sha256 = (content) => createHash("sha256").update(content).digest("hex");
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
function reviewPrepareInputFor(packet) {
  const { changed_file_count, changed_line_count, change_types, ...reviewBasisInput } = packet.review_context;
  return { base_sha: packet.base_sha, review_sha: packet.review_sha, review_basis: reviewBasisInput, slices: packet.slices };
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
  for (const io of Object.values(contract.io_contracts)) for (const resultContract of Object.values(io.result_contracts)) {
    assert.deepEqual(resultContract.required_fields.filter((field) => resultContract.required_error_fields?.includes(field)), []);
  }
  assert.deepEqual(contract.actions["coding.resync_1"].completed_to_by_task_mode, {
    single: "revalidated_1", split: "resynced_1",
  });
  assert.deepEqual(contract.actions["coding.resync_2"].completed_to_by_task_mode, {
    single: "revalidated_2", split: "resynced_2",
  });
  assert.equal(contract.actions["planning.write_spec"].from, "context_ready");
  assert.equal(contract.actions["planning.write_spec"].completed_to, "spec_ready");
  assert.equal(contract.actions["planning.select_task_mode"].from, "spec_ready");
  assert.equal(contract.actions["planning.write_plan"].from, "mode_ready");
  assert.deepEqual(contract.actions["planning.write_plan"].completed_to_by_task_mode, {
    single: "tasks_ready", split: "plan_ready",
  });
  assert.equal(contract.actions["planning.preview_tasks"].completed_to, "task_preview_ready");
  assert.equal(contract.actions["planning.revise_task_preview"].completed_to, "task_preview_ready");
  assert.equal(contract.actions["planning.confirm_task_preview"].completed_to, "task_split_confirmed");
  assert.equal(contract.actions["planning.sync_plan_tasks"].owner, "planning-writer");
  assert.equal(contract.actions["planning.sync_plan_tasks"].from, "task_split_confirmed");
  assert.equal(contract.actions["planning.sync_plan_tasks"].completed_to, "plan_tasks_synced");
  assert.equal(contract.actions["planning.write_tasks"].owner, "task-planner");
  assert.equal(contract.actions["planning.write_tasks"].from, "plan_tasks_synced");
  assert.equal(contract.actions["planning.write_tasks"].completed_to, "tasks_written");
  assert.equal(contract.actions["planning.verify_tasks"].owner, "git-operator");
  assert.equal(contract.actions["planning.verify_tasks"].from, "tasks_written");
  assert.equal(contract.actions["planning.verify_tasks"].completed_to, "tasks_ready");
});

test("TaskResult carries direct structured content", async () => {
  const contract = await loadWorkflowContract();
  const planningContext = {
    context_id: "context-example",
    plan_id: "example",
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
    planning_context: planningContext,
  };
  assert.equal(validateTaskResult("planning.confirm", result, contract), result);
  assert.equal(validateStructuredContent("planning_context", planningContext, contract), planningContext);
  assert.throws(() => validateStructuredContent("planning_context", { ...planningContext, task_mode: "single" }, contract), /unsupported field/);
  const modeResult = {
    result: "completed", summary: "Task mode selected", plan_id: "example", task_mode: "single",
    task_mode_selection: { selected: "single", confirmed_by: "user", user_response: "Use single mode" },
  };
  const modeInput = { plan_id: "example", target: ".ai-work-flow/plans/example/spec.md", source_digest: "a".repeat(64), decision_history: [] };
  assert.equal(validateTaskResult("planning.select_task_mode", modeResult, contract, modeInput), modeResult);
  assert.throws(() => validateTaskResult("planning.select_task_mode", {
    ...modeResult, task_mode: "split",
  }, contract, modeInput), /not bound to the user selection/);
  assert.throws(() => validateTaskResult("planning.select_task_mode", {
    ...modeResult, plan_id: "other",
  }, contract, modeInput), /spec plan_id/);
  assert.throws(() => validateActionInput("planning.select_task_mode", {
    ...modeInput, source_digest: "not-a-digest",
  }, contract), /source_digest/);
  const { context_id, ...missingContextId } = planningContext;
  assert.throws(() => validateStructuredContent("planning_context", missingContextId, contract), /context_id/);
  assert.throws(() => validateTaskResult("planning.confirm", { ...result, planning_context_ref: {} }, contract), /unsupported field/);
  assert.throws(() => validateStructuredContent("planning_context", { version: 1, ...planningContext }, contract), /unsupported field/);
});

test("action inputs and change evidence use complete objects", async () => {
  const contract = await loadWorkflowContract();
  const planningSpecInput = {
    plan_id: "example",
    target: ".ai-work-flow/plans/example/spec.md",
    source_content: "{\"goal\":\"Example\"}",
    source_digest: "f".repeat(64),
  };
  assert.equal(validateActionInput("planning.write_spec", planningSpecInput, contract), planningSpecInput);
  const planningSpecResult = {
    result: "completed", summary: "Spec written", target: planningSpecInput.target, sha256: "e".repeat(64),
    changed_paths: [planningSpecInput.target],
  };
  assert.equal(validateTaskResult("planning.write_spec", planningSpecResult, contract, planningSpecInput), planningSpecResult);
  assert.throws(() => validateTaskResult("planning.write_spec", {
    ...planningSpecResult, target: ".ai-work-flow/plans/other/spec.md",
  }, contract, planningSpecInput), /bound to its target/);
  assert.throws(() => validateActionInput("planning.write_spec", { ...planningSpecInput, task_mode: "split" }, contract), /unsupported field/);
  const planningWriteInput = {
    plan_id: "example",
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
  assert.equal(validateTaskResult("planning.write_plan", planningWriteResult, contract, planningWriteInput), planningWriteResult);
  assert.throws(() => validateTaskResult("planning.write_plan", {
    ...planningWriteResult, task_mode: "single",
  }, contract, planningWriteInput), /target and task_mode/);
  assert.throws(() => validateTaskResult("planning.write_plan", {
    ...planningWriteResult, task_mode: undefined, mode: "split",
  }, contract, planningWriteInput), /unsupported field|task_mode/);
  const initialPlanContent = "# Ready plan";
  const previewInput = {
    plan_id: "example", source_content: initialPlanContent, source_digest: sha256(initialPlanContent), task_mode: "split",
  };
  const taskPreview = {
    plan_id: "example", plan_digest: previewInput.source_digest, revision: 1,
    tasks: [
      { task_id: "api", order: 1, title: "API", summary: "Implement the API" },
      { task_id: "ui", order: 2, title: "UI", summary: "Implement the UI" },
    ],
  };
  const previewResult = { result: "completed", summary: "Task split previewed", task_preview: taskPreview };
  assert.equal(validateTaskResult("planning.preview_tasks", previewResult, contract, previewInput), previewResult);
  assert.throws(() => validateStructuredContent("task_preview", {
    ...taskPreview, tasks: [taskPreview.tasks[0], { ...taskPreview.tasks[1], task_id: "api" }],
  }, contract), /unique/);
  assert.throws(() => validateStructuredContent("task_preview", {
    ...taskPreview, tasks: [{ ...taskPreview.tasks[0], order: 100 }],
  }, contract), /maximum/);
  const reviseInput = { ...previewInput, task_preview: taskPreview, revision_feedback: "Merge the tasks" };
  const revisedPreview = {
    ...taskPreview, revision: 2, tasks: [{ task_id: "app", order: 1, title: "App", summary: "Implement the complete app" }],
  };
  assert.equal(validateTaskResult("planning.revise_task_preview", {
    result: "completed", summary: "Task split revised", task_preview: revisedPreview,
  }, contract, reviseInput).task_preview, revisedPreview);
  assert.throws(() => validateTaskResult("planning.revise_task_preview", previewResult, contract, reviseInput), /increment/);
  const confirmation = { confirmed_by: "user", user_response: "This split is reasonable", preview_revision: 2 };
  const confirmationInput = { task_preview: revisedPreview, decision_history: [] };
  assert.equal(validateTaskResult("planning.confirm_task_preview", {
    result: "completed", summary: "Task split confirmed", task_preview: revisedPreview, task_preview_confirmation: confirmation,
  }, contract, confirmationInput).task_preview_confirmation, confirmation);
  assert.throws(() => validateTaskResult("planning.confirm_task_preview", {
    result: "completed", summary: "Task split confirmed", task_preview: { ...revisedPreview, plan_id: "other" },
    task_preview_confirmation: confirmation,
  }, contract, confirmationInput), /unchanged input preview/);
  const syncedPlanContent = "# Ready plan\n\n## Tasks\n\n1. `app` - App: Implement the complete app\n";
  const syncedPlanDigest = sha256(syncedPlanContent);
  const syncInput = {
    plan_id: "example", target: ".ai-work-flow/plans/example/plan.md", source_content: initialPlanContent,
    source_digest: previewInput.source_digest, task_mode: "split", task_preview: revisedPreview,
    task_preview_confirmation: confirmation,
  };
  assert.equal(validateActionInput("planning.sync_plan_tasks", syncInput, contract), syncInput);
  const reboundPreview = { ...revisedPreview, plan_digest: syncedPlanDigest };
  const syncResult = {
    result: "completed", summary: "Plan task boundary synchronized", target: syncInput.target,
    source_content: syncedPlanContent, sha256: syncedPlanDigest, changed_paths: [syncInput.target],
    task_mode: "split", task_preview: reboundPreview,
  };
  assert.equal(validateTaskResult("planning.sync_plan_tasks", syncResult, contract, syncInput), syncResult);
  assert.throws(() => validateTaskResult("planning.sync_plan_tasks", {
    ...syncResult, task_preview: { ...reboundPreview, tasks: [{ ...reboundPreview.tasks[0], title: "Changed" }] },
  }, contract, syncInput), /unchanged confirmed preview/);
  const taskWriteInput = {
    target: ".ai-work-flow/plans/example/tasks", source_content: syncResult.source_content, source_digest: syncResult.sha256,
    task_mode: "split", task_preview: reboundPreview, task_preview_confirmation: confirmation,
  };
  assert.equal(validateActionInput("planning.write_tasks", taskWriteInput, contract), taskWriteInput);
  const taskPath = ".ai-work-flow/plans/example/tasks/01-app.md";
  const manifest = {
    plan_id: "example", plan_digest: taskWriteInput.source_digest, preview_revision: 2,
    files: [{
      path: taskPath, sha256: "9".repeat(64), task_id: "app", order: 1,
      title: "App", summary: "Implement the complete app",
    }],
  };
  const taskWriteResult = {
    result: "completed", summary: "Tasks written", target: taskWriteInput.target, sha256: "d".repeat(64),
    changed_paths: [taskPath], task_mode: "split", task_artifact_manifest: manifest,
  };
  assert.equal(validateTaskResult("planning.write_tasks", taskWriteResult, contract, taskWriteInput).task_mode, "split");
  assert.throws(() => validateTaskResult("planning.write_tasks", {
    ...taskWriteResult, changed_paths: [".ai-work-flow/plans/example/tasks/01-unrelated.md", ".ai-work-flow/plans/example/tasks/02-extra.md"],
  }, contract, taskWriteInput), /confirmed preview and target/);
  assert.throws(() => validateTaskResult("planning.write_tasks", {
    ...taskWriteResult, task_artifact_manifest: {
      ...manifest, files: [{ ...manifest.files[0], title: "Different title" }],
    },
  }, contract, taskWriteInput), /confirmed preview and target/);
  assert.throws(() => validateActionInput("planning.write_tasks", {
    target: ".ai-work-flow/plans/example/tasks", source_content: syncResult.source_content, source_digest: syncResult.sha256,
    task_mode: "split", task_preview: reboundPreview, task_preview_confirmation: { ...confirmation, preview_revision: 1 },
  }, contract), /current task preview/);
  const verifyInput = {
    target: taskWriteInput.target, source_digest: taskWriteInput.source_digest, changed_paths: taskWriteResult.changed_paths,
    task_preview: reboundPreview, task_preview_confirmation: confirmation, task_artifact_manifest: manifest,
  };
  const verifyResult = {
    result: "completed", summary: "Task files verified", changed_paths: taskWriteResult.changed_paths,
    task_artifact_manifest: manifest, checks: ["All task files match preview revision 2"],
  };
  assert.equal(validateTaskResult("planning.verify_tasks", verifyResult, contract, verifyInput), verifyResult);
  assert.throws(() => validateTaskResult("planning.verify_tasks", {
    ...verifyResult, task_artifact_manifest: {
      ...manifest, files: [{ ...manifest.files[0], title: "Different title" }],
    },
  }, contract, verifyInput), /unchanged independently verified writer manifest/);
  const changeEvidence = {
    base_sha: sha("a"),
    head_sha: sha("b"),
    path_changes: [pathChange],
    acceptance_evidence: [{ criterion: "tests pass", evidence: "focused test passed" }],
    verification: [{ command: "npm test", result: "passed" }],
  };
  const input = { base_sha: sha("a"), path_changes: [pathChange], checks: changeEvidence.verification, change_evidence: changeEvidence };
  assert.equal(validateActionInput("coding.commit", input, contract), input);
  const implementationInput = {
    worktree: "/tmp/worktree", base_sha: sha("a"), spec_or_task_ids: ["REQ-1"], acceptance: ["tests pass"],
  };
  assert.equal(validateTaskResult("coding.implement", {
    result: "completed", summary: "Implemented", head_sha: sha("b"), changed_paths: ["src/app.mjs"], change_evidence: changeEvidence,
  }, contract, implementationInput).change_evidence, changeEvidence);
  assert.throws(() => validateTaskResult("coding.implement", {
    result: "completed", summary: "Implemented", head_sha: sha("c"), changed_paths: ["src/app.mjs"], change_evidence: changeEvidence,
  }, contract, implementationInput), /not bound to implementation input and evidence/);
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
  const disposition = reviewDisposition({ origin: "approved_plan" });
  const reviewInput = { review_packet: reviewPacketFor(disposition), assigned_axes: ["standards", "spec"] };
  const taskResult = {
    result: "completed", summary: "Review passed", review_result: passedReviewResult,
    finding_ids: passedReviewResult.finding_ids, coverage: passedReviewResult.coverage,
  };
  assert.equal(validateTaskResult("coding.review", taskResult, contract, reviewInput), taskResult);
  assert.throws(() => validateTaskResult("coding.review", {
    ...taskResult, coverage: ["other-slice"],
  }, contract, reviewInput), /assigned review axes and slices/);
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
    assert.equal(validateTaskResult("coding.prepare_review", result, contract, reviewPrepareInputFor(reviewPacket)), result);
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
  }, contract, reviewPrepareInputFor(reviewPacket)), /must match/);
  assert.throws(() => validateTaskResult("coding.prepare_rereview_1", result, contract, reviewPrepareInputFor(reviewPacket)), /Only coding\.prepare_review/);
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
    }, contract, reviewPrepareInputFor(packet)).review_mode, "dual_axis");
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
  }, contract, prepareInput), /not bound/);
  const noVerificationPacket = reviewPacketFor(disposition, reviewBasis({ verification: [] }));
  assert.throws(() => validateTaskResult("coding.prepare_review", {
    result: "completed", summary: "Claimed safe", review_packet: noVerificationPacket,
    review_mode: "skipped_small_change", review_disposition: disposition,
  }, contract, prepareInput), /not bound/);
  const fullReviewDisposition = reviewDisposition({ criterionStatuses: { full_review_not_requested: "failed" } });
  const fullReviewPacket = reviewPacketFor(fullReviewDisposition, reviewBasis({ userRequestedFullReview: true }));
  assert.equal(validateTaskResult("coding.prepare_review", {
    result: "completed", summary: "Full review required", review_packet: fullReviewPacket,
    review_mode: "dual_axis", review_disposition: fullReviewDisposition,
  }, contract, reviewPrepareInputFor(fullReviewPacket)).review_mode, "dual_axis");
});

test("split preparation creates one plan integration workflow and safe task workflows", async () => {
  const contract = await loadWorkflowContract();
  const planned = { plan_id: "Legacy_Plan.Name", plan_digest: "legacy-digest", task_mode: "single", target_base: "main" };
  assert.equal(validateActionInput("coding.prepare", planned, contract), planned);
  assert.throws(() => validateActionInput("coding.prepare", {
    plan_digest: "d".repeat(64), task_mode: "single", target_base: "main",
  }, contract), /plan_id/);
  assert.throws(() => validateActionInput("coding.prepare", { ...planned, task_id: "task-01" }, contract), /unsupported field|does not accept task_id/);

  const split = { ...planned, plan_id: "worktree-plan-name", plan_digest: "d".repeat(64), task_mode: "split" };
  assert.equal(validateActionInput("coding.prepare", split, contract), split);
  assert.throws(() => validateActionInput("coding.prepare", { ...split, task_id: "task-01" }, contract), /unsupported field|does not accept task_id/);
  assert.throws(() => validateActionInput("coding.prepare", { ...split, plan_digest: "legacy-digest" }, contract), /SHA-256 plan_digest/);
  assert.throws(() => validateActionInput("coding.prepare", { ...split, plan_id: "Legacy_Plan.Name" }, contract), /lowercase kebab-case plan_id/);

  const task = {
    plan_id: split.plan_id, plan_digest: split.plan_digest, task_id: "task-01", task_digest: "e".repeat(64),
    plan_sha: sha("a"), acceptance: ["focused behavior works"], write_scope: ["src/feature/"],
  };
  assert.equal(validateActionInput("coding.prepare_task", task, contract), task);
  for (const taskId of ["../../outside", "task/01", ".lock", "Task-01", "task_01"]) {
    assert.throws(() => validateActionInput("coding.prepare_task", { ...task, task_id: taskId }, contract), /task_id|lowercase kebab-case/);
  }
  assert.throws(() => validateActionInput("coding.prepare_task", { ...task, task_digest: "stale" }, contract), /task_digest/);
  const prepared = {
    result: "completed", summary: "Task prepared", plan_id: task.plan_id, task_id: task.task_id,
    worktree: "/tmp/task", branch: `ai-work-flow/${task.plan_id}/tasks/${task.task_id}`,
    base_sha: task.plan_sha, initial_status: { clean: true },
  };
  assert.equal(validateTaskResult("coding.prepare_task", prepared, contract, task), prepared);
  assert.throws(() => validateTaskResult("coding.prepare_task", { ...prepared, base_sha: sha("b") }, contract, task), /latest plan SHA/);

  const direct = { plan_digest: "legacy-digest", task_mode: "single", target_base: "main" };
  assert.equal(validateActionInput("coding.prepare_direct_bug", direct, contract), direct);
  assert.throws(() => validateActionInput("coding.prepare_direct_bug", { ...direct, plan_id: "not-applicable" }, contract), /unsupported field|does not accept plan_id/);
  assert.throws(() => validateActionInput("coding.prepare_direct_bug", { ...direct, task_id: "not-applicable" }, contract), /unsupported field|does not accept plan_id or task_id/);
});

test("split task implementation binds exhaustive scope and rejects path escapes", async () => {
  const contract = await loadWorkflowContract();
  const input = {
    worktree: "/tmp/worktree",
    base_sha: sha("a"),
    task_id: "task-01",
    acceptance: ["focused behavior works"],
    write_scope: ["src/feature/", "test/feature.test.mjs"],
  };
  assert.equal(validateActionInput("coding.implement_task", input, contract), input);
  for (const writeScope of [["../outside/"], ["/absolute/"], ["src/**"], ["src\\feature\\"]]) {
    assert.throws(() => validateActionInput("coding.implement_task", { ...input, write_scope: writeScope }, contract), /unsafe repository-relative path/);
  }

  const changeEvidence = {
    base_sha: sha("a"),
    head_sha: sha("b"),
    path_changes: [{ ...pathChange, path: "src/feature/app.mjs" }],
    acceptance_evidence: [{ criterion: "focused behavior works", evidence: "focused test passed" }],
    verification: [{ command: "node --test test/feature.test.mjs", result: "passed" }],
  };
  const result = {
    result: "completed",
    summary: "Task implemented",
    task_id: "task-01",
    head_sha: sha("b"),
    changed_paths: ["src/feature/app.mjs"],
    change_evidence: changeEvidence,
    write_scope: input.write_scope,
  };
  assert.throws(() => validateTaskResult("coding.implement_task", result, contract), /requires action input/);
  assert.equal(validateTaskResult("coding.implement_task", result, contract, input), result);
  assert.throws(() => validateTaskResult("coding.implement_task", {
    ...result,
    changed_paths: ["src/shared.mjs"],
    change_evidence: { ...changeEvidence, path_changes: [{ ...pathChange, path: "src/shared.mjs" }] },
  }, contract, input), /changed paths must stay within write_scope/);
  assert.throws(() => validateTaskResult("coding.implement_task", {
    ...result, write_scope: ["src/"],
  }, contract, input), /not bound to task identity, scope, and implementation evidence/);
  assert.throws(() => validateActionInput("coding.implement_task", { ...input, task_id: "Task_01" }, contract), /lowercase kebab-case/);
});

test("task commit, no-ff integration, and cleanup bind every task SHA", async () => {
  const contract = await loadWorkflowContract();
  const changeEvidence = {
    base_sha: sha("a"), head_sha: sha("b"),
    path_changes: [{ ...pathChange, path: "src/feature/app.mjs" }],
    acceptance_evidence: [{ criterion: "focused behavior works", evidence: "focused test passed" }],
    verification: [{ command: "node --test test/feature.test.mjs", result: "passed" }],
  };
  const commitInput = {
    plan_id: "example-plan", task_id: "task-01", task_digest: "c".repeat(64), base_sha: sha("a"),
    path_changes: changeEvidence.path_changes, checks: changeEvidence.verification, change_evidence: changeEvidence,
    write_scope: ["src/feature/"],
  };
  assert.equal(validateActionInput("coding.commit_task", commitInput, contract), commitInput);
  const committed = {
    result: "completed", summary: "Task committed", plan_id: commitInput.plan_id, task_id: commitInput.task_id,
    base_sha: commitInput.base_sha, task_sha: sha("b"), changed_paths: ["src/feature/app.mjs"],
    verification: changeEvidence.verification, clean_state: { clean: true },
  };
  assert.equal(validateTaskResult("coding.commit_task", committed, contract, commitInput), committed);
  assert.throws(() => validateTaskResult("coding.commit_task", { ...committed, task_sha: sha("c") }, contract, commitInput), /not bound/);

  const integrateInput = {
    plan_id: commitInput.plan_id, task_id: commitInput.task_id,
    task_path: ".ai-work-flow/plans/example-plan/tasks/01-task-01.md", task_digest: "c".repeat(64),
    plan_sha: sha("a"), task_sha: committed.task_sha,
    plan_worktree: "/tmp/plan", plan_branch: "ai-work-flow/example-plan/integration",
    task_worktree: "/tmp/task", task_branch: "ai-work-flow/example-plan/tasks/task-01",
  };
  const integrated = {
    result: "completed", summary: "Task integrated", plan_id: integrateInput.plan_id, task_id: integrateInput.task_id,
    task_path: integrateInput.task_path, base_plan_sha: integrateInput.plan_sha, source_task_sha: integrateInput.task_sha,
    merge_sha: sha("d"), task_completion_sha: sha("e"), resulting_plan_sha: sha("e"),
    task_checkboxes_checked: true, clean_state: { clean: true },
  };
  assert.equal(validateTaskResult("coding.integrate_task", integrated, contract, integrateInput), integrated);
  assert.throws(() => validateTaskResult("coding.integrate_task", {
    ...integrated, task_completion_sha: integrated.merge_sha, resulting_plan_sha: integrated.merge_sha,
  }, contract, integrateInput), /checked task completion/);
  assert.throws(() => validateTaskResult("coding.integrate_task", {
    ...integrated, task_checkboxes_checked: false,
  }, contract, integrateInput), /checked task completion/);
  assert.throws(() => validateActionInput("coding.integrate_task", {
    ...integrateInput, task_path: ".ai-work-flow/plans/other-plan/tasks/01-task-01.md",
  }, contract), /branch\/worktree identity/);
  const conflict = {
    result: "needs_decision", summary: "Merge conflicted", conflict_paths: ["src/feature/app.mjs"],
    merge_aborted: true, clean_state: { clean: true },
  };
  assert.equal(validateTaskResult("coding.integrate_task", conflict, contract, integrateInput), conflict);
  assert.throws(() => validateTaskResult("coding.integrate_task", { ...conflict, merge_aborted: false }, contract, integrateInput), /prove merge abort/);
  assert.throws(() => validateTaskResult("coding.integrate_task", { ...conflict, clean_state: { clean: false } }, contract, integrateInput), /clean plan worktree/);

  const cleanupInput = {
    plan_id: integrateInput.plan_id, task_id: integrateInput.task_id, task_sha: integrateInput.task_sha,
    resulting_plan_sha: integrated.resulting_plan_sha, task_worktree: integrateInput.task_worktree, task_branch: integrateInput.task_branch,
  };
  const cleaned = {
    result: "completed", summary: "Task cleaned", plan_id: cleanupInput.plan_id, task_id: cleanupInput.task_id,
    task_sha: cleanupInput.task_sha, resulting_plan_sha: cleanupInput.resulting_plan_sha,
    cleanup_evidence: { task_ancestor_verified: true, worktree_removed: true, branch_removed: true },
  };
  assert.equal(validateTaskResult("coding.cleanup_task", cleaned, contract, cleanupInput), cleaned);
  assert.throws(() => validateTaskResult("coding.cleanup_task", {
    ...cleaned, cleanup_evidence: { ...cleaned.cleanup_evidence, task_ancestor_verified: false },
  }, contract, cleanupInput), /ancestry/);
  assert.throws(() => validateTaskResult("coding.cleanup_task", {
    ...cleaned, cleanup_evidence: { ...cleaned.cleanup_evidence, worktree_removed: false },
  }, contract, cleanupInput), /removal proof/);
  assert.throws(() => validateTaskResult("coding.cleanup_task", {
    ...cleaned, cleanup_evidence: { ...cleaned.cleanup_evidence, branch_removed: false },
  }, contract, cleanupInput), /removal proof/);
});

test("plan validation requires the complete integration set and full review slices", async () => {
  const contract = await loadWorkflowContract();
  const expectedTaskIds = ["task-01", "task-02"];
  const taskIntegrations = [
    {
      task_id: "task-01", task_path: ".ai-work-flow/plans/example-plan/tasks/01-task-01.md",
      base_plan_sha: sha("a"), source_task_sha: sha("b"), merge_sha: sha("c"),
      task_completion_sha: sha("d"), resulting_plan_sha: sha("d"), task_checkboxes_checked: true,
    },
    {
      task_id: "task-02", task_path: ".ai-work-flow/plans/example-plan/tasks/02-task-02.md",
      base_plan_sha: sha("d"), source_task_sha: sha("e"), merge_sha: sha("f"),
      task_completion_sha: sha("1"), resulting_plan_sha: sha("1"), task_checkboxes_checked: true,
    },
  ];
  const taskCleanups = taskIntegrations.map((integration) => ({
    task_id: integration.task_id, task_sha: integration.source_task_sha, resulting_plan_sha: integration.resulting_plan_sha,
    cleanup_evidence: { task_ancestor_verified: true, worktree_removed: true, branch_removed: true },
  }));
  const input = {
    plan_id: "example-plan", plan_digest: "f".repeat(64), main_base_sha: sha("a"), plan_sha: sha("1"),
    plan_worktree: "/tmp/plan", expected_task_ids: expectedTaskIds, task_integrations: taskIntegrations,
    task_cleanups: taskCleanups, acceptance: ["complete plan behavior works", "all tasks are represented"],
  };
  assert.equal(validateActionInput("coding.validate_plan", input, contract), input);
  assert.throws(() => validateActionInput("coding.validate_plan", {
    ...input, expected_task_ids: ["task-01"],
  }, contract), /complete task integration and cleanup sets/);
  assert.throws(() => validateActionInput("coding.validate_plan", {
    ...input, task_integrations: [taskIntegrations[0], { ...taskIntegrations[1], task_id: "task-01" }],
  }, contract), /complete task integration and cleanup sets/);
  assert.throws(() => validateActionInput("coding.validate_plan", { ...input, plan_sha: sha("f") }, contract), /latest plan SHA/);
  assert.throws(() => validateActionInput("coding.validate_plan", {
    ...input, task_integrations: [taskIntegrations[0], { ...taskIntegrations[1], base_plan_sha: sha("a") }],
  }, contract), /continuous no-ff integration and task completion/);
  assert.throws(() => validateActionInput("coding.validate_plan", {
    ...input, task_integrations: [taskIntegrations[0], { ...taskIntegrations[1], task_checkboxes_checked: false }],
  }, contract), /task completion chain/);
  assert.throws(() => validateActionInput("coding.validate_plan", {
    ...input, task_cleanups: taskCleanups.slice(0, 1),
  }, contract), /complete task integration and cleanup sets/);
  assert.throws(() => validateActionInput("coding.validate_plan", {
    ...input, task_cleanups: [taskCleanups[0], { ...taskCleanups[1], cleanup_evidence: { ...taskCleanups[1].cleanup_evidence, branch_removed: false } }],
  }, contract), /completed cleanup/);

  const result = {
    result: "completed", summary: "Plan validated", plan_id: input.plan_id, main_base_sha: input.main_base_sha,
    plan_review_sha: input.plan_sha, expected_task_ids: expectedTaskIds, task_integrations: taskIntegrations, task_cleanups: taskCleanups,
    changed_paths: ["src/one.mjs", "src/two.mjs"],
    acceptance_evidence: [
      { criterion: "complete plan behavior works", evidence: "cumulative suite passed" },
      { criterion: "all tasks are represented", evidence: "task slices checked" },
    ],
    verification: [{ command: "npm test", result: "passed" }],
    review_basis: {
      ...reviewBasis({ origin: "approved_plan" }), implementation_ids: expectedTaskIds,
      acceptance: input.acceptance, scope_evidence: ["all task integrations are included"],
      verification: [{ command: "npm test", result: "passed", focused: false }],
    },
    slices: [{ id: "slice-1", task_id: "task-01" }, { id: "slice-2", task_id: "task-02" }],
    clean_state: { clean: true },
  };
  assert.equal(validateTaskResult("coding.validate_plan", result, contract, input), result);
  assert.throws(() => validateTaskResult("coding.validate_plan", {
    ...result, slices: [{ id: "slice-1", task_id: "task-01" }],
  }, contract, input), /task slices/);
  assert.throws(() => validateTaskResult("coding.validate_plan", {
    ...result, review_basis: { ...result.review_basis, origin: "direct_bug" },
  }, contract, input), /complete clean plan review range/);
  assert.throws(() => validateTaskResult("coding.validate_plan", {
    ...result, acceptance_evidence: result.acceptance_evidence.slice(0, 1),
  }, contract, input), /complete clean plan review range/);
  assert.throws(() => validateTaskResult("coding.validate_plan", {
    ...result,
    verification: [{ command: "npm test", result: "failed" }],
    review_basis: { ...result.review_basis, verification: [{ command: "npm test", result: "failed", focused: false }] },
  }, contract, input), /complete clean plan review range/);

  const resyncResult = {
    ...result,
    review_basis: { ...result.review_basis, stage: "resync" },
  };
  assert.equal(validateTaskResult("coding.validate_plan_resync_1", resyncResult, contract, input), resyncResult);
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
