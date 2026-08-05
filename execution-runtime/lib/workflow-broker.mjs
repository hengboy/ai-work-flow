import { loadWorkflowContract } from "./workflow-contract.mjs";
import {
  WorkflowBusinessError, answer, claimNext, complete, resume,
  startDirect, startPlan, startPlanning, startPlanningHandoff,
} from "./workflow-v2-store.mjs";

const START_TOOLS = Object.freeze({
  coding_start_direct: {
    description: "Start or idempotently resume a direct Coding run for a reproducible bug or one small feature.",
    fields: { objective: { type: "string", minLength: 1 } },
    run: (cwd, input) => startDirect(cwd, input.objective),
  },
  coding_start_plan: {
    description: "Start or idempotently resume Coding from a validated plan directory or plan.md. The runtime derives the canonical PlanBundle.",
    fields: { plan_path: { type: "string", minLength: 1 } },
    run: (cwd, input) => startPlan(cwd, input.plan_path),
  },
  planning_start: {
    description: "Start or idempotently resume a persistent Planning run from the user's objective.",
    fields: { objective: { type: "string", minLength: 1 } },
    run: (cwd, input) => startPlanning(cwd, input.objective),
  },
  planning_start_handoff: {
    description: "Start Planning from a direct Coding run that requires a Planning handoff.",
    fields: { source_run_id: { type: "string", pattern: "^run_[0-9a-f]{24}$" } },
    run: (cwd, input) => startPlanningHandoff(cwd, input.source_run_id),
  },
});

const STATE_TOOLS = Object.freeze({
  workflow_resume: {
    description: "Resume a run by ID, or auto-resume the unique unfinished run. Multiple unfinished runs return selection_required.",
    fields: { run_id: { type: "string", pattern: "^run_[0-9a-f]{24}$" } }, optional: ["run_id"],
    run: (cwd, input) => resume(cwd, input.run_id),
  },
  workflow_claim_next: {
    description: "Atomically select the next ready action, issue a 30-minute lease, and return its complete dispatch and completion_tool.",
    fields: { run_id: { type: "string", pattern: "^run_[0-9a-f]{24}$" } },
    run: (cwd, input) => claimNext(cwd, input.run_id),
  },
  workflow_answer: {
    description: "Answer the run's single active decision with the user's verbatim answer.",
    fields: { run_id: { type: "string", pattern: "^run_[0-9a-f]{24}$" }, answer: { type: "string", minLength: 1 } },
    run: (cwd, input) => answer(cwd, input.run_id, input.answer),
  },
});

function schema(fields, optional = []) {
  return { type: "object", required: Object.keys(fields).filter((name) => !optional.includes(name)), properties: fields, additionalProperties: false };
}

function payloadFieldSchema(name) {
  if (name.endsWith("_ids") || ["acceptance", "scope_evidence", "changed_paths", "checks", "coverage", "refs", "entry_paths", "direct_dependencies", "facts", "open_decisions", "committed_paths", "fixed_finding_ids", "deleted_paths"].includes(name)) {
    return { type: "array" };
  }
  if (name.endsWith("_ref") || ["open_decision", "drift", "state", "status", "cleanup_evidence", "initial_status", "clean_state", "verification"].includes(name)) return { type: "object" };
  return {};
}

function publicResultField(field, resultContract) {
  if (!field.endsWith("_ref")) return field;
  const kinds = resultContract.required_artifact_kinds ?? [];
  return kinds.find((kind) => field === `${kind}_ref`) ?? (kinds.length === 1 ? kinds[0] : field.slice(0, -4));
}

async function completionTools() {
  const contract = await loadWorkflowContract();
  const names = [...new Set(Object.values(contract.actions)
    .filter((action) => ["coding", "planning"].includes(action.workflow))
    .map((action) => action.io_contract))].sort();
  return names.map((name) => {
    const io = contract.io_contracts[name];
    const payloadFields = [...new Set(Object.values(io.result_contracts).flatMap((result) => [
      ...result.required_fields.map((field) => publicResultField(field, result)),
      ...(result.optional_fields ?? []).map((field) => publicResultField(field, result)),
      ...(result.required_error_fields ?? []),
    ]))];
    const properties = {
      lease_id: { type: "string", pattern: "^lease_[0-9a-f]{32}$" },
      result: { type: "string", enum: Object.keys(io.result_contracts) },
      summary: { type: "string", minLength: 1 },
      ...Object.fromEntries(payloadFields.map((field) => [field, payloadFieldSchema(field)])),
    };
    return {
      name: `workflow_complete_${name}`,
      description: `Complete the leased ${name} action. Run, action, attempt, upstream refs, receipts, and artifacts are derived by the runtime.`,
      inputSchema: schema(properties, payloadFields),
    };
  });
}

async function tools() {
  const fixed = [...Object.entries({ ...START_TOOLS, ...STATE_TOOLS })].map(([name, tool]) => ({
    name, description: tool.description, inputSchema: schema(tool.fields, tool.optional),
  }));
  return [...fixed, ...await completionTools()];
}

function validateShape(input, fields, optional = []) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new WorkflowBusinessError("correction_required", "tool arguments must be an object");
  const allowed = Object.keys(fields);
  const extra = Object.keys(input).filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !optional.includes(key) && input[key] === undefined);
  if (extra.length || missing.length) throw new WorkflowBusinessError("correction_required", "tool arguments do not match the public interface", { extra, missing });
}

export async function dispatchWorkflowTool(name, input, context = {}) {
  const cwd = context.cwd ?? process.cwd();
  const fixed = { ...START_TOOLS, ...STATE_TOOLS }[name];
  if (fixed) {
    validateShape(input, fixed.fields, fixed.optional);
    return fixed.run(cwd, input);
  }
  if (name.startsWith("workflow_complete_")) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new WorkflowBusinessError("correction_required", "tool arguments must be an object");
    const contractName = name.slice("workflow_complete_".length);
    const known = (await completionTools()).some((tool) => tool.name === name);
    if (!known) throw new WorkflowBusinessError("correction_required", "completion tool is not declared");
    return complete(cwd, contractName, input);
  }
  throw new WorkflowBusinessError("correction_required", "workflow tool is not declared");
}

function protocolError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }
function toolResult(id, result, isError = false) {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }], isError } };
}

export async function handleBrokerRequest(request, context = {}) {
  const id = request?.id ?? null;
  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") return protocolError(id, -32600, "Invalid Request");
  if (request.method === "initialize") return { jsonrpc: "2.0", id, result: { protocolVersion: request.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "ai-work-flow", version: "2" } } };
  if (request.method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (request.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: await tools() } };
  if (request.method === "notifications/initialized") return null;
  if (request.method !== "tools/call") return protocolError(id, -32601, "Method not found");
  if (typeof request.params?.name !== "string") return toolResult(id, { status: "correction_required", message: "tool name is required" });
  try {
    return toolResult(id, await dispatchWorkflowTool(request.params.name, request.params.arguments, context));
  } catch (error) {
    if (error instanceof WorkflowBusinessError) return toolResult(id, { status: error.status, message: error.message, ...error.details });
    return toolResult(id, { status: "failed", fatal: true, message: error.message }, true);
  }
}

export async function workflowTools() { return tools(); }
