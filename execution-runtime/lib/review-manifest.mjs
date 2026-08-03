import { createHash } from "node:crypto";
import { assertPathChange } from "./paths.mjs";

const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function fixedDiffCommand(fixedPoint, reviewCommit) {
  return ["git", "diff", "--no-ext-diff", `${fixedPoint}...${reviewCommit}`];
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function reviewManifestDigest(manifest) {
  const { manifest_digest, ...unsigned } = manifest;
  return createHash("sha256").update(JSON.stringify(canonicalize(unsigned))).digest("hex");
}

export function reviewBundleDigest(bundle) {
  const { bundle_digest, ...unsigned } = bundle;
  return createHash("sha256").update(JSON.stringify(canonicalize(unsigned))).digest("hex");
}

function assertDirectoryBundle(bundle, manifest) {
  if (!bundle || bundle.type !== "directory" || !["single", "task", "aggregate"].includes(bundle.mode) || !Array.isArray(bundle.sources)) {
    throw new Error("ReviewManifest has invalid directory bundle");
  }
  if (manifest.spec_status === "absent" && bundle.mode !== "single") {
    throw new Error("ReviewManifest absent directory bundle must use single mode");
  }
  const expectedRoles = manifest.spec_status === "absent" ? [] : bundle.mode === "task" ? ["spec", "plan", "task"] : ["spec", "plan"];
  const roles = bundle.sources.map((source) => source?.role);
  if (!sameJson(roles, expectedRoles) || bundle.sources.some((source) => (
    typeof source.path !== "string" || !source.path || source.revision !== manifest.review_commit || !DIGEST_PATTERN.test(source.digest)
  ))) {
    throw new Error("ReviewManifest directory bundle sources are not fixed to the review commit");
  }
  const paths = bundle.sources.map((source) => source.path);
  const expectedSpecSource = bundle.sources[0] ?? null;
  if (new Set(paths).size !== paths.length || !sameJson(expectedSpecSource, manifest.spec_source ?? null)) {
    throw new Error("ReviewManifest directory bundle source binding is invalid");
  }
  if (!DIGEST_PATTERN.test(bundle.acceptance_evidence_digest) || !DIGEST_PATTERN.test(bundle.verification_digest) || bundle.bundle_digest !== reviewBundleDigest(bundle)) {
    throw new Error("ReviewManifest directory bundle digest is invalid");
  }
}

export function assertReviewManifest(manifest, context) {
  if (!manifest || manifest.version !== 1 || !SHA_PATTERN.test(manifest.fixed_point) || !SHA_PATTERN.test(manifest.review_commit)) {
    throw new Error("ReviewManifest has invalid fixed review endpoints");
  }
  if (!Array.isArray(manifest.commit_list) || !Array.isArray(manifest.changed_paths) || !Array.isArray(manifest.checks) || !Array.isArray(manifest.diff_command) || !Array.isArray(manifest.standards_source) || !Array.isArray(manifest.shards)) {
    throw new Error("ReviewManifest has invalid collection fields");
  }
  if (!['present', 'absent'].includes(manifest.spec_status) || (manifest.spec_status === 'present') !== Boolean(manifest.spec_source)) {
    throw new Error("ReviewManifest spec source does not match spec status");
  }
  try {
    manifest.changed_paths.forEach(assertPathChange);
  } catch (error) {
    throw new Error(`ReviewManifest has invalid changed paths: ${error.message}`, { cause: error });
  }
  if (manifest.commit_list.some((commit) => !commit || !SHA_PATTERN.test(commit.sha) || typeof commit.subject !== "string") ||
    manifest.checks.some((check) => typeof check !== "string" || !check.trim()) ||
    manifest.diff_command.some((argument) => typeof argument !== "string" || !argument) ||
    manifest.standards_source.length === 0 || manifest.standards_source.some((source) => !source || typeof source.path !== "string" || !source.path || typeof source.revision !== "string" || !SHA_PATTERN.test(source.revision) || source.revision !== manifest.review_commit) ||
    (manifest.spec_source && (typeof manifest.spec_source.path !== "string" || !manifest.spec_source.path || typeof manifest.spec_source.revision !== "string" || !SHA_PATTERN.test(manifest.spec_source.revision) || ("digest" in manifest.spec_source && !DIGEST_PATTERN.test(manifest.spec_source.digest))))) {
    throw new Error("ReviewManifest has invalid structured content");
  }
  if (manifest.directory_bundle) assertDirectoryBundle(manifest.directory_bundle, manifest);
  if (!sameJson(manifest.diff_command, fixedDiffCommand(manifest.fixed_point, manifest.review_commit))) {
    throw new Error("ReviewManifest must use the fixed review diff command");
  }
  const changedPaths = manifest.changed_paths.map((change) => change.path);
  if (new Set(changedPaths).size !== changedPaths.length) throw new Error("ReviewManifest changed paths must be unique");
  const ids = new Set();
  const shardPaths = [];
  for (const shard of manifest.shards) {
    if (!shard || typeof shard.id !== "string" || !shard.id || ids.has(shard.id) || !Array.isArray(shard.paths) || shard.paths.length === 0 || !Array.isArray(shard.diff_command) || shard.paths.some((path) => typeof path !== "string" || !path) || shard.diff_command.some((argument) => typeof argument !== "string" || !argument)) {
      throw new Error("ReviewManifest shards must have unique IDs, paths, and commands");
    }
    if (!sameJson(shard.diff_command, [...fixedDiffCommand(manifest.fixed_point, manifest.review_commit), "--", ...shard.paths])) {
      throw new Error("ReviewManifest shard command does not match the fixed review diff command");
    }
    ids.add(shard.id);
    shardPaths.push(...shard.paths);
  }
  if (new Set(shardPaths).size !== shardPaths.length || shardPaths.length !== changedPaths.length || shardPaths.some((path) => !changedPaths.includes(path))) {
    throw new Error("ReviewManifest shards must cover every changed path exactly once");
  }
  if (context && (
    context.fixedPoint !== manifest.fixed_point ||
    context.reviewCommit !== manifest.review_commit ||
    !sameJson(context.changedPaths, manifest.changed_paths)
  )) {
    throw new Error("ReviewManifest does not match the frozen review context");
  }
  if (typeof manifest.manifest_digest !== "string" || manifest.manifest_digest !== reviewManifestDigest(manifest)) {
    throw new Error("ReviewManifest digest does not match its immutable contents");
  }
  return deepFreeze(structuredClone(manifest));
}

export function createReviewManifest(input) {
  const manifest = { version: 1, ...structuredClone(input) };
  manifest.commit_list.sort((left, right) => left.sha.localeCompare(right.sha));
  manifest.changed_paths.sort((left, right) => left.path.localeCompare(right.path));
  manifest.shards.sort((left, right) => left.id.localeCompare(right.id));
  manifest.manifest_digest = reviewManifestDigest(manifest);
  return assertReviewManifest(manifest, { fixedPoint: manifest.fixed_point, reviewCommit: manifest.review_commit, changedPaths: manifest.changed_paths });
}

export function createReviewShardAssignments(manifest) {
  manifest = assertReviewManifest(manifest);
  const assignment = Object.freeze({ manifest, manifest_digest: manifest.manifest_digest, shard_ids: manifest.shards.map((shard) => shard.id) });
  return manifest.spec_status === "present"
    ? Object.freeze({ standards: assignment, spec: assignment })
    : Object.freeze({ standards: assignment });
}

export function assertReviewCoverage(manifest, coverage) {
  manifest = assertReviewManifest(manifest);
  if (!coverage || coverage.manifest_digest !== manifest.manifest_digest || !Array.isArray(coverage.completed_shard_ids) || !Array.isArray(coverage.incomplete_shard_ids)) {
    throw new Error("Review coverage does not identify this manifest");
  }
  const expected = new Set(manifest.shards.map((shard) => shard.id));
  const completed = new Set(coverage.completed_shard_ids);
  const incomplete = new Set(coverage.incomplete_shard_ids);
  const seen = new Set([...completed, ...incomplete]);
  if (completed.size !== coverage.completed_shard_ids.length || incomplete.size !== coverage.incomplete_shard_ids.length || seen.size !== expected.size || [...seen].some((id) => !expected.has(id)) || [...completed].some((id) => incomplete.has(id))) {
    throw new Error("Review coverage is incomplete, duplicated, or outside the manifest");
  }
  if (coverage.incomplete_shard_ids.length > 0) throw new Error("Review cannot complete with incomplete shards");
  return coverage;
}
