import { createHash } from "node:crypto";
import { assertPathChange } from "./paths.mjs";

const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

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

export function reviewManifestDigest(manifest) {
  const { manifest_digest, ...unsigned } = manifest;
  return createHash("sha256").update(JSON.stringify(canonicalize(unsigned))).digest("hex");
}

export function assertReviewManifest(manifest) {
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
    manifest.checks.some((check) => typeof check !== "string" || !check) ||
    manifest.diff_command.some((argument) => typeof argument !== "string" || !argument) ||
    manifest.standards_source.some((source) => !source || typeof source.path !== "string" || !source.path || typeof source.revision !== "string" || !source.revision) ||
    (manifest.spec_source && (typeof manifest.spec_source.path !== "string" || !manifest.spec_source.path || typeof manifest.spec_source.revision !== "string" || !manifest.spec_source.revision))) {
    throw new Error("ReviewManifest has invalid structured content");
  }
  const ids = new Set();
  for (const shard of manifest.shards) {
    if (!shard || typeof shard.id !== "string" || !shard.id || ids.has(shard.id) || !Array.isArray(shard.paths) || !Array.isArray(shard.diff_command) || shard.paths.some((path) => typeof path !== "string" || !path) || shard.diff_command.some((argument) => typeof argument !== "string" || !argument)) {
      throw new Error("ReviewManifest shards must have unique IDs, paths, and commands");
    }
    ids.add(shard.id);
  }
  if (typeof manifest.manifest_digest !== "string" || manifest.manifest_digest !== reviewManifestDigest(manifest)) {
    throw new Error("ReviewManifest digest does not match its immutable contents");
  }
  return deepFreeze(structuredClone(manifest));
}

export function createReviewManifest(input) {
  const manifest = { version: 1, ...structuredClone(input) };
  manifest.commit_list.sort((left, right) => left.sha.localeCompare(right.sha));
  manifest.shards.sort((left, right) => left.id.localeCompare(right.id));
  manifest.manifest_digest = reviewManifestDigest(manifest);
  return assertReviewManifest(manifest);
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
  const seen = new Set([...coverage.completed_shard_ids, ...coverage.incomplete_shard_ids]);
  if (seen.size !== expected.size || [...seen].some((id) => !expected.has(id)) || coverage.completed_shard_ids.some((id) => coverage.incomplete_shard_ids.includes(id))) {
    throw new Error("Review coverage is incomplete, duplicated, or outside the manifest");
  }
  if (coverage.incomplete_shard_ids.length > 0) throw new Error("Review cannot complete with incomplete shards");
  return coverage;
}
