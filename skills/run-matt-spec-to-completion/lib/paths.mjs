import { join, relative, resolve, sep } from "node:path";

const PATH_CHANGE_TYPES = new Set(["1", "2", "u", "?", "!"]);
const STATUS_PATTERN = /^[.MTADRCU]$/;

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

function decodePath(value) {
  return Buffer.isBuffer(value) ? value.toString("utf8") : value;
}

function parseStatus(value, recordType) {
  if (recordType === "?" || recordType === "!") return { index_status: ".", worktree_status: "." };
  const [index_status, worktree_status] = value;
  if (!STATUS_PATTERN.test(index_status) || !STATUS_PATTERN.test(worktree_status)) {
    throw new Error(`Invalid porcelain v2 status: ${value}`);
  }
  return { index_status, worktree_status };
}

export function assertPathChange(change) {
  if (!change || typeof change !== "object" || !PATH_CHANGE_TYPES.has(change.record_type)) {
    throw new Error("PathChange record_type is invalid");
  }
  if (!STATUS_PATTERN.test(change.index_status) || !STATUS_PATTERN.test(change.worktree_status)) {
    throw new Error("PathChange status is invalid");
  }
  if (typeof change.path !== "string" || change.path.length === 0 || change.path.includes("\0")) {
    throw new Error("PathChange path is invalid");
  }
  if (change.record_type === "2") {
    if (typeof change.source_path !== "string" || change.source_path.length === 0 || change.source_path.includes("\0")) {
      throw new Error("Rename/copy PathChange requires source_path");
    }
  } else if ("source_path" in change) {
    throw new Error("Only rename/copy PathChange may include source_path");
  }
  return change;
}

export function comparePathChanges(left, right) {
  return Buffer.compare(Buffer.from(JSON.stringify(left)), Buffer.from(JSON.stringify(right)));
}

export function sortPathChanges(changes) {
  return [...changes].map(assertPathChange).sort(comparePathChanges);
}

export function pathChangesEqual(left, right) {
  const sortedLeft = sortPathChanges(left);
  const sortedRight = sortPathChanges(right);
  return sortedLeft.length === sortedRight.length && sortedLeft.every((change, index) => JSON.stringify(change) === JSON.stringify(sortedRight[index]));
}

export function parsePorcelainV2(buffer) {
  const fields = Buffer.isBuffer(buffer) ? buffer.toString("utf8").split("\0") : String(buffer).split("\0");
  const changes = [];
  for (let index = 0; index < fields.length - 1; index += 1) {
    const field = fields[index];
    if (field === "") continue;
    const recordType = field[0];
    if (!PATH_CHANGE_TYPES.has(recordType)) throw new Error(`Unsupported porcelain v2 record: ${recordType}`);
    if (recordType === "?" || recordType === "!") {
      changes.push(assertPathChange({ record_type: recordType, ...parseStatus("", recordType), path: decodePath(field.slice(2)) }));
      continue;
    }
    const parts = field.split(" ");
    const status = parseStatus(parts[1], recordType);
    if (recordType === "1") {
      changes.push(assertPathChange({ record_type: recordType, ...status, path: decodePath(parts.slice(8).join(" ")) }));
      continue;
    }
    if (recordType === "2") {
      const sourcePath = fields[++index];
      if (sourcePath === undefined) throw new Error("Rename/copy porcelain record is missing source path");
      changes.push(assertPathChange({ record_type: recordType, ...status, path: decodePath(parts.slice(9).join(" ")), source_path: decodePath(sourcePath) }));
      continue;
    }
    changes.push(assertPathChange({ record_type: recordType, ...status, path: decodePath(parts.slice(10).join(" ")) }));
  }
  return sortPathChanges(changes);
}
