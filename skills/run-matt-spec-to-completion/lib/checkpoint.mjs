import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkpointPath, sourceSpecPath } from "./paths.mjs";
import { toShanghaiTimestamp } from "./time.mjs";
import { assertCheckpoint } from "./validation.mjs";

export function createCheckpoint({ executionPlan, baseline, branch, worktree, now = new Date() }) {
  now = toShanghaiTimestamp(now);
  return assertCheckpoint({
    version: 1,
    spec: { path: sourceSpecPath(executionPlan.spec.feature_slug), revision: executionPlan.revision },
    status: "executing",
    baseline,
    branch,
    worktree,
    created_at: now,
    updated_at: now,
    tickets: executionPlan.tickets.map((ticket) => ({ id: ticket.id, status: "pending" })),
    review: { status: "pending" },
    integration: { status: "pending", target_branch: "main" },
    history: [{ event: "initialized", detail: "Execution plan materialized", at: now }],
  });
}

export async function writeCheckpoint(worktree, featureSlug, checkpoint) {
  verifyCheckpointShape(checkpoint);
  const path = join(worktree, checkpointPath(featureSlug));
  await mkdir(join(worktree, ".scratch", featureSlug), { recursive: true });
  await writeFile(path, `${JSON.stringify(checkpoint, null, 2)}\n`);
  return path;
}

export async function readCheckpoint(worktree, featureSlug) {
  return verifyCheckpointShape(JSON.parse(await readFile(join(worktree, checkpointPath(featureSlug)), "utf8")));
}

export function verifyCheckpointShape(checkpoint) {
  return assertCheckpoint(checkpoint);
}

function revise(checkpoint, event, detail, now) {
  assertCheckpoint(checkpoint);
  const next = structuredClone(checkpoint);
  next.updated_at = now;
  next.history.push({ event, detail, at: now });
  return completeTransition(next);
}

function completeTransition(checkpoint) {
  return assertCheckpoint(checkpoint);
}

export function startTickets(checkpoint, ticketIds, startCommit, now = new Date()) {
  now = toShanghaiTimestamp(now);
  if (ticketIds.length !== 1) throw new Error("Exactly one pending ticket can be started at a time");
  const [ticketId] = ticketIds;
  if (checkpoint.tickets.some((ticket) => ticket.status === "in_progress")) {
    throw new Error("Cannot start a ticket while another ticket is in progress");
  }
  const ticket = checkpoint.tickets.find((candidate) => candidate.id === ticketId);
  if (!ticket || ticket.status !== "pending") throw new Error(`Ticket ${ticketId} is not pending`);
  const next = revise(checkpoint, "dispatched", ticketIds.join(", "), now);
  const nextTicket = next.tickets.find((candidate) => candidate.id === ticketId);
  nextTicket.status = "in_progress";
  nextTicket.start_commit = startCommit;
  nextTicket.started_at = now;
  return completeTransition(next);
}

export function completeTicket(checkpoint, ticketId, endCommit, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "done", ticketId, now);
  const ticket = next.tickets.find((candidate) => candidate.id === ticketId);
  if (!ticket || ticket.status !== "in_progress") throw new Error(`Ticket ${ticketId} is not in progress`);
  ticket.status = "done";
  ticket.end_commit = endCommit;
  ticket.completed_at = now;
  delete ticket.error;
  return completeTransition(next);
}

export function blockTicket(checkpoint, ticketId, error, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "blocked", ticketId, now);
  const ticket = next.tickets.find((candidate) => candidate.id === ticketId);
  if (!ticket || ticket.status !== "in_progress") throw new Error(`Ticket ${ticketId} is not in progress`);
  ticket.status = "blocked";
  ticket.error = error;
  return completeTransition(next);
}

export function relocateCheckpoint(checkpoint, worktree, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "worktree-relocated", worktree, now);
  next.worktree = worktree;
  return completeTransition(next);
}

export function beginReview(checkpoint, now = new Date()) {
  now = toShanghaiTimestamp(now);
  if (checkpoint.tickets.some((ticket) => ticket.status !== "done")) {
    throw new Error("Cannot begin review while tickets are not done");
  }
  const next = revise(checkpoint, "reviewing", "final review started", now);
  next.status = "reviewing";
  next.review = { status: "in_progress", started_at: now };
  return completeTransition(next);
}

export function completeReview(checkpoint, findingsSummary, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "reviewed", findingsSummary, now);
  if (next.review.status !== "in_progress") throw new Error("Review is not in progress");
  next.review = { ...next.review, status: "done", findings_summary: findingsSummary, completed_at: now };
  next.status = "integrating";
  return completeTransition(next);
}

export function markMerged(checkpoint, { executionHead, mainWorktree, mergedCommit, stashRef }, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "merged", mergedCommit, now);
  if (next.status !== "integrating") throw new Error("Checkpoint is not integrating");
  const persistedStashRef = stashRef ?? next.integration.stash_ref;
  next.integration = {
    status: "merged",
    target_branch: "main",
    execution_head: executionHead,
    main_worktree: mainWorktree,
    merged_commit: mergedCommit,
    merged_at: now,
    ...(next.integration.stash_operation_id ? { stash_operation_id: next.integration.stash_operation_id } : {}),
    ...(persistedStashRef ? { stash_ref: persistedStashRef } : {}),
    ...(next.integration.stash_restore_state ? { stash_restore_state: next.integration.stash_restore_state } : {}),
    ...(next.integration.stash_restored ? { stash_restored: true } : {}),
    ...(next.integration.stash_cleanup_state ? { stash_cleanup_state: next.integration.stash_cleanup_state } : {}),
  };
  return completeTransition(next);
}

export function beginStashOperation(checkpoint, operationId, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "stash-operation-started", operationId, now);
  if (next.status !== "integrating" || next.integration.status !== "pending") {
    throw new Error("A pending integration is required to start a stash operation");
  }
  if (next.integration.stash_ref || next.integration.stash_operation_id) {
    throw new Error("A stash operation is already recorded");
  }
  next.integration = { ...next.integration, stash_operation_id: operationId };
  return completeTransition(next);
}

export function recordStashReference(checkpoint, stashRef, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "stash-created", stashRef, now);
  if (next.status !== "integrating" || next.integration.status !== "pending" || !next.integration.stash_operation_id) {
    throw new Error("A recorded stash operation is required to record its reference");
  }
  if (next.integration.stash_ref) throw new Error("A stash reference is already recorded");
  next.integration = { ...next.integration, stash_ref: stashRef };
  return completeTransition(next);
}

export function beginStashRestoration(checkpoint, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "stash-restoration-started", "unrelated main worktree changes will be restored", now);
  if (!next.integration.stash_ref) throw new Error("No stash reference is available to restore");
  if (next.integration.stash_restore_state === "applying") throw new Error("Stash restoration is already in progress");
  if (next.integration.stash_restore_state === "restored") throw new Error("Stash has already been restored");
  next.integration = { ...next.integration, stash_restore_state: "applying" };
  return completeTransition(next);
}

export function markStashRestored(checkpoint, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "stash-restored", "unrelated main worktree changes restored", now);
  if (!next.integration.stash_ref || next.integration.stash_restore_state !== "applying") {
    throw new Error("A started stash restoration is required");
  }
  next.integration = { ...next.integration, stash_restore_state: "restored", stash_restored: true, stash_cleanup_state: "pending" };
  return completeTransition(next);
}

export function markRestoredStashDropped(checkpoint, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "stash-dropped", "restored stash entry removed", now);
  if (next.integration.stash_restore_state !== "restored" || next.integration.stash_cleanup_state !== "pending") {
    throw new Error("A restored stash pending cleanup is required");
  }
  next.integration = { ...next.integration, stash_cleanup_state: "dropped" };
  return completeTransition(next);
}

export function clearRestoredStashReference(checkpoint, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "stash-restored", "unrelated main worktree changes restored after merge failure", now);
  if (next.status !== "integrating" || next.integration.status !== "pending" || next.integration.stash_restore_state !== "restored") {
    throw new Error("A pending integration is required to clear a restored stash reference");
  }
  const { stash_ref, stash_operation_id, stash_restore_state, stash_restored, stash_cleanup_state, ...integration } = next.integration;
  if (!stash_ref) throw new Error("No stash reference is available to clear");
  next.integration = integration;
  return completeTransition(next);
}

export function completeIntegration(checkpoint, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "complete", "feature worktree removed", now);
  if (next.integration.status !== "merged") throw new Error("Feature branch has not been merged");
  if (next.integration.stash_restore_state === "applying") throw new Error("Stash restoration is still applying");
  if (next.integration.stash_restore_state === "restored" && next.integration.stash_cleanup_state !== "dropped") {
    throw new Error("Restored stash cleanup is not complete");
  }
  next.integration = { ...next.integration, status: "done", cleaned_up_at: now };
  next.status = "complete";
  return completeTransition(next);
}
