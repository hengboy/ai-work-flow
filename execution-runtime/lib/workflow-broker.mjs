import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

import { createArtifact, verifyArtifact } from "./artifact-store.mjs";
import { createReviewPacket, verifyReviewPacket } from "./review-packet.mjs";
import { loadWorkflowContract } from "./workflow-contract.mjs";
import { claimAction, finishAction, recoverAction, resolveDecision, startRun, statusRepository, statusRun, validateSupportAction } from "./workflow-store.mjs";

const execFileAsync = promisify(execFile);
const TOOL_NAME = "workflow_state";
const OPERATIONS = new Set([
  "start", "status", "claim", "finish", "recover", "decide",
  "artifact_create", "artifact_verify", "review_packet_create", "review_packet_verify", "contract",
  "support_validate",
]);
const OPERATION_FIELDS = Object.freeze({
  start: ["operation", "repository", "kind", "plan_digest", "task_mode", "request", "source_run_id"],
  status: ["operation", "repository", "run_id", "action_id", "kind"],
  claim: ["operation", "repository", "run_id", "action_id", "claimant", "input"],
  finish: ["operation", "repository", "receipt"],
  recover: ["operation", "repository", "run_id", "action_id"],
  decide: ["operation", "repository", "run_id", "answer", "decision"],
  artifact_create: ["operation", "repository", "run_id", "kind", "content"],
  artifact_verify: ["operation", "repository", "run_id", "ref"],
  review_packet_create: ["operation", "repository", "run_id", "packet"],
  review_packet_verify: ["operation", "repository", "run_id", "ref"],
  support_validate: ["operation", "repository", "caller_ref", "input", "receipt"],
  contract: ["operation"],
});
const OPERATION_REQUIRED_FIELDS = Object.freeze({
  start: ["operation", "repository", "kind"],
  status: ["operation", "repository"],
  claim: ["operation", "repository", "run_id", "action_id", "claimant", "input"],
  finish: ["operation", "repository", "receipt"],
  recover: ["operation", "repository", "run_id", "action_id"],
  decide: ["operation", "repository", "run_id"],
  artifact_create: ["operation", "repository", "run_id", "kind", "content"],
  artifact_verify: ["operation", "repository", "run_id", "ref"],
  review_packet_create: ["operation", "repository", "run_id", "packet"],
  review_packet_verify: ["operation", "repository", "run_id", "ref"],
  support_validate: ["operation", "repository", "caller_ref", "input", "receipt"],
  contract: ["operation"],
});

const ACTION_RECEIPT_SCHEMA = Object.freeze({
  type: "object",
  required: ["run_id", "action_id", "attempt", "result", "summary", "outputs", "artifacts", "checks"],
  properties: {
    run_id: { type: "string" },
    action_id: { type: "string" },
    attempt: { type: "integer", minimum: 1 },
    result: { type: "string", enum: ["completed", "retryable_failure", "needs_decision", "failed"] },
    summary: { type: "string", minLength: 1 },
    outputs: { type: "object" },
    artifacts: { type: "array", items: { type: "object" } },
    checks: { type: "array", items: { type: "string", minLength: 1 } },
    error: { type: "object" },
    decision_request: { type: "object" },
  },
  additionalProperties: false,
});

const SUPPORT_RECEIPT_SCHEMA = Object.freeze({
  type: "object",
  required: ["run_id", "caller_ref", "call_id", "action_id", "result", "summary", "outputs", "artifacts", "checks"],
  properties: {
    run_id: { type: "string" },
    caller_ref: { type: "string" },
    call_id: { type: "string", pattern: "^[A-Za-z0-9._:-]{8,128}$" },
    action_id: { type: "string" },
    result: { type: "string", enum: ["completed", "needs_decision", "failed"] },
    summary: { type: "string", minLength: 1 },
    outputs: { type: "object" },
    artifacts: { type: "array", items: { type: "object" } },
    checks: { type: "array", items: { type: "string", minLength: 1 } },
    error: { type: "object" },
    decision_request: { type: "object" },
  },
  additionalProperties: false,
});

const DECISION_SCHEMA = Object.freeze({
  type: "object",
  description: "Resolution for the active snapshot decision_request. Copy its code exactly and put the verbatim user answer in summary.",
  required: ["code", "summary"],
  properties: {
    code: { type: "string", minLength: 1, description: "Exact code from the active snapshot decision_request." },
    summary: { type: "string", minLength: 1, description: "Verbatim user answer, including an option ID or custom answer when applicable." },
  },
  additionalProperties: false,
});

function operationConstraint(operation) {
  const constraint = {
    if: { properties: { operation: { const: operation } }, required: ["operation"] },
    then: {
      required: OPERATION_REQUIRED_FIELDS[operation],
      propertyNames: { enum: OPERATION_FIELDS[operation] },
    },
  };
  if (operation === "contract") constraint.then.maxProperties = 1;
  if (operation === "start") {
    const without = (...fields) => ({ not: { anyOf: fields.map((field) => ({ required: [field] })) } });
    constraint.then.anyOf = [
      {
        properties: { kind: { const: "coding" }, plan_digest: { pattern: "^[0-9a-f]{64}$" } },
        required: ["plan_digest", "task_mode"],
        ...without("request"),
      },
      {
        properties: { kind: { const: "coding" } },
        required: ["request"],
        ...without("plan_digest", "task_mode"),
      },
      {
        properties: { kind: { const: "planning" } },
        required: ["request"],
        ...without("plan_digest", "task_mode", "source_run_id"),
      },
      {
        properties: { kind: { const: "planning" } },
        required: ["source_run_id"],
        ...without("plan_digest", "task_mode", "request"),
      },
      {
        properties: { kind: { not: { enum: ["coding", "planning"] } }, plan_digest: { pattern: "^[0-9a-f]{64}$" } },
        required: ["plan_digest"],
        ...without("request", "task_mode"),
      },
    ];
  }
  if (operation === "status") {
    constraint.then.anyOf = [
      { required: ["run_id"], not: { required: ["kind"] } },
      { not: { anyOf: [{ required: ["run_id"] }, { required: ["action_id"] }] } },
    ];
  }
  if (operation === "finish") constraint.then.properties = { receipt: ACTION_RECEIPT_SCHEMA };
  if (operation === "decide") {
    constraint.then.properties = { decision: DECISION_SCHEMA };
    constraint.then.anyOf = [
      { required: ["answer"], not: { required: ["decision"] } },
      { required: ["decision"], not: { required: ["answer"] } },
    ];
  }
  if (operation === "support_validate") constraint.then.properties = { receipt: SUPPORT_RECEIPT_SCHEMA };
  return constraint;
}

const TOOL = Object.freeze({
  name: TOOL_NAME,
  description: "Read or update AI Work Flow state through fixed operations. finish takes exactly {operation:'finish', repository, receipt}; run_id and action_id belong inside the ActionReceipt, never at the top level. status with repository and optional kind lists repository runs; add run_id for one canonical snapshot. Prefer the flat decide form with answer=<verbatim user answer>; the legacy decision={code:<exact active code>,summary:<verbatim user answer>} form remains supported. A terminal PLANNING_REQUIRED is not decidable: start planning with kind='planning' and source_run_id=<coding run_id>. recover only releases a stale active claim; never use it for a finished action awaiting a decision. contract takes exactly {operation:'contract'} with no repository or kind. support_validate requires repository, caller_ref, input, and receipt tied to an active parent claim; it must never validate pre-run discovery. Planning start requires repository, kind='planning', and exactly one of request={objective:<verbatim user request>} or source_run_id=<PLANNING_REQUIRED coding run>. Plan-based coding start requires repository, kind='coding', plan_digest, and task_mode. Direct Bug or small-feature coding start instead requires repository, kind='coding', and request={objective:<verbatim user request>}; do not mix request with plan fields.",
  inputSchema: {
    type: "object",
    required: ["operation"],
    properties: {
      operation: { type: "string", enum: [...OPERATIONS], description: "Fixed broker operation. Use contract alone to inspect the installed runtime contract." },
      repository: { type: "string", description: "Repository root. Required for every operation except contract." },
      run_id: { type: "string", description: "Run ID. Omit for contract and repository-level status discovery." },
      action_id: { type: "string" },
      claimant: { type: "string" },
      kind: { type: "string", description: "Workflow kind for start or repository-level status filtering, such as coding; never a role, support action, or I/O contract name." },
      plan_digest: { type: "string", description: "Verified lowercase SHA-256 plan digest for start." },
      task_mode: { type: "string", enum: ["single", "split"], description: "Required only by plan-based coding start." },
      source_run_id: { type: "string", pattern: "^run_[0-9a-f]{24}$", description: "For planning start only: a terminal direct coding run whose decision_request code is PLANNING_REQUIRED. The planning objective is inherited from that run." },
      request: {
        type: "object",
        description: "Verbatim user request. Required for planning start and for direct Bug or small-feature coding start; do not mix with plan_digest/task_mode.",
        required: ["objective"],
        properties: { objective: { type: "string", minLength: 1 } },
        additionalProperties: false,
      },
      receipt: { type: "object", description: "ActionReceipt for finish or SupportReceipt for support_validate; the operation-specific schema defines its fields." },
      input: { type: "object", description: "Canonical claim input, or the original support input for support_validate." },
      caller_ref: { type: "string", description: "Active parent claim ID for support_validate only." },
      answer: { type: "string", minLength: 1, description: "Preferred flat decide input: the verbatim user answer to the active decision_request, such as an option ID or custom answer." },
      decision: DECISION_SCHEMA,
      content: {},
      ref: { type: "object" },
      packet: { type: "object" },
    },
    allOf: [...OPERATIONS].map(operationConstraint),
    additionalProperties: false,
  },
});

async function gitRoot(path) {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: path, encoding: "utf8" });
  return realpath(stdout.trim());
}

async function trustedRepository(repository, cwd) {
  if (typeof repository !== "string" || !repository) throw new Error("repository is required");
  const [requested, current] = await Promise.all([gitRoot(repository), gitRoot(cwd)]);
  if (requested !== current) throw new Error("workflow broker only accepts the current repository");
  return requested;
}

export async function dispatchWorkflowState(input, context = {}) {
  if (!input || !OPERATIONS.has(input.operation)) throw new Error("workflow broker operation is invalid");
  const allowed = OPERATION_FIELDS[input.operation];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new Error("workflow broker input contains an unsupported field");
  if (input.operation === "contract") {
    const contract = await loadWorkflowContract();
    return { ...contract, broker: { tool_name: TOOL_NAME, input_schema: structuredClone(TOOL.inputSchema) } };
  }
  const repository = await trustedRepository(input.repository, context.cwd ?? process.cwd());
  if (input.operation === "start") return startRun({ repository, kind: input.kind, plan_digest: input.plan_digest, task_mode: input.task_mode, request: input.request, source_run_id: input.source_run_id });
  if (input.operation === "status") {
    if (!input.run_id) {
      if (input.action_id) throw new Error("repository status does not accept action_id without run_id");
      return statusRepository({ repository, kind: input.kind });
    }
    if (input.kind) throw new Error("run status does not accept kind with run_id");
    return statusRun({ repository, run_id: input.run_id, action_id: input.action_id });
  }
  if (input.operation === "claim") return claimAction({ repository, run_id: input.run_id, action_id: input.action_id, claimant: input.claimant, owner_pid: context.pid ?? process.pid, input: input.input });
  if (input.operation === "finish") return finishAction({ repository, receipt: input.receipt });
  if (input.operation === "recover") return recoverAction({ repository, run_id: input.run_id, action_id: input.action_id });
  if (input.operation === "decide") return resolveDecision({ repository, run_id: input.run_id, answer: input.answer, decision: input.decision });
  if (input.operation === "artifact_create") return createArtifact({ repository, run_id: input.run_id, kind: input.kind, content: input.content });
  if (input.operation === "artifact_verify") return verifyArtifact({ repository, run_id: input.run_id, ref: input.ref });
  if (input.operation === "review_packet_create") {
    if (!input.packet || typeof input.packet !== "object" || Array.isArray(input.packet)) throw new Error("review packet input is required");
    return createReviewPacket({ ...input.packet, repository, run_id: input.run_id });
  }
  if (input.operation === "support_validate") return validateSupportAction({ repository, caller_ref: input.caller_ref, input: input.input, receipt: input.receipt });
  return verifyReviewPacket({ repository, run_id: input.run_id, ref: input.ref });
}

function error(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export async function handleBrokerRequest(request, context) {
  const id = request?.id ?? null;
  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") return error(id, -32600, "Invalid Request");
  if (request.method === "initialize") {
    return { jsonrpc: "2.0", id, result: { protocolVersion: request.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "ai-work-flow", version: "1" } } };
  }
  if (request.method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (request.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: [TOOL] } };
  if (request.method === "notifications/initialized") return null;
  if (request.method !== "tools/call") return error(id, -32601, "Method not found");
  if (request.params?.name !== TOOL_NAME || !request.params.arguments || typeof request.params.arguments !== "object") return error(id, -32602, "Invalid tool call");
  try {
    const result = await dispatchWorkflowState(request.params.arguments, context);
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }], isError: false } };
  } catch (cause) {
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: cause.message }], isError: true } };
  }
}
