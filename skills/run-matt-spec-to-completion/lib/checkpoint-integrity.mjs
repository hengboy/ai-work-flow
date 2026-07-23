import { readExecutionPlan, verifyExecutionPlan } from "./spec-intake.mjs";
import { readCheckpoint, verifyCheckpointShape } from "./checkpoint.mjs";
import { git, gitSucceeds, isAncestor } from "./git.mjs";
import { sourceSpecPath } from "./paths.mjs";
import { resolve } from "node:path";

function diagnostic(code, detail) {
  return { code, detail };
}

export async function verifyCheckpointIntegrity({ worktree, executionWorktree, featureSlug, checkExecutionWorktree = true, allowWorktreeRelocation = false }) {
  const diagnostics = [];
  let executionPlan;
  let checkpoint;
  try {
    executionPlan = verifyExecutionPlan(await readExecutionPlan(worktree, featureSlug));
  } catch (error) {
    return { status: "invalid", diagnostics: [diagnostic("execution-plan", error.message)] };
  }
  try {
    checkpoint = verifyCheckpointShape(await readCheckpoint(worktree, featureSlug));
  } catch (error) {
    return { status: "invalid", diagnostics: [diagnostic("checkpoint", error.message)] };
  }
  if (checkpoint.spec.revision !== executionPlan.revision) {
    diagnostics.push(diagnostic("spec-revision", "Checkpoint does not identify this execution plan revision"));
  }
  if (executionPlan.spec.feature_slug !== featureSlug) diagnostics.push(diagnostic("feature-slug", executionPlan.spec.feature_slug));
  if (checkpoint.spec.path !== sourceSpecPath(featureSlug)) diagnostics.push(diagnostic("spec-path", checkpoint.spec.path));
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
  const specTicketIds = new Set(executionPlan.tickets.map((ticket) => ticket.id));
  const checkpointTicketIds = new Set();
  for (const ticket of checkpoint.tickets) {
    if (checkpointTicketIds.has(ticket.id)) diagnostics.push(diagnostic("duplicate-ticket", ticket.id));
    checkpointTicketIds.add(ticket.id);
    if (!specTicketIds.has(ticket.id)) diagnostics.push(diagnostic("unknown-ticket", ticket.id));
    const commit = ticket.status === "done" ? ticket.end_commit : ticket.status === "in_progress" ? ticket.start_commit : null;
    if (!commit) {
      if (ticket.status === "done" || ticket.status === "in_progress") diagnostics.push(diagnostic("ticket-commit-missing", ticket.id));
      continue;
    }
    const commitWorktree = executionWorktree || worktree;
    if (!await gitSucceeds(commitWorktree, ["rev-parse", "--verify", `${commit}^{commit}`])) {
      diagnostics.push(diagnostic("ticket-commit-missing", `${ticket.id}:${commit}`));
    } else if (!await isAncestor(commitWorktree, commit)) {
      diagnostics.push(diagnostic("ticket-commit-not-ancestor", `${ticket.id}:${commit}`));
    }
  }
  for (const ticketId of specTicketIds) {
    if (!checkpointTicketIds.has(ticketId)) diagnostics.push(diagnostic("spec-ticket-missing", ticketId));
  }
  if (checkpoint.status === "complete") {
    if (checkpoint.integration.status !== "done") diagnostics.push(diagnostic("complete-integration", checkpoint.integration.status));
    if (checkpoint.review.status !== "done") diagnostics.push(diagnostic("complete-review", checkpoint.review.status));
    for (const ticket of checkpoint.tickets) {
      if (ticket.status !== "done") diagnostics.push(diagnostic("complete-ticket", `${ticket.id}:${ticket.status}`));
    }
  }
  return diagnostics.length === 0
    ? { status: "valid", executionPlan, checkpoint, diagnostics: [] }
    : { status: "invalid", executionPlan, checkpoint, diagnostics };
}