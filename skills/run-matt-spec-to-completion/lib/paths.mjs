import { join, relative, resolve, sep } from "node:path";

const FEATURE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function assertFeatureSlug(featureSlug) {
  if (typeof featureSlug !== "string" || !FEATURE_SLUG_PATTERN.test(featureSlug)) {
    throw new Error("featureSlug must contain only lowercase letters, numbers, and hyphens");
  }
}

export function featureDirectory(featureSlug) {
  assertFeatureSlug(featureSlug);
  return join(".scratch", featureSlug);
}

export function sourceSpecPath(featureSlug) {
  return join(featureDirectory(featureSlug), "spec.md");
}

export function executionPlanPath(featureSlug) {
  return join(featureDirectory(featureSlug), "execution-plan.json");
}

export function checkpointPath(featureSlug) {
  return join(featureDirectory(featureSlug), "checkpoint.json");
}

export function deriveSpecLocation(mainWorktree, inputPath) {
  const root = resolve(mainWorktree);
  const absolutePath = resolve(root, inputPath);
  const relativePath = relative(root, absolutePath).split(sep).join("/");
  const match = /^\.scratch\/([a-z0-9][a-z0-9-]*)\/spec\.md$/.exec(relativePath);
  if (!match) {
    throw new Error("Spec path must be .scratch/<featureSlug>/spec.md within the main worktree");
  }
  const [, featureSlug] = match;
  assertFeatureSlug(featureSlug);
  return { featureSlug, path: sourceSpecPath(featureSlug), absolutePath };
}