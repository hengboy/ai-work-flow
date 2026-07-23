import { readExecutionPlan, verifyExecutionPlan } from "./execution-plan.mjs";
import { readCheckpoint, verifyCheckpointShape } from "./checkpoint.mjs";
import { git, gitSucceeds, isAncestor } from "./git.mjs";
import { sourcePlanPath } from "./paths.mjs";
import { resolve } from "node:path";

function diagnostic(code, detail) {
  return { code, detail };
}

export async function verifyCheckpointIntegrity({ worktree, executionWorktree, planId, checkExecutionWorktree = true, allowWorktreeRelocation = false }) {
  const diagnostics = [];
  let executionPlan;
  let checkpoint;
  try {
    executionPlan = verifyExecutionPlan(await readExecutionPlan(worktree, planId));
  } catch (error) {
    return { status: "invalid", diagnostics: [diagnostic("execution-plan", error.message)] };
  }
  try {
    checkpoint = verifyCheckpointShape(await readCheckpoint(worktree, planId));
  } catch (error) {
    return { status: "invalid", diagnostics: [diagnostic("checkpoint", error.message)] };
  }
  if (checkpoint.plan.revision !== executionPlan.revision) {
    diagnostics.push(diagnostic("plan-revision", "Checkpoint does not identify this execution plan revision"));
  }
  if (executionPlan.plan.plan_id !== planId) diagnostics.push(diagnostic("plan-id", executionPlan.plan.plan_id));
  if (checkpoint.plan.path !== sourcePlanPath(planId)) diagnostics.push(diagnostic("plan-path", checkpoint.plan.path));
  const currentBranch = await git(worktree, ["branch", "--show-current"]);
  if (currentBranch !== checkpoint.integration.target_branch) diagnostics.push(diagnostic("records-branch", currentBranch));
  const integrationRecord = ["merged", "done"].includes(checkpoint.integration.status);
  if (integrationRecord) {
    if (!await gitSucceeds(worktree, ["rev-parse", "--verify", `${checkpoint.integration.execution_head}^{commit}`])) {
      diagnostics.push(diagnostic("execution-head-missing", checkpoint.integration.execution_head));
    } else if (!await isAncestor(worktree, checkpoint.integration.execution_head)) {
      diagnostics.push(diagnostic("execution-head-not-ancestor", checkpoint.integration.execution_head));
    }
    if (!await gitSucceeds(worktree, ["rev-parse", "--verify", `${checkpoint.integration.merged_commit}^{commit}`])) {
      diagnostics.push(diagnostic("merged-commit-missing", checkpoint.integration.merged_commit));
    } else if (!await isAncestor(worktree, checkpoint.integration.merged_commit)) {
      diagnostics.push(diagnostic("merged-commit-not-ancestor", checkpoint.integration.merged_commit));
    }
  } else if (checkExecutionWorktree) {
    if (!executionWorktree) diagnostics.push(diagnostic("execution-worktree", "required before integration"));
    else if (!allowWorktreeRelocation && checkpoint.worktree !== resolve(executionWorktree)) diagnostics.push(diagnostic("worktree-path", checkpoint.worktree));
    if (executionWorktree && await git(executionWorktree, ["branch", "--show-current"]) !== checkpoint.branch) {
      diagnostics.push(diagnostic("execution-branch", checkpoint.branch));
    }
  }
  if (!await gitSucceeds(worktree, ["rev-parse", "--verify", `${checkpoint.baseline}^{commit}`])) {
    diagnostics.push(diagnostic("baseline-missing", checkpoint.baseline));
  } else if (!await isAncestor(worktree, checkpoint.baseline)) {
    diagnostics.push(diagnostic("baseline-not-ancestor", checkpoint.baseline));
  }
  const planTaskIds = new Set(executionPlan.tasks.map((task) => task.id));
  const checkpointTaskIds = new Set();
  for (const task of checkpoint.tasks) {
    if (checkpointTaskIds.has(task.id)) diagnostics.push(diagnostic("duplicate-task", task.id));
    checkpointTaskIds.add(task.id);
    if (!planTaskIds.has(task.id)) diagnostics.push(diagnostic("unknown-task", task.id));
    const commit = task.status === "done" ? task.end_commit : task.status === "in_progress" ? task.start_commit : null;
    if (!commit) {
      if (task.status === "done" || task.status === "in_progress") diagnostics.push(diagnostic("task-commit-missing", task.id));
      continue;
    }
    const commitWorktree = executionWorktree || worktree;
    if (!await gitSucceeds(commitWorktree, ["rev-parse", "--verify", `${commit}^{commit}`])) {
      diagnostics.push(diagnostic("task-commit-missing", `${task.id}:${commit}`));
    } else if (!await isAncestor(commitWorktree, commit)) {
      diagnostics.push(diagnostic("task-commit-not-ancestor", `${task.id}:${commit}`));
    }
  }
  for (const taskId of planTaskIds) {
    if (!checkpointTaskIds.has(taskId)) diagnostics.push(diagnostic("plan-task-missing", taskId));
  }
  if (checkpoint.status === "complete") {
    if (checkpoint.integration.status !== "done") diagnostics.push(diagnostic("complete-integration", checkpoint.integration.status));
    if (checkpoint.review.status !== "done") diagnostics.push(diagnostic("complete-review", checkpoint.review.status));
    for (const task of checkpoint.tasks) {
      if (task.status !== "done") diagnostics.push(diagnostic("complete-task", `${task.id}:${task.status}`));
    }
  }
  return diagnostics.length === 0
    ? { status: "valid", executionPlan, checkpoint, diagnostics: [] }
    : { status: "invalid", executionPlan, checkpoint, diagnostics };
}
