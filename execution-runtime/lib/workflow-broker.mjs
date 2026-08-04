import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

import { createArtifact, verifyArtifact } from "./artifact-store.mjs";
import { createReviewPacket, verifyReviewPacket } from "./review-packet.mjs";
import { loadWorkflowContract } from "./workflow-contract.mjs";
import { claimAction, finishAction, recoverAction, resolveDecision, startRun, statusRun } from "./workflow-store.mjs";

const execFileAsync = promisify(execFile);
const TOOL_NAME = "workflow_state";
const OPERATIONS = new Set([
  "start", "status", "claim", "finish", "recover", "decide",
  "artifact_create", "artifact_verify", "review_packet_create", "review_packet_verify", "contract",
]);
const OPERATION_FIELDS = Object.freeze({
  start: ["operation", "repository", "kind", "plan_digest", "task_mode"],
  status: ["operation", "repository", "run_id", "action_id"],
  claim: ["operation", "repository", "run_id", "action_id", "claimant"],
  finish: ["operation", "repository", "receipt"],
  recover: ["operation", "repository", "run_id", "action_id"],
  decide: ["operation", "repository", "run_id", "decision"],
  artifact_create: ["operation", "repository", "run_id", "kind", "content"],
  artifact_verify: ["operation", "repository", "run_id", "ref"],
  review_packet_create: ["operation", "repository", "run_id", "packet"],
  review_packet_verify: ["operation", "repository", "run_id", "ref"],
  contract: ["operation"],
});

const TOOL = Object.freeze({
  name: TOOL_NAME,
  description: "Read or update the current repository AI Work Flow run through fixed runtime operations.",
  inputSchema: {
    type: "object",
    required: ["operation"],
    properties: {
      operation: { type: "string", enum: [...OPERATIONS] },
      repository: { type: "string" },
      run_id: { type: "string" },
      action_id: { type: "string" },
      claimant: { type: "string" },
      kind: { type: "string" },
      plan_digest: { type: "string" },
      task_mode: { type: "string" },
      receipt: { type: "object" },
      decision: { type: "object" },
      content: {},
      ref: { type: "object" },
      packet: { type: "object" },
    },
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
  if (input.operation === "contract") return loadWorkflowContract();
  const repository = await trustedRepository(input.repository, context.cwd ?? process.cwd());
  if (input.operation === "start") return startRun({ repository, kind: input.kind, plan_digest: input.plan_digest, task_mode: input.task_mode });
  if (input.operation === "status") return statusRun({ repository, run_id: input.run_id, action_id: input.action_id });
  if (input.operation === "claim") return claimAction({ repository, run_id: input.run_id, action_id: input.action_id, claimant: input.claimant, owner_pid: context.pid ?? process.pid });
  if (input.operation === "finish") return finishAction({ repository, receipt: input.receipt });
  if (input.operation === "recover") return recoverAction({ repository, run_id: input.run_id, action_id: input.action_id });
  if (input.operation === "decide") return resolveDecision({ repository, run_id: input.run_id, decision: input.decision });
  if (input.operation === "artifact_create") return createArtifact({ repository, run_id: input.run_id, kind: input.kind, content: input.content });
  if (input.operation === "artifact_verify") return verifyArtifact({ repository, run_id: input.run_id, ref: input.ref });
  if (input.operation === "review_packet_create") {
    if (!input.packet || typeof input.packet !== "object" || Array.isArray(input.packet)) throw new Error("review packet input is required");
    return createReviewPacket({ ...input.packet, repository, run_id: input.run_id });
  }
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
