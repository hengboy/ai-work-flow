import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkpointPath, sourcePlanPath } from "./paths.mjs";
import { toShanghaiTimestamp } from "./time.mjs";
import { assertCheckpoint } from "./validation.mjs";

export function createCheckpoint({ executionPlan, baseline, branch, worktree, now = new Date() }) {
  now = toShanghaiTimestamp(now);
  return {
    version: 1,
    plan: { path: sourcePlanPath(executionPlan.plan.plan_id), revision: executionPlan.revision },
    status: "executing",
    baseline,
    branch,
    worktree,
    created_at: now,
    updated_at: now,
    tasks: executionPlan.tasks.map((task) => ({ id: task.id, status: "pending" })),
    review: { status: "pending" },
    integration: { status: "pending", target_branch: "main" },
    history: [{ event: "initialized", detail: "Execution plan materialized", at: now }],
  };
}

export async function writeCheckpoint(worktree, planId, checkpoint) {
  verifyCheckpointShape(checkpoint);
  const path = join(worktree, checkpointPath(planId));
  await mkdir(join(worktree, ".ai-work-flow", "plans", planId), { recursive: true });
  await writeFile(path, `${JSON.stringify(checkpoint, null, 2)}\n`);
  return path;
}

export async function readCheckpoint(worktree, planId) {
  return verifyCheckpointShape(JSON.parse(await readFile(join(worktree, checkpointPath(planId)), "utf8")));
}

export function verifyCheckpointShape(checkpoint) {
  return assertCheckpoint(checkpoint);
}

function revise(checkpoint, event, detail, now) {
  const next = structuredClone(checkpoint);
  next.updated_at = now;
  next.history.push({ event, detail, at: now });
  return next;
}

export function startTasks(checkpoint, taskIds, startCommit, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "dispatched", taskIds.join(", "), now);
  for (const task of next.tasks) {
    if (taskIds.includes(task.id)) {
      if (task.status !== "pending") throw new Error(`Task ${task.id} is not pending`);
      task.status = "in_progress";
      task.start_commit = startCommit;
      task.started_at = now;
    }
  }
  return next;
}

export function completeTask(checkpoint, taskId, endCommit, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "done", taskId, now);
  const task = next.tasks.find((candidate) => candidate.id === taskId);
  if (!task || task.status !== "in_progress") throw new Error(`Task ${taskId} is not in progress`);
  task.status = "done";
  task.end_commit = endCommit;
  task.completed_at = now;
  delete task.error;
  return next;
}

export function blockTask(checkpoint, taskId, error, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "blocked", taskId, now);
  const task = next.tasks.find((candidate) => candidate.id === taskId);
  if (!task || task.status !== "in_progress") throw new Error(`Task ${taskId} is not in progress`);
  task.status = "blocked";
  task.error = error;
  return next;
}

export function relocateCheckpoint(checkpoint, worktree, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "worktree-relocated", worktree, now);
  next.worktree = worktree;
  return next;
}

export function beginReview(checkpoint, now = new Date()) {
  now = toShanghaiTimestamp(now);
  if (checkpoint.tasks.some((task) => task.status !== "done")) {
    throw new Error("Cannot begin review while tasks are not done");
  }
  const next = revise(checkpoint, "reviewing", "final review started", now);
  next.status = "reviewing";
  next.review = { status: "in_progress", started_at: now };
  return next;
}

export function completeReview(checkpoint, findingsSummary, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "reviewed", findingsSummary, now);
  if (next.review.status !== "in_progress") throw new Error("Review is not in progress");
  next.review = { ...next.review, status: "done", findings_summary: findingsSummary, completed_at: now };
  next.status = "integrating";
  return next;
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
  return next;
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
  return next;
}

export function recordStashReference(checkpoint, stashRef, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "stash-created", stashRef, now);
  if (next.status !== "integrating" || next.integration.status !== "pending" || !next.integration.stash_operation_id) {
    throw new Error("A recorded stash operation is required to record its reference");
  }
  if (next.integration.stash_ref) throw new Error("A stash reference is already recorded");
  next.integration = { ...next.integration, stash_ref: stashRef };
  return next;
}

export function beginStashRestoration(checkpoint, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "stash-restoration-started", "unrelated main worktree changes will be restored", now);
  if (!next.integration.stash_ref) throw new Error("No stash reference is available to restore");
  if (next.integration.stash_restore_state === "applying") throw new Error("Stash restoration is already in progress");
  if (next.integration.stash_restore_state === "restored") throw new Error("Stash has already been restored");
  next.integration = { ...next.integration, stash_restore_state: "applying" };
  return next;
}

export function markStashRestored(checkpoint, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "stash-restored", "unrelated main worktree changes restored", now);
  if (!next.integration.stash_ref || next.integration.stash_restore_state !== "applying") {
    throw new Error("A started stash restoration is required");
  }
  next.integration = { ...next.integration, stash_restore_state: "restored", stash_restored: true, stash_cleanup_state: "pending" };
  return next;
}

export function markRestoredStashDropped(checkpoint, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "stash-dropped", "restored stash entry removed", now);
  if (next.integration.stash_restore_state !== "restored" || next.integration.stash_cleanup_state !== "pending") {
    throw new Error("A restored stash pending cleanup is required");
  }
  next.integration = { ...next.integration, stash_cleanup_state: "dropped" };
  return next;
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
  return next;
}

export function completeIntegration(checkpoint, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "complete", "execution worktree removed", now);
  if (next.integration.status !== "merged") throw new Error("Execution branch has not been merged");
  if (next.integration.stash_restore_state === "applying") throw new Error("Stash restoration is still applying");
  if (next.integration.stash_restore_state === "restored" && next.integration.stash_cleanup_state !== "dropped") {
    throw new Error("Restored stash cleanup is not complete");
  }
  next.integration = { ...next.integration, status: "done", cleaned_up_at: now };
  next.status = "complete";
  return next;
}
