import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const CONTRACT_PATH = resolve(import.meta.dirname, "..", "workflow-contract.json");
const TASK_RESULT_SCHEMAS_PATH = resolve(import.meta.dirname, "..", "task-result-schemas.json");
const EMPTY_COLLECTION_FIELDS = new Set(["changed_paths", "decision_history", "deleted_paths", "finding_ids", "known_paths", "open_decisions"]);
const REVIEW_CRITERIA = [
  "direct_request_origin", "initial_review_stage", "full_review_not_requested", "modified_text_files_only", "changed_file_limit",
  "changed_line_limit", "no_sensitive_changes", "triage_scope_match", "automated_verification_passed",
];
const SENSITIVE_AREAS = [
  "public_api_contract", "data_schema", "permissions_security", "dependencies", "build_release", "cross_module_behavior", "persistence",
];
const CHANGE_TYPES = ["modified", "added", "deleted", "renamed", "copied", "type_changed", "binary"];
const SMALL_CHANGE_NOTICE = "本次变更符合低风险小改动快速通道，未执行 Standards/Spec 双轴审查；已完成聚焦自动化验证和 Git 状态校验。";
const schemasByContract = new WeakMap();
let cachedContract;
let cachedTaskResultSchemas;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

function duplicateFreeStrings(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry) && new Set(value).size === value.length;
}

function nonEmpty(value, field) {
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0 || EMPTY_COLLECTION_FIELDS.has(field);
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return value !== undefined && value !== null;
}

function assertPayloadContract(value, label) {
  const allowed = ["required_fields", "optional_fields", "required_error_fields"];
  if (!isPlainObject(value) || Object.keys(value).some((key) => !allowed.includes(key)) ||
    !duplicateFreeStrings(value.required_fields) || !duplicateFreeStrings(value.optional_fields ?? []) ||
    !duplicateFreeStrings(value.required_error_fields ?? []) ||
    value.required_fields.some((field) => (value.optional_fields ?? []).includes(field))) {
    throw new Error(`${label} is invalid`);
  }
}

function actionIo(actionId, contract) {
  const action = contract.actions[actionId];
  const io = action && contract.io_contracts[action.io_contract];
  if (!io) throw new Error(`Action I/O contract is missing: ${actionId}`);
  return io;
}

function assertObjectFields(content, required, label, exact = false) {
  if (!isPlainObject(content)) throw new Error(`${label} content is invalid`);
  const missing = required.filter((field) => !Object.hasOwn(content, field));
  if (missing.length) throw new Error(`${label} requires fields: ${missing.join(", ")}`);
  if (exact && Object.keys(content).some((field) => !required.includes(field))) throw new Error(`${label} contains an unsupported field`);
}

function stringArray(value, allowEmpty = false) {
  return Array.isArray(value) && (allowEmpty || value.length > 0) && value.every((entry) => typeof entry === "string" && entry.trim()) && new Set(value).size === value.length;
}

function validateWriteScope(scope, label = "write_scope") {
  if (!stringArray(scope)) throw new Error(`${label} must be a non-empty unique string array`);
  for (const entry of scope) {
    const path = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    const segments = path.split("/");
    if (!path || entry.startsWith("/") || entry.includes("\\") || entry.includes("\0") || /[*?[\]{}]/.test(entry) ||
      segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw new Error(`${label} contains an unsafe repository-relative path`);
    }
  }
  return scope;
}

function pathIsWithinScope(path, scope) {
  if (typeof path !== "string" || !path || path.endsWith("/")) return false;
  try {
    validateWriteScope([path], "changed path");
  } catch {
    return false;
  }
  return scope.some((entry) => entry.endsWith("/") ? path.startsWith(entry) : path === entry);
}

function evidenceArray(value, fields) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) =>
    isPlainObject(entry) && Object.keys(entry).sort().join() === [...fields].sort().join() &&
    fields.every((field) => typeof entry[field] === "string" && entry[field].trim()));
}

function validateFinding(finding, spec) {
  const fields = ["id", "summary", "observable_impact", "slice_id", "path", "hunk", "minimum_fix"];
  if (spec) fields.push("requirement");
  assertObjectFields(finding, fields, "finding", true);
  for (const field of fields) if (!nonEmpty(finding[field], field)) throw new Error(`finding requires non-empty ${field}`);
}

function validatePathChange(change) {
  const types = new Set(["1", "2", "u", "?", "!"]);
  if (!isPlainObject(change) || !types.has(change.record_type) || !/^[.MTADRCU]$/.test(change.index_status) ||
    !/^[.MTADRCU]$/.test(change.worktree_status) || typeof change.path !== "string" || !change.path || change.path.includes("\0")) {
    throw new Error("PathChange is invalid");
  }
  if (change.record_type === "2") {
    if (typeof change.source_path !== "string" || !change.source_path || change.source_path.includes("\0")) throw new Error("PathChange source_path is invalid");
  } else if (Object.hasOwn(change, "source_path")) throw new Error("PathChange source_path is invalid");
}

function reviewVerificationStatus(verification) {
  if (verification.some((entry) => entry.result === "failed")) return "failed";
  if (verification.some((entry) => entry.focused && entry.result === "passed")) return "passed";
  return "indeterminate";
}

function validateReviewDispositionBinding(disposition, packet) {
  const context = packet.review_context;
  const criteria = Object.fromEntries(disposition.criteria.map((criterion) => [criterion.criterion, criterion.status]));
  const sameChangeTypes = JSON.stringify([...disposition.change_types].sort()) === JSON.stringify([...context.change_types].sort());
  if (disposition.origin !== context.origin || disposition.stage !== context.stage ||
    disposition.changed_file_count !== context.changed_file_count || disposition.changed_line_count !== context.changed_line_count || !sameChangeTypes ||
    criteria.full_review_not_requested !== (context.user_requested_full_review ? "failed" : "passed") ||
    criteria.triage_scope_match !== context.scope_match_status || criteria.automated_verification_passed !== reviewVerificationStatus(context.verification)) {
    throw new Error("review_disposition is not bound to review_packet evidence");
  }
}

export function digestValue(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

export async function loadWorkflowContract(path = CONTRACT_PATH) {
  if (path === CONTRACT_PATH && cachedContract) return cachedContract;
  const contract = JSON.parse(await readFile(path, "utf8"));
  assertWorkflowContract(contract);
  const schemas = await loadTaskResultSchemas(path === CONTRACT_PATH ? TASK_RESULT_SCHEMAS_PATH : resolve(dirname(path), "task-result-schemas.json"));
  assertTaskResultSchemas(schemas, contract);
  schemasByContract.set(contract, schemas);
  if (path === CONTRACT_PATH) cachedContract = Object.freeze(contract);
  return contract;
}

export async function loadTaskResultSchemas(path = TASK_RESULT_SCHEMAS_PATH) {
  if (path === TASK_RESULT_SCHEMAS_PATH && cachedTaskResultSchemas) return cachedTaskResultSchemas;
  const schemas = JSON.parse(await readFile(path, "utf8"));
  if (path === TASK_RESULT_SCHEMAS_PATH) cachedTaskResultSchemas = Object.freeze(schemas);
  return schemas;
}

function resultFieldNames(contract) {
  const fields = new Set(["result", "summary"]);
  const resultGroups = [
    ...Object.values(contract.io_contracts).map((io) => io.result_contracts),
    ...Object.values(contract.support_result_contracts),
  ];
  for (const results of resultGroups) {
    for (const resultContract of Object.values(results)) {
      for (const field of [...resultContract.required_fields, ...resultContract.optional_fields, ...(resultContract.required_error_fields ?? [])]) fields.add(field);
    }
  }
  return fields;
}

export function assertTaskResultSchemas(schemas, contract) {
  if (!isPlainObject(schemas) || schemas.contract_digest !== contract.digest || !isPlainObject(schemas.envelope) ||
    !isPlainObject(schemas.field_schemas) || !isPlainObject(schemas.structured_content_schemas)) {
    throw new Error("TaskResult schemas are invalid or stale");
  }
  for (const field of resultFieldNames(contract)) {
    const schema = schemas.envelope[field] ?? schemas.field_schemas[field];
    if (!isPlainObject(schema) || typeof schema.prompt_type !== "string" || !schema.prompt_type.trim()) {
      throw new Error(`TaskResult schema is missing: ${field}`);
    }
  }
  for (const [name, contentContract] of Object.entries(contract.structured_content)) {
    const schema = schemas.structured_content_schemas[name];
    if (!isPlainObject(schema) || schema.type !== "object" || !Array.isArray(schema.required) ||
      JSON.stringify([...schema.required].sort()) !== JSON.stringify([...contentContract.required_fields].sort())) {
      throw new Error(`Structured content schema is missing or stale: ${name}`);
    }
  }
  return schemas;
}

function resolveSchemaReference(reference, root) {
  if (!reference.startsWith("#/")) throw new Error(`Unsupported schema reference: ${reference}`);
  return reference.slice(2).split("/").reduce((value, part) => value?.[part.replaceAll("~1", "/").replaceAll("~0", "~")], root);
}

export function validateJsonSchema(value, schema, root = schema, path = "value") {
  if (schema.$ref) {
    const resolved = resolveSchemaReference(schema.$ref, root);
    if (!isPlainObject(resolved)) throw new Error(`${path} references an unknown schema`);
    return validateJsonSchema(value, resolved, root, path);
  }
  const matchesType = {
    string: () => typeof value === "string",
    integer: () => Number.isSafeInteger(value),
    boolean: () => typeof value === "boolean",
    array: () => Array.isArray(value),
    object: () => isPlainObject(value),
  }[schema.type];
  if (matchesType && !matchesType()) throw new Error(`${path} must be ${schema.type}`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} must be one of: ${schema.enum.join(", ")}`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new Error(`${path} is too short`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw new Error(`${path} has an invalid format`);
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) throw new Error(`${path} is below its minimum`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${path} has too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`${path} has too many items`);
    if (schema.uniqueItems && new Set(value.map((entry) => JSON.stringify(canonicalize(entry)))).size !== value.length) throw new Error(`${path} must contain unique items`);
    if (schema.items) value.forEach((entry, index) => validateJsonSchema(entry, schema.items, root, `${path}[${index}]`));
  }
  if (isPlainObject(value)) {
    const properties = schema.properties ?? {};
    for (const field of schema.required ?? []) if (!Object.hasOwn(value, field)) throw new Error(`${path}.${field} is required`);
    if (schema.additionalProperties === false && Object.keys(value).some((field) => !Object.hasOwn(properties, field))) throw new Error(`${path} contains an unsupported field`);
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) throw new Error(`${path} has too few properties`);
    for (const [field, entry] of Object.entries(value)) if (properties[field]) validateJsonSchema(entry, properties[field], root, `${path}.${field}`);
  }
  return value;
}

export function assertWorkflowContract(contract) {
  if (!isPlainObject(contract) || !isPlainObject(contract.task_result) || !isPlainObject(contract.structured_content) || !isPlainObject(contract.support_result_contracts) ||
    !isPlainObject(contract.workflows) || !isPlainObject(contract.actions) || !isPlainObject(contract.io_contracts) ||
    !isPlainObject(contract.budgets) || !duplicateFreeStrings(contract.decision_codes)) throw new Error("workflow contract is invalid");
  if (Object.hasOwn(contract, "version") || Object.hasOwn(contract, "lease_minutes")) throw new Error("workflow contract contains runtime fields");
  if (!/^[0-9a-f]{64}$/.test(contract.digest)) throw new Error("workflow contract digest is invalid");
  const { digest, ...unsigned } = contract;
  if (digestValue(unsigned) !== digest) throw new Error("workflow contract digest does not match its content");
  if (!duplicateFreeStrings(contract.task_result.required_fields) || contract.task_result.required_fields.join() !== "result,summary" ||
    !duplicateFreeStrings(contract.task_result.results) || !duplicateFreeStrings(contract.task_result.failure_fields)) throw new Error("TaskResult contract is invalid");
  for (const [name, schema] of Object.entries(contract.structured_content)) {
    if (!isPlainObject(schema) || Object.keys(schema).some((key) => !["required_fields", "field_guidance"].includes(key)) ||
      !duplicateFreeStrings(schema.required_fields) || !isPlainObject(schema.field_guidance) ||
      Object.entries(schema.field_guidance).some(([field, guidance]) => !schema.required_fields.includes(field) || typeof guidance !== "string" || !guidance.trim())) {
      throw new Error(`structured content is invalid: ${name}`);
    }
  }
  for (const [name, io] of Object.entries(contract.io_contracts)) {
    if (!isPlainObject(io?.input_contract) || !isPlainObject(io?.result_contracts)) throw new Error(`workflow I/O contract is invalid: ${name}`);
    assertPayloadContract(io.input_contract, `workflow I/O input ${name}`);
    for (const [result, resultContract] of Object.entries(io.result_contracts)) {
      if (!contract.task_result.results.includes(result)) throw new Error(`workflow I/O result is invalid: ${name}/${result}`);
      assertPayloadContract(resultContract, `workflow I/O result ${name}/${result}`);
    }
  }
  for (const [roleId, results] of Object.entries(contract.support_result_contracts)) {
    if (!isPlainObject(results)) throw new Error(`support result contract is invalid: ${roleId}`);
    for (const [result, resultContract] of Object.entries(results)) {
      if (!contract.task_result.results.includes(result)) throw new Error(`support result is invalid: ${roleId}/${result}`);
      assertPayloadContract(resultContract, `support result ${roleId}/${result}`);
    }
  }
  const owners = new Set();
  for (const [id, action] of Object.entries(contract.actions)) {
    const workflow = contract.workflows[action.workflow];
    const phases = new Set([...Object.keys(workflow?.phase_actions ?? {}), ...(workflow?.terminal_phases ?? [])]);
    if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(id) || typeof action.owner !== "string" ||
      !workflow || workflow.phase_actions[action.from]?.includes(id) !== true || typeof action.completed_to !== "string" ||
      !contract.io_contracts[action.io_contract]) throw new Error(`workflow contract action is invalid: ${id}`);
    if (!phases.has(action.completed_to) || (action.retryable_to && !phases.has(action.retryable_to)) ||
      (action.budget && !Object.hasOwn(contract.budgets, action.budget)) ||
      (action.decision_code && !contract.decision_codes.includes(action.decision_code))) throw new Error(`workflow contract transition is invalid: ${id}`);
    if (action.completed_to_by_task_mode && (Object.keys(action.completed_to_by_task_mode).sort().join() !== "single,split" ||
      Object.values(action.completed_to_by_task_mode).some((phase) => !phases.has(phase)))) throw new Error(`workflow contract task mode transition is invalid: ${id}`);
    if (action.completed_to_by_output) {
      const branch = action.completed_to_by_output;
      if (!isPlainObject(branch) || typeof branch.field !== "string" || !isPlainObject(branch.values) || Object.keys(branch.values).length < 2 ||
        !contract.io_contracts[action.io_contract].result_contracts.completed.required_fields.includes(branch.field) ||
        Object.values(branch.values).some((phase) => !phases.has(phase))) throw new Error(`workflow contract output transition is invalid: ${id}`);
    }
    owners.add(action.owner);
  }
  for (const [kind, workflow] of Object.entries(contract.workflows)) {
    for (const ids of Object.values(workflow.phase_actions)) {
      for (const id of ids) if (contract.actions[id]?.workflow !== kind) throw new Error(`workflow ${kind} references invalid action ${id}`);
    }
  }
  return { contract, owners };
}

export function validateActionInput(actionId, input, contract) {
  const schema = actionIo(actionId, contract).input_contract;
  assertObjectFields(input, schema.required_fields, "Action input");
  const allowed = [...schema.required_fields, ...schema.optional_fields];
  if (Object.keys(input).some((field) => !allowed.includes(field))) throw new Error("Action input contains an unsupported field");
  if (actionId === "coding.prepare") {
    if (!Object.hasOwn(input, "plan_id")) throw new Error("Action input requires plan_id");
    if (input.task_mode === "split" && !Object.hasOwn(input, "task_id")) throw new Error("Split task preparation requires task_id");
    if (input.task_mode === "single" && Object.hasOwn(input, "task_id")) throw new Error("Single task preparation does not accept task_id");
  }
  if (actionId === "coding.prepare_direct_bug" && (Object.hasOwn(input, "plan_id") || Object.hasOwn(input, "task_id"))) {
    throw new Error("Direct Bug preparation does not accept plan_id or task_id");
  }
  for (const field of schema.required_fields) if (!nonEmpty(input[field], field)) throw new Error(`Action input requires non-empty ${field}`);
  const schemas = schemasByContract.get(contract);
  if (!schemas) throw new Error("TaskResult schemas were not loaded with the workflow contract");
  for (const [field, value] of Object.entries(input)) {
    const fieldSchema = schemas.envelope[field] ?? schemas.field_schemas[field];
    if (fieldSchema) validateJsonSchema(value, fieldSchema, schemas, `Action input.${field}`);
  }
  if (actionId === "coding.implement_task") validateWriteScope(input.write_scope, "Action input.write_scope");
  for (const [field, value] of Object.entries(input)) if (contract.structured_content[field]) validateStructuredContent(field, value, contract);
  if (contract.actions[actionId].io_contract === "review_integration") {
    const skipped = input.review_disposition.mode === "skipped_small_change";
    validateReviewDispositionBinding(input.review_disposition, input.review_packet);
    if (input.review_sha !== input.feature_sha || input.review_sha !== input.review_packet.review_sha) throw new Error("Review integration SHA identity is invalid");
    if (skipped && Object.hasOwn(input, "review_result")) throw new Error("Skipped review integration must not include review_result");
    if (!skipped && (!input.review_result || input.review_result.verdict !== "passed")) throw new Error("Dual-axis review integration requires a passed review_result");
  }
  return input;
}

function validateTaskResultShape(label, resultContracts, taskResult, contract) {
  if (!isPlainObject(taskResult) || !contract.task_result.results.includes(taskResult.result) || typeof taskResult.summary !== "string" || !taskResult.summary.trim()) {
    throw new Error("TaskResult is invalid");
  }
  const schema = resultContracts[taskResult.result];
  if (!schema) throw new Error(`TaskResult result is not allowed for ${label}`);
  const allowed = ["result", "summary", ...schema.required_fields, ...schema.optional_fields, ...(schema.required_error_fields ?? [])];
  if (Object.keys(taskResult).some((field) => !allowed.includes(field))) throw new Error("TaskResult contains an unsupported field");
  for (const field of [...schema.required_fields, ...(schema.required_error_fields ?? [])]) {
    if (!Object.hasOwn(taskResult, field) || !nonEmpty(taskResult[field], field)) throw new Error(`TaskResult requires non-empty ${field}`);
  }
  const schemas = schemasByContract.get(contract);
  if (!schemas) throw new Error("TaskResult schemas were not loaded with the workflow contract");
  for (const [field, value] of Object.entries(taskResult)) {
    const fieldSchema = schemas.envelope[field] ?? schemas.field_schemas[field];
    if (!fieldSchema) throw new Error(`TaskResult schema is missing: ${field}`);
    validateJsonSchema(value, fieldSchema, schemas, `TaskResult.${field}`);
  }
  for (const [field, value] of Object.entries(taskResult)) if (contract.structured_content[field]) validateStructuredContent(field, value, contract);
  if (taskResult.result === "completed" && Object.hasOwn(taskResult, "review_disposition")) {
    if (taskResult.review_mode !== taskResult.review_disposition.mode) throw new Error("review_mode must match review_disposition.mode");
    if (label !== "coding.prepare_review" && taskResult.review_mode !== "dual_axis") throw new Error("Only coding.prepare_review may skip dual-axis review");
    validateReviewDispositionBinding(taskResult.review_disposition, taskResult.review_packet);
  }
  if (label === "planning.confirm" && taskResult.result === "completed" &&
    (taskResult.task_mode !== taskResult.planning_context.task_mode ||
      taskResult.task_mode !== taskResult.planning_context.task_mode_selection.selected)) {
    throw new Error("planning.confirm task_mode is not bound to the user selection");
  }
  if (label === "coding.implement_task" && taskResult.result === "completed") {
    validateWriteScope(taskResult.write_scope, "TaskResult.write_scope");
    const changedPaths = [
      ...taskResult.changed_paths,
      ...taskResult.change_evidence.path_changes.flatMap((change) => [change.path, ...(change.source_path ? [change.source_path] : [])]),
    ];
    if (changedPaths.some((path) => !pathIsWithinScope(path, taskResult.write_scope))) {
      throw new Error("coding.implement_task changed paths must stay within write_scope");
    }
  }
  return taskResult;
}

export function validateTaskResult(actionId, taskResult, contract, actionInput) {
  const result = validateTaskResultShape(actionId, actionIo(actionId, contract).result_contracts, taskResult, contract);
  if (actionId === "coding.implement_task" && taskResult.result === "completed") {
    if (!actionInput) throw new Error("coding.implement_task result validation requires action input");
    validateActionInput(actionId, actionInput, contract);
    if (taskResult.task_id !== actionInput.task_id || JSON.stringify(taskResult.write_scope) !== JSON.stringify(actionInput.write_scope)) {
      throw new Error("coding.implement_task result is not bound to task_id and write_scope input");
    }
  }
  return result;
}

export function validateSupportTaskResult(roleId, taskResult, contract) {
  const results = contract.support_result_contracts[roleId];
  if (!results) throw new Error(`Support result contract is missing: ${roleId}`);
  return validateTaskResultShape(roleId, results, taskResult, contract);
}

export function validateStructuredContent(kind, content, contract) {
  const schema = contract.structured_content[kind];
  if (!schema) throw new Error(`Unknown structured content: ${kind}`);
  assertObjectFields(content, schema.required_fields, kind, true);
  const schemas = schemasByContract.get(contract);
  const jsonSchema = schemas?.structured_content_schemas[kind];
  if (jsonSchema) validateJsonSchema(content, jsonSchema, schemas, kind);
  if (kind === "planning_context") {
    if (typeof content.plan_id !== "string" || !content.plan_id.trim() || !["single", "split"].includes(content.task_mode) ||
      typeof content.goal !== "string" || !content.goal.trim() || !stringArray(content.users_consumers) || !stringArray(content.success_criteria) ||
      !isPlainObject(content.scope) || !Object.keys(content.scope).length || !stringArray(content.constraints, true) || !stringArray(content.assumptions, true) ||
      !stringArray(content.acceptance_criteria) || !Array.isArray(content.decisions) || content.decisions.some((decision) =>
        !isPlainObject(decision) || Object.keys(decision).sort().join() !== "code,revision,summary" ||
        typeof decision.code !== "string" || !decision.code.trim() || !Number.isSafeInteger(decision.revision) || decision.revision < 1 ||
        typeof decision.summary !== "string" || !decision.summary.trim()) || !Array.isArray(content.open_questions) || content.open_questions.length !== 0 ||
      content.task_mode !== content.task_mode_selection.selected) throw new Error("planning_context is invalid");
  }
  if (kind === "change_evidence") {
    if (!/^[0-9a-f]{40,64}$/.test(content.base_sha) || !/^[0-9a-f]{40,64}$/.test(content.head_sha) ||
      !Array.isArray(content.path_changes) || !content.path_changes.length || !evidenceArray(content.acceptance_evidence, ["criterion", "evidence"]) ||
      !evidenceArray(content.verification, ["command", "result"])) throw new Error("change_evidence is invalid");
    content.path_changes.forEach(validatePathChange);
  }
  if (kind === "review_packet" && (!/^[0-9a-f]{40,64}$/.test(content.base_sha) || !/^[0-9a-f]{40,64}$/.test(content.review_sha) ||
    !isPlainObject(content.review_context) || !Object.keys(content.review_context).length || !Array.isArray(content.slices) || !content.slices.length ||
    content.slices.some((slice) => !isPlainObject(slice)))) throw new Error("review_packet is invalid");
  if (kind === "review_disposition") {
    if (!["dual_axis", "skipped_small_change"].includes(content.mode) ||
      !["direct_bug", "direct_small_feature", "approved_plan", "finding_fix", "rereview", "resync"].includes(content.origin) ||
      !["initial", "rereview", "resync"].includes(content.stage) || !Number.isSafeInteger(content.changed_file_count) || content.changed_file_count < 0 ||
      !Number.isSafeInteger(content.changed_line_count) || content.changed_line_count < 0 || !stringArray(content.change_types) || content.change_types.some((type) => !CHANGE_TYPES.includes(type)) ||
      !Array.isArray(content.criteria) || !Array.isArray(content.sensitive_areas) || typeof content.user_notice !== "string" || !content.user_notice.trim() ||
      content.criteria.some((criterion) => !isPlainObject(criterion) || !["passed", "failed", "indeterminate"].includes(criterion.status) || typeof criterion.evidence !== "string" || !criterion.evidence.trim()) ||
      content.sensitive_areas.some((area) => !isPlainObject(area) || !["clear", "present", "unknown"].includes(area.status) || typeof area.evidence !== "string" || !area.evidence.trim())) {
      throw new Error("review_disposition is invalid");
    }
    const criterionNames = content.criteria.map((criterion) => criterion.criterion).sort();
    const areaNames = content.sensitive_areas.map((area) => area.area).sort();
    if (JSON.stringify(criterionNames) !== JSON.stringify([...REVIEW_CRITERIA].sort()) ||
      JSON.stringify(areaNames) !== JSON.stringify([...SENSITIVE_AREAS].sort())) throw new Error("review_disposition must cover every fixed criterion and sensitive area exactly once");
    const criteria = Object.fromEntries(content.criteria.map((criterion) => [criterion.criterion, criterion.status]));
    const areaStatuses = content.sensitive_areas.map((area) => area.status);
    const expectedSensitiveStatus = areaStatuses.includes("present") ? "failed" : areaStatuses.includes("unknown") ? "indeterminate" : "passed";
    const expectedCriteria = {
      direct_request_origin: ["direct_bug", "direct_small_feature"].includes(content.origin) ? "passed" : "failed",
      initial_review_stage: content.stage === "initial" ? "passed" : "failed",
      modified_text_files_only: content.change_types.length === 1 && content.change_types[0] === "modified" ? "passed" : "failed",
      changed_file_limit: content.changed_file_count >= 1 && content.changed_file_count <= 2 ? "passed" : "failed",
      changed_line_limit: content.changed_line_count <= 50 ? "passed" : "failed",
      no_sensitive_changes: expectedSensitiveStatus,
    };
    if (Object.entries(expectedCriteria).some(([criterion, status]) => criteria[criterion] !== status)) throw new Error("review_disposition evidence is inconsistent");
    const eligible = ["direct_bug", "direct_small_feature"].includes(content.origin) && content.stage === "initial" &&
      content.changed_file_count >= 1 && content.changed_file_count <= 2 && content.changed_line_count <= 50 &&
      content.change_types.length === 1 && content.change_types[0] === "modified" &&
      Object.values(criteria).every((status) => status === "passed") && areaStatuses.every((status) => status === "clear");
    if ((content.mode === "skipped_small_change") !== eligible) throw new Error("review_disposition mode is inconsistent with fail-closed criteria");
    if (content.mode === "skipped_small_change" && content.user_notice !== SMALL_CHANGE_NOTICE) throw new Error("review_disposition skip notice is invalid");
  }
  if (kind === "review_axis_result") {
    if (!["standards", "spec"].includes(content.axis) || !Array.isArray(content.findings) || !Array.isArray(content.advisory_findings) || !stringArray(content.coverage)) throw new Error("review_axis_result is invalid");
    for (const finding of [...content.findings, ...content.advisory_findings]) validateFinding(finding, content.axis === "spec");
    const findingIds = [...content.findings, ...content.advisory_findings].map((finding) => finding.id);
    if (new Set(findingIds).size !== findingIds.length) throw new Error("review_axis_result finding IDs must be unique");
  }
  if (kind === "review_result") {
    if (!Array.isArray(content.axis_results) || content.axis_results.length !== 2 || !["passed", "blocking"].includes(content.verdict) ||
      !stringArray(content.finding_ids, true) || !stringArray(content.coverage)) throw new Error("review_result is invalid");
    content.axis_results.forEach((axis) => validateStructuredContent("review_axis_result", axis, contract));
    const findingIds = [...new Set(content.axis_results.flatMap((axis) => axis.findings.map((finding) => finding.id)))].sort();
    const coverage = [...new Set(content.axis_results.flatMap((axis) => axis.coverage))].sort();
    if (new Set(content.axis_results.map((axis) => axis.axis)).size !== 2 || JSON.stringify([...content.finding_ids].sort()) !== JSON.stringify(findingIds) ||
      JSON.stringify([...content.coverage].sort()) !== JSON.stringify(coverage) || (findingIds.length > 0) !== (content.verdict === "blocking")) throw new Error("review_result axes, verdict, finding IDs, or coverage are invalid");
  }
  return content;
}
