import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

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
  if (!contract || !contract.workflows || !contract.actions) {
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
    if (action.workflow === "support") continue;
    const workflow = contract.workflows[action.workflow];
    if (!workflow || workflow.phase_actions[action.from]?.includes(id) !== true || typeof action.completed_to !== "string") {
      throw new Error(`workflow contract transition is invalid: ${id}`);
    }
  }
  for (const [kind, workflow] of Object.entries(contract.workflows)) {
    for (const ids of Object.values(workflow.phase_actions)) {
      for (const id of ids) if (contract.actions[id]?.workflow !== kind) throw new Error(`workflow ${kind} references invalid action ${id}`);
    }
  }
  return { contract, owners };
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
  const allowed = ["run_id", "action_id", "attempt", "result", "summary", "artifacts", "checks", "error", "decision_request"];
  if (!receipt || Object.keys(receipt).some((key) => !allowed.includes(key)) ||
    typeof receipt.run_id !== "string" || !contract.actions[receipt.action_id] ||
    !Number.isSafeInteger(receipt.attempt) || receipt.attempt < 1 ||
    !contract.receipt_schema.results.includes(receipt.result) ||
    typeof receipt.summary !== "string" || !receipt.summary.trim() ||
    !Array.isArray(receipt.artifacts) || !Array.isArray(receipt.checks) ||
    receipt.checks.some((check) => typeof check !== "string" || !check.trim())) {
    throw new Error("ActionReceipt is invalid");
  }
  receipt.artifacts.forEach(validateArtifactRef);
  if (receipt.result === "needs_decision" && (!receipt.decision_request || typeof receipt.decision_request.code !== "string")) {
    throw new Error("needs_decision receipt requires decision_request");
  }
  return receipt;
}
