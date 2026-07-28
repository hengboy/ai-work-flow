import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { checkpointPath, sourceSpecPath } from "./paths.mjs";
import { toShanghaiTimestamp } from "./time.mjs";
import { assertCheckpoint } from "./validation.mjs";
import { assertReviewCoverage, assertReviewManifest } from "./review-manifest.mjs";

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;

function assertRelativeRepositoryPath(path, field) {
  if (typeof path !== "string" || path.length === 0 || /[\\\u0000-\u001f\u007f]/.test(path) || isAbsolute(path) || WINDOWS_ABSOLUTE_PATH.test(path)) {
    throw new Error(`${field} must be a non-empty repository-relative path`);
  }
  if (path !== "." && path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${field} must not contain relative traversal segments`);
  }
  return path;
}

export function repositoryRelativePath(repository, path) {
  if (typeof path !== "string" || path.length === 0 || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error("Checkpoint path must be a non-empty path without control characters");
  }
  if (WINDOWS_ABSOLUTE_PATH.test(path) && !isAbsolute(path)) {
    throw new Error("Checkpoint paths must use the host platform path format");
  }
  const root = resolve(repository);
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path);
  return assertRelativeRepositoryPath(relative(root, target).split(sep).join("/") || ".", "Checkpoint path");
}

export function resolveRepositoryPath(repository, path) {
  return resolve(resolve(repository), repositoryRelativePath(repository, path));
}

export function createCheckpoint({ executionPlan, baseline, branch, worktree, repository = worktree, now = new Date() }) {
  now = toShanghaiTimestamp(now);
  return assertCheckpoint({
    version: 1,
    spec: { path: sourceSpecPath(executionPlan.spec.feature_slug), revision: executionPlan.revision },
    status: "executing",
    baseline,
    branch,
    worktree: repositoryRelativePath(repository, worktree),
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
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
  await rename(temporaryPath, path);
  return path;
}

export async function readCheckpoint(worktree, featureSlug) {
  return verifyCheckpointShape(JSON.parse(await readFile(join(worktree, checkpointPath(featureSlug)), "utf8")));
}

export function verifyCheckpointShape(checkpoint) {
  assertCheckpoint(checkpoint);
  assertRelativeRepositoryPath(checkpoint.worktree, "Checkpoint worktree");
  if (checkpoint.integration?.main_worktree) assertRelativeRepositoryPath(checkpoint.integration.main_worktree, "Checkpoint main worktree");
  return checkpoint;
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

export function startTickets(checkpoint, ticketIds, startCommit, { claimId = "test-claim", expectedRoleId = "full-stack-coder", sessionId = "test-session" } = {}, now = new Date()) {
  now = toShanghaiTimestamp(now);
  if (ticketIds.length !== 1) throw new Error("Exactly one pending ticket can be started at a time");
  if (![claimId, expectedRoleId, sessionId].every((value) => typeof value === "string" && value.length > 0)) {
    throw new Error("Ticket claim requires claim ID, expected role ID, and session ID");
  }
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
  nextTicket.claim_id = claimId;
  nextTicket.expected_role_id = expectedRoleId;
  nextTicket.session_id = sessionId;
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

export function relocateCheckpoint(checkpoint, worktree, now = new Date(), repository = worktree) {
  now = toShanghaiTimestamp(now);
  const relativeWorktree = repositoryRelativePath(repository, worktree);
  const next = revise(checkpoint, "worktree-relocated", relativeWorktree, now);
  next.worktree = relativeWorktree;
  return completeTransition(next);
}

export function beginReview(checkpoint, { fixedPoint, reviewCommit, manifest }, now = new Date()) {
  now = toShanghaiTimestamp(now);
  if (checkpoint.status !== "executing" || checkpoint.review.status !== "pending") {
    throw new Error("Review can only begin from a pending execution review");
  }
  if (checkpoint.tickets.some((ticket) => ticket.status !== "done")) {
    throw new Error("Cannot begin review while tickets are not done");
  }
  if (fixedPoint !== checkpoint.baseline) throw new Error("Review fixed point must match the execution baseline");
  manifest = assertReviewManifest(manifest);
  if (manifest.fixed_point !== fixedPoint || manifest.review_commit !== reviewCommit) {
    throw new Error("ReviewManifest endpoints must match the frozen review endpoints");
  }
  const next = revise(checkpoint, "reviewing", "final review started", now);
  next.status = "reviewing";
  next.review = { status: "in_progress", fixed_point: fixedPoint, review_commit: reviewCommit, manifest, started_at: now };
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

export function recordReview(checkpoint, { manifestDigest, coverage, findingsSummary }, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "review-recorded", findingsSummary, now);
  if (!['in_progress', 'awaiting_user'].includes(next.review.status)) throw new Error("Review is not in progress");
  if (manifestDigest !== next.review.manifest.manifest_digest) throw new Error("Review result manifest digest does not match the frozen ReviewManifest");
  assertReviewCoverage(next.review.manifest, coverage);
  next.review = { ...next.review, status: "awaiting_user", manifest_digest: manifestDigest, coverage, findings_summary: findingsSummary, completed_at: now };
  return completeTransition(next);
}

export function decideReview(checkpoint, decision, now = new Date()) {
  now = toShanghaiTimestamp(now);
  if (!["approve", "fix"].includes(decision)) throw new Error("Review decision must be approve or fix");
  const next = revise(checkpoint, "review-decision", decision, now);
  if (next.review.status !== "awaiting_user") throw new Error("Review is not awaiting a user decision");
  next.review = { ...next.review, status: "done", decision };
  next.status = decision === "approve" ? "integrating" : "fixing";
  return completeTransition(next);
}

export function completeReviewFix(checkpoint, { fixCommit, checks }, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "review-fix-completed", "user-approved review fixes completed", now);
  if (next.status !== "fixing" || next.review.status !== "done" || next.review.decision !== "fix") {
    throw new Error("A user-approved review fix is required before integration");
  }
  next.review = { ...next.review, fix_commit: fixCommit, fix_checks: checks };
  next.status = "integrating";
  return completeTransition(next);
}

export function markMerged(checkpoint, { executionHead, mainWorktree, mergedCommit, stashRef, repository = mainWorktree }, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "merged", mergedCommit, now);
  if (next.status !== "integrating") throw new Error("Checkpoint is not integrating");
  const persistedStashRef = stashRef ?? next.integration.stash_ref;
  next.integration = {
    status: "merged",
    target_branch: "main",
    execution_head: executionHead,
    main_worktree: repositoryRelativePath(repository, mainWorktree),
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

export function authorizeStash(checkpoint, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "stash-authorized", "explicit integrate --allow-stash true", now);
  if (next.status !== "integrating" || next.integration.status !== "pending") {
    throw new Error("A pending integration is required to authorize a stash operation");
  }
  next.integration = { ...next.integration, stash_authorized: true };
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
