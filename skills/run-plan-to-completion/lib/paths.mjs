import { join, relative, resolve, sep } from "node:path";

const PLAN_ID_PATTERN = /^[a-z]+(?:-[a-z]+){1,5}$/;

export function assertPlanId(planId) {
  if (typeof planId !== "string" || !PLAN_ID_PATTERN.test(planId)) {
    throw new Error("planId must contain two to six lowercase English words separated by hyphens");
  }
}

export function planDirectory(planId) {
  assertPlanId(planId);
  return join(".ai-work-flow", "plans", planId);
}

export function sourcePlanPath(planId) {
  return join(planDirectory(planId), "plan.md");
}

export function executionPlanPath(planId) {
  return join(planDirectory(planId), "execution-plan.json");
}

export function checkpointPath(planId) {
  return join(planDirectory(planId), "checkpoint.json");
}

export function derivePlanLocation(mainWorktree, inputPath) {
  const root = resolve(mainWorktree);
  const absolutePath = resolve(root, inputPath);
  const relativePath = relative(root, absolutePath).split(sep).join("/");
  const match = /^\.ai-work-flow\/plans\/([a-z]+(?:-[a-z]+){1,5})\/plan\.md$/.exec(relativePath);
  if (!match) {
    throw new Error("Plan path must be .ai-work-flow/plans/<planId>/plan.md within the main worktree");
  }
  const [, planId] = match;
  assertPlanId(planId);
  return { planId, path: sourcePlanPath(planId), absolutePath };
}
