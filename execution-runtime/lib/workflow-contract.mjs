import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { assertPathChange } from "./paths.mjs";

const CONTRACT_PATH = resolve(import.meta.dirname, "..", "workflow-contract.json");
let cached;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function digestValue(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

export async function loadWorkflowContract(path = CONTRACT_PATH) {
  if (path === CONTRACT_PATH && cached) return cached;
  const contract = JSON.parse(await readFile(path, "utf8"));
  assertWorkflowContract(contract);
  if (path === CONTRACT_PATH) cached = Object.freeze(contract);
  return contract;
}

export function assertWorkflowContract(contract) {
  if (!contract || contract.version !== 2 || contract.lease_minutes !== 30 || !contract.workflows || !contract.actions || !contract.io_contracts || !contract.artifact_kinds || !Array.isArray(contract.completion_results)) {
    throw new Error("workflow contract is invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(contract.digest)) throw new Error("workflow contract digest is invalid");
  const { digest, ...unsigned } = contract;
  if (digestValue(unsigned) !== digest) throw new Error("workflow contract digest does not match its content");
  const owners = new Set();
  for (const [id, action] of Object.entries(contract.actions)) {
    if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(id) || typeof action.owner !== "string") {
      throw new Error(`workflow contract action is invalid: ${id}`);
    }
    owners.add(action.owner);
    if (!contract.io_contracts[action.io_contract]) throw new Error(`workflow contract action I/O is invalid: ${id}`);
    const workflow = contract.workflows[action.workflow];
    if (!workflow || workflow.phase_actions[action.from]?.includes(id) !== true || typeof action.completed_to !== "string") {
      throw new Error(`workflow contract transition is invalid: ${id}`);
    }
    if (action.completed_to_by_task_mode) {
      const branches = action.completed_to_by_task_mode;
      const phases = new Set([...Object.keys(workflow.phase_actions), ...workflow.terminal_phases]);
      if (!isPlainObject(branches) || Object.keys(branches).sort().join() !== "single,split" || Object.values(branches).some((phase) => !phases.has(phase))) {
        throw new Error(`workflow contract task mode transition is invalid: ${id}`);
      }
    }
    if (action.completed_to_by_output) {
      const branch = action.completed_to_by_output;
      const phases = new Set([...Object.keys(workflow.phase_actions), ...workflow.terminal_phases]);
      if (!isPlainObject(branch) || typeof branch.field !== "string" || !branch.field || !isPlainObject(branch.values) ||
        !contract.io_contracts[action.io_contract].result_contracts.completed.required_fields.includes(branch.field) ||
        Object.keys(branch.values).length < 2 || Object.values(branch.values).some((phase) => !phases.has(phase))) {
        throw new Error(`workflow contract output transition is invalid: ${id}`);
      }
    }
  }
  for (const [name, io] of Object.entries(contract.io_contracts)) {
    if (!io?.input_contract || !io?.result_contracts) throw new Error(`workflow I/O contract is invalid: ${name}`);
    assertPayloadContract(io.input_contract, `workflow I/O input ${name}`);
    for (const [result, resultContract] of Object.entries(io.result_contracts)) {
      if (!contract.completion_results.includes(result)) {
        throw new Error(`workflow I/O result is invalid: ${name}/${result}`);
      }
      assertPayloadContract(resultContract, `workflow I/O result ${name}/${result}`);
    }
  }
  for (const [kind, workflow] of Object.entries(contract.workflows)) {
    for (const ids of Object.values(workflow.phase_actions)) {
      for (const id of ids) if (contract.actions[id]?.workflow !== kind) throw new Error(`workflow ${kind} references invalid action ${id}`);
    }
  }
  return { contract, owners };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function duplicateFreeStrings(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry) && new Set(value).size === value.length;
}

function assertPayloadContract(value, label) {
  const allowed = ["required_fields", "optional_fields", "required_error_fields", "required_artifact_kinds"];
  if (!isPlainObject(value) || Object.keys(value).some((key) => !allowed.includes(key)) ||
    !duplicateFreeStrings(value.required_fields) || !duplicateFreeStrings(value.optional_fields ?? []) ||
    !duplicateFreeStrings(value.required_error_fields ?? []) || !duplicateFreeStrings(value.required_artifact_kinds) ||
    value.required_fields.some((field) => (value.optional_fields ?? []).includes(field))) {
    throw new Error(`${label} is invalid`);
  }
}

const EMPTY_COLLECTION_FIELDS = new Set(["changed_paths", "decision_history", "deleted_paths", "finding_ids", "known_paths", "open_decisions"]);

function nonEmpty(value, field) {
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0 || EMPTY_COLLECTION_FIELDS.has(field);
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return value !== undefined && value !== null;
}

function validateFields(fields, payloadContract, label, requireNonEmpty) {
  if (!isPlainObject(fields)) throw new Error(`${label} fields are invalid`);
  const allowed = [...payloadContract.required_fields, ...(payloadContract.optional_fields ?? [])];
  if (Object.keys(fields).some((field) => !allowed.includes(field))) throw new Error(`${label} contains an unsupported field`);
  for (const field of payloadContract.required_fields) if (!Object.hasOwn(fields, field) || (requireNonEmpty && !nonEmpty(fields[field], field))) throw new Error(`${label} requires${requireNonEmpty ? " non-empty" : ""} ${field}`);
  if (requireNonEmpty) for (const [field, value] of Object.entries(fields)) if (!nonEmpty(value, field)) throw new Error(`${label} field ${field} must be non-empty`);
}

function validateArtifactKinds(artifacts, requiredKinds, label) {
  if (!Array.isArray(artifacts)) throw new Error(`${label} artifacts are invalid`);
  artifacts.forEach(validateArtifactRef);
  if (artifacts.some((ref) => !requiredKinds.includes(ref.kind))) throw new Error(`${label} contains an unsupported artifact kind`);
  for (const kind of requiredKinds) if (!artifacts.some((ref) => ref.kind === kind)) throw new Error(`${label} requires ${kind} artifact`);
}

function actionIo(actionId, contract) {
  const action = contract.actions[actionId];
  const io = action && contract.io_contracts[action.io_contract];
  if (!io) throw new Error(`Action I/O contract is missing: ${actionId}`);
  return io;
}

export function validateActionInput(input, actionId, contract) {
  if (!isPlainObject(input) || Object.keys(input).sort().join() !== "artifacts,fields") throw new Error("Action input is invalid");
  const inputContract = actionIo(actionId, contract).input_contract;
  validateFields(input.fields, inputContract, "Action input", true);
  validateArtifactKinds(input.artifacts, inputContract.required_artifact_kinds, "Action input");
  return input;
}

export function validateArtifactRef(ref) {
  if (!ref || typeof ref.kind !== "string" || typeof ref.id !== "string" ||
    !/^[0-9a-f]{64}$/.test(ref.sha256) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 ||
    Object.keys(ref).sort().join() !== ["bytes", "id", "kind", "sha256"].join()) {
    throw new Error("ArtifactRef is invalid");
  }
  return ref;
}

export function validateActionReceipt(receipt, contract) {
  const allowed = ["run_id", "action_id", "attempt", "result", "summary", "outputs", "artifacts", "checks", "error", "decision_request"];
  if (!receipt || Object.keys(receipt).some((key) => !allowed.includes(key)) ||
    typeof receipt.run_id !== "string" || !contract.actions[receipt.action_id] ||
    !Number.isSafeInteger(receipt.attempt) || receipt.attempt < 1 ||
    !contract.completion_results.includes(receipt.result) ||
    typeof receipt.summary !== "string" || !receipt.summary.trim() || !isPlainObject(receipt.outputs) ||
    !Array.isArray(receipt.artifacts) || !Array.isArray(receipt.checks) ||
    receipt.checks.some((check) => typeof check !== "string" || !check.trim())) {
    throw new Error("ActionReceipt is invalid");
  }
  receipt.artifacts.forEach(validateArtifactRef);
  validateActionResult(receipt, contract, false);
  if (receipt.result === "needs_decision" && (!receipt.decision_request || typeof receipt.decision_request.code !== "string")) {
    throw new Error("needs_decision receipt requires decision_request");
  }
  if (receipt.result !== "needs_decision" && receipt.decision_request !== undefined) throw new Error("ActionReceipt result does not allow decision_request");
  return receipt;
}

function validateError(error, resultContract, label) {
  const required = resultContract.required_error_fields ?? [];
  if (required.length === 0) {
    if (error !== undefined) throw new Error(`${label} does not allow error`);
    return;
  }
  if (!isPlainObject(error) || Object.keys(error).some((field) => !required.includes(field))) throw new Error(`${label} error is invalid`);
  for (const field of required) if (!Object.hasOwn(error, field) || !nonEmpty(error[field], field)) throw new Error(`${label} requires error.${field}`);
}

function validateActionResult(receipt, contract, support) {
  const resultContract = actionIo(receipt.action_id, contract).result_contracts[receipt.result];
  if (!resultContract || (support && receipt.result === "retryable_failure")) throw new Error(`Result is not allowed for ${receipt.action_id}`);
  validateFields(receipt.outputs, resultContract, support ? "SupportReceipt outputs" : "ActionReceipt outputs", true);
  validateArtifactKinds(receipt.artifacts, resultContract.required_artifact_kinds, support ? "SupportReceipt" : "ActionReceipt");
  for (const [field, value] of Object.entries(receipt.outputs)) {
    if (!field.endsWith("_ref")) continue;
    validateArtifactRef(value);
    if (!receipt.artifacts.some((ref) => JSON.stringify(ref) === JSON.stringify(value))) throw new Error(`${field} must reference a receipt artifact`);
  }
  validateError(receipt.error, resultContract, support ? "SupportReceipt" : "ActionReceipt");
}

export function validateSupportReceipt() {
  throw new Error("SupportReceipt is not part of workflow contract v2");
}

function assertObjectFields(content, required, label, exact = false) {
  if (!isPlainObject(content)) throw new Error(`${label} artifact content is invalid`);
  const missing = required.filter((field) => !Object.hasOwn(content, field));
  if (missing.length) throw new Error(`${label} artifact requires fields: ${missing.join(", ")}`);
  if (exact && Object.keys(content).some((field) => !required.includes(field))) throw new Error(`${label} artifact contains an unsupported field`);
}

function stringArray(value, allowEmpty = false) {
  return Array.isArray(value) && (allowEmpty || value.length > 0) && value.every((entry) => typeof entry === "string" && entry.trim()) && new Set(value).size === value.length;
}

function evidenceArray(value, fields) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => {
    if (!isPlainObject(entry) || Object.keys(entry).sort().join() !== [...fields].sort().join()) return false;
    return fields.every((field) => typeof entry[field] === "string" && entry[field].trim());
  });
}

const nonEmptyStringSchema = Object.freeze({ type: "string", minLength: 1 });
const stringArraySchema = (minItems = 1) => ({ type: "array", items: nonEmptyStringSchema, minItems, uniqueItems: true });

export function artifactContentSchema(kind, contract) {
  const required = contract.artifact_kinds[kind]?.required_fields;
  if (!required) return {};
  const schemas = {
    planning_context: {
      version: { type: "integer", const: 1 }, plan_id: nonEmptyStringSchema, task_mode: { type: "string", enum: ["single", "split"] },
      goal: nonEmptyStringSchema, users_consumers: stringArraySchema(), success_criteria: stringArraySchema(),
      scope: { type: "object", minProperties: 1 }, constraints: stringArraySchema(0), assumptions: stringArraySchema(0),
      acceptance_criteria: stringArraySchema(),
      decisions: { type: "array", items: { type: "object", required: ["code", "revision", "summary"], properties: {
        code: nonEmptyStringSchema, revision: { type: "integer", minimum: 1 }, summary: nonEmptyStringSchema,
      }, additionalProperties: false } },
      open_questions: { type: "array", maxItems: 0 },
    },
    change_evidence: {
      base_sha: { type: "string", pattern: "^[0-9a-f]{40,64}$" }, head_sha: { type: "string", pattern: "^[0-9a-f]{40,64}$" },
      path_changes: { type: "array", minItems: 1 }, acceptance_evidence: { type: "array", minItems: 1 }, verification: { type: "array", minItems: 1 },
    },
    review_packet: {
      base_sha: { type: "string", pattern: "^[0-9a-f]{40,64}$" }, review_sha: { type: "string", pattern: "^[0-9a-f]{40,64}$" },
      review_context: { type: "object", minProperties: 1 }, slices: { type: "array", minItems: 1 },
    },
    review_axis_result: {
      axis: { type: "string", enum: ["standards", "spec"] }, findings: { type: "array" }, advisory_findings: { type: "array" }, coverage: stringArraySchema(),
    },
    review_result: {
      axis_results: { type: "array", minItems: 2, maxItems: 2 }, verdict: { type: "string", enum: ["passed", "blocking"] }, finding_ids: stringArraySchema(0), coverage: stringArraySchema(),
    },
  };
  return { type: "object", required, properties: schemas[kind] ?? {}, additionalProperties: false };
}

function validateFinding(finding, spec) {
  const fields = ["id", "summary", "observable_impact", "slice_id", "path", "hunk", "minimum_fix"];
  if (spec) fields.push("requirement");
  assertObjectFields(finding, fields, "finding", true);
  for (const field of fields) if (!nonEmpty(finding[field], field)) throw new Error(`finding requires non-empty ${field}`);
}

export function validateArtifactContent(kind, content, contract) {
  const schema = contract.artifact_kinds[kind];
  if (!schema) return content;
  assertObjectFields(content, schema.required_fields, kind, true);
  if (kind === "planning_context") {
    if (content.version !== 1 || typeof content.plan_id !== "string" || !content.plan_id.trim() || !["single", "split"].includes(content.task_mode) ||
      typeof content.goal !== "string" || !content.goal.trim() || !stringArray(content.users_consumers) || !stringArray(content.success_criteria) ||
      !isPlainObject(content.scope) || Object.keys(content.scope).length === 0 || !stringArray(content.constraints, true) || !stringArray(content.assumptions, true) ||
      !stringArray(content.acceptance_criteria) || !Array.isArray(content.decisions) || content.decisions.some((decision) => (
        !isPlainObject(decision) || Object.keys(decision).sort().join() !== "code,revision,summary" || !Number.isSafeInteger(decision.revision) || decision.revision < 1 ||
        typeof decision.code !== "string" || !decision.code.trim() || typeof decision.summary !== "string" || !decision.summary.trim()
      )) || !Array.isArray(content.open_questions) || content.open_questions.length !== 0) {
      throw new Error("planning_context artifact is invalid");
    }
  }
  if (kind === "change_evidence") {
    if (!/^[0-9a-f]{40,64}$/.test(content.base_sha) || !/^[0-9a-f]{40,64}$/.test(content.head_sha) || !Array.isArray(content.path_changes) || content.path_changes.length === 0 ||
      !evidenceArray(content.acceptance_evidence, ["criterion", "evidence"]) || !evidenceArray(content.verification, ["command", "result"])) {
      throw new Error("change_evidence artifact is invalid");
    }
    content.path_changes.forEach(assertPathChange);
  }
  if (kind === "review_packet") {
    if (!/^[0-9a-f]{40,64}$/.test(content.base_sha) || !/^[0-9a-f]{40,64}$/.test(content.review_sha) || !isPlainObject(content.review_context) ||
      Object.keys(content.review_context).length === 0 || !Array.isArray(content.slices) || content.slices.length === 0 || content.slices.some((slice) => !isPlainObject(slice))) {
      throw new Error("review_packet artifact is invalid");
    }
  }
  if (kind === "review_axis_result") {
    if (!["standards", "spec"].includes(content.axis) || !Array.isArray(content.findings) || !Array.isArray(content.advisory_findings) || !stringArray(content.coverage)) {
      throw new Error("review_axis_result artifact is invalid");
    }
    for (const finding of [...content.findings, ...content.advisory_findings]) validateFinding(finding, content.axis === "spec");
    const findingIds = [...content.findings, ...content.advisory_findings].map((finding) => finding.id);
    if (new Set(findingIds).size !== findingIds.length) throw new Error("review_axis_result finding IDs must be unique");
  }
  if (kind === "review_result") {
    if (!Array.isArray(content.axis_results) || content.axis_results.length !== 2 || !["passed", "blocking"].includes(content.verdict) || !stringArray(content.finding_ids, true) || !stringArray(content.coverage)) {
      throw new Error("review_result artifact is invalid");
    }
    content.axis_results.forEach((axis) => validateArtifactContent("review_axis_result", axis, contract));
    const findingIds = [...new Set(content.axis_results.flatMap((axis) => axis.findings.map((finding) => finding.id)))].sort();
    const coverage = [...new Set(content.axis_results.flatMap((axis) => axis.coverage))].sort();
    if (new Set(content.axis_results.map((axis) => axis.axis)).size !== 2 || new Set(content.finding_ids).size !== content.finding_ids.length ||
      JSON.stringify([...content.finding_ids].sort()) !== JSON.stringify(findingIds) || JSON.stringify([...content.coverage].sort()) !== JSON.stringify(coverage) ||
      (findingIds.length > 0) !== (content.verdict === "blocking")) throw new Error("review_result axes, verdict, finding IDs, or coverage are invalid");
  }
  return content;
}
