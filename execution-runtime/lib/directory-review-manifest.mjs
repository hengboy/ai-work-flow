import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { posix } from "node:path";
import { promisify } from "node:util";

import { currentHead, git, gitOutput, gitPathChanges, gitSucceeds, isAncestor } from "./git.mjs";
import { sortPathChanges } from "./paths.mjs";
import { assertReviewManifest, createReviewManifest, reviewBundleDigest } from "./review-manifest.mjs";

const execFileAsync = promisify(execFile);
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const STANDARDS_PATH = "CONTEXT.md";
const PREPARE_ENVELOPE_VERSION = 1;
const PREPARE_ENVELOPE_TYPE = "directory-review-prepare";
const REVIEW_INPUT_FIELDS = [
  "fixed_point", "review_commit", "spec_status", "mode", "spec_path", "plan_path", "task_path",
  "standards_paths", "checks", "acceptance_evidence", "verification",
];
const PREPARE_ENVELOPE_FIELDS = [
  "version", "type", "review_manifest", "verify_input", "manifest_digest", "bundle_digest",
];

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function contentDigest(value) {
  const content = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(canonicalize(value)));
  return createHash("sha256").update(content).digest("hex");
}

function assertRelativePath(path, label) {
  if (typeof path !== "string" || !path || posix.isAbsolute(path) || posix.normalize(path) !== path || path === ".." || path.startsWith("../") || path.includes("\0")) {
    throw new Error(`${label} must be a normalized repository-relative path`);
  }
  return path;
}

function metadataValue(content, key) {
  const match = new RegExp("^- " + key + ": `([^`]+)`$", "m").exec(content.toString("utf8"));
  if (!match) throw new Error(`Review bundle is missing ${key} metadata`);
  return match[1];
}

async function gitBuffer(cwd, args) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`git ${args.join(" ")} failed: ${detail}`, { cause: error });
  }
}

async function committedFile(cwd, revision, path) {
  assertRelativePath(path, "Review source path");
  return gitBuffer(cwd, ["show", `${revision}:${path}`]);
}

function parseCommittedPathChanges(output) {
  const fields = output.toString("utf8").split("\0");
  const changes = [];
  for (let index = 0; index < fields.length - 1;) {
    const status = fields[index++];
    if (!status) continue;
    const code = status[0];
    if (code === "R" || code === "C") {
      const source_path = fields[index++];
      const path = fields[index++];
      if (!source_path || !path) throw new Error("Committed rename/copy path record is incomplete");
      changes.push({ record_type: "2", index_status: code, worktree_status: ".", path, source_path });
    } else {
      const path = fields[index++];
      if (!path || !"MADTU".includes(code)) throw new Error(`Unsupported committed path status: ${status}`);
      changes.push({ record_type: "1", index_status: code, worktree_status: ".", path });
    }
  }
  return sortPathChanges(changes);
}

async function committedPathChanges(cwd, fixedPoint, reviewCommit) {
  return parseCommittedPathChanges(await gitBuffer(cwd, [
    "diff", "--name-status", "-z", "--find-renames", "--find-copies", "--find-copies-harder", `${fixedPoint}...${reviewCommit}`,
  ]));
}

async function commitList(cwd, fixedPoint, reviewCommit) {
  const output = await gitOutput(cwd, ["log", "--format=%H%x1f%s", `${fixedPoint}..${reviewCommit}`]);
  return output.trim().split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf("\x1f");
    if (separator < 1) throw new Error("Could not create a structured review commit list");
    return { sha: line.slice(0, separator), subject: line.slice(separator + 1) };
  }).sort((left, right) => left.sha.localeCompare(right.sha));
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasExactStringFields(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...fields].sort().join("\0") &&
    fields.every((field) => isNonEmptyString(value[field]));
}

function assertKnownFields(value, allowed, label) {
  const unknown = Object.keys(value).filter((field) => !allowed.includes(field));
  if (unknown.length > 0) throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}`);
}

function directorySpecStatus(input) {
  const status = input.spec_status ?? "present";
  if (!["present", "absent"].includes(status)) throw new Error("Directory review spec_status must be present or absent");
  if (status === "absent") {
    const forbidden = ["spec_path", "plan_path", "task_path", "mode"].filter((field) => Object.hasOwn(input, field));
    if (forbidden.length > 0) throw new Error(`Directory review spec_status absent must not include ${forbidden.join(", ")}`);
  }
  return status;
}

function assertFacts(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Directory review input must be an object");
  assertKnownFields(input, REVIEW_INPUT_FIELDS, "Directory review input");
  if (!Array.isArray(input.acceptance_evidence) || input.acceptance_evidence.length === 0 ||
    input.acceptance_evidence.some((entry) => !hasExactStringFields(entry, ["criterion", "evidence"]))) {
    throw new Error("Directory review acceptance_evidence must contain non-empty {criterion,evidence} objects");
  }
  if (!Array.isArray(input.verification) || input.verification.length === 0 ||
    input.verification.some((entry) => !hasExactStringFields(entry, ["command", "result"]))) {
    throw new Error("Directory review verification must contain non-empty {command,result} objects");
  }
  if (!Array.isArray(input.checks) || input.checks.length === 0 || input.checks.some((check) => !isNonEmptyString(check))) {
    throw new Error("Directory review checks must contain non-empty strings");
  }
  return directorySpecStatus(input);
}

async function assertReviewContext(cwd, fixedPoint, reviewCommit) {
  if (!SHA_PATTERN.test(fixedPoint) || !SHA_PATTERN.test(reviewCommit) || !await gitSucceeds(cwd, ["rev-parse", "--verify", `${fixedPoint}^{commit}`]) || !await gitSucceeds(cwd, ["rev-parse", "--verify", `${reviewCommit}^{commit}`])) {
    throw new Error("Directory review endpoints must be full commit SHAs");
  }
  if (!await isAncestor(cwd, fixedPoint, reviewCommit) || fixedPoint === reviewCommit) throw new Error("Directory review range must be non-empty and ancestral");
  if (await currentHead(cwd) !== reviewCommit) throw new Error("Directory review worktree HEAD must equal review_commit");
  if ((await gitPathChanges(cwd)).length > 0) throw new Error("Directory review worktree must be clean");
}

async function directorySources(cwd, reviewCommit, input) {
  const specPath = assertRelativePath(input.spec_path, "spec_path");
  const planPath = assertRelativePath(input.plan_path, "plan_path");
  if (!["single", "task", "aggregate"].includes(input.mode)) throw new Error("Directory review mode must be single, task, or aggregate");
  if ((input.mode === "task") !== Boolean(input.task_path)) throw new Error("Directory review task_path must match task mode");
  const sourceInputs = [{ role: "spec", path: specPath }, { role: "plan", path: planPath }];
  if (input.task_path) sourceInputs.push({ role: "task", path: assertRelativePath(input.task_path, "task_path") });
  const sources = [];
  const contents = new Map();
  for (const source of sourceInputs) {
    const content = await committedFile(cwd, reviewCommit, source.path);
    contents.set(source.role, content);
    sources.push({ ...source, revision: reviewCommit, digest: contentDigest(content) });
  }
  if (metadataValue(contents.get("plan"), "source_spec") !== specPath || metadataValue(contents.get("plan"), "source_spec_digest") !== sources[0].digest) {
    throw new Error("Directory review plan source_spec binding does not match the committed spec");
  }
  const taskMode = metadataValue(contents.get("plan"), "task_mode");
  if ((input.mode === "single" && taskMode !== "single") || (input.mode !== "single" && taskMode !== "split")) {
    throw new Error("Directory review mode does not match the committed plan task_mode");
  }
  if (input.mode === "task") {
    const task = contents.get("task");
    const taskSourcePlan = posix.normalize(posix.join(posix.dirname(input.task_path), metadataValue(task, "source_plan")));
    if (taskSourcePlan !== planPath || metadataValue(task, "source_plan_digest") !== sources[1].digest) {
      throw new Error("Directory review task source_plan binding does not match the committed plan");
    }
  }
  return sources;
}

async function standardsSource(cwd, reviewCommit, input) {
  if (input.standards_paths !== undefined && (!Array.isArray(input.standards_paths) || input.standards_paths.length !== 1 || input.standards_paths[0] !== STANDARDS_PATH)) {
    throw new Error(`Directory review standards_source must be ${STANDARDS_PATH}@review_commit`);
  }
  await committedFile(cwd, reviewCommit, STANDARDS_PATH);
  return [{ path: STANDARDS_PATH, revision: reviewCommit }];
}

function buildDirectoryBundle(input, sources, specStatus) {
  const bundle = {
    type: "directory",
    mode: specStatus === "absent" ? "absent" : input.mode,
    sources,
    acceptance_evidence_digest: contentDigest(input.acceptance_evidence),
    verification_digest: contentDigest(input.verification),
  };
  bundle.bundle_digest = reviewBundleDigest(bundle);
  return bundle;
}

async function buildDirectoryReviewFacts(cwd, input) {
  const specStatus = assertFacts(input);
  await assertReviewContext(cwd, input.fixed_point, input.review_commit);
  const sources = specStatus === "absent" ? [] : await directorySources(cwd, input.review_commit, input);
  const standards_source = await standardsSource(cwd, input.review_commit, input);
  const changed_paths = await committedPathChanges(cwd, input.fixed_point, input.review_commit);
  if (changed_paths.length === 0) throw new Error("Directory review range must contain changed paths");
  await git(cwd, ["diff", "--check", `${input.fixed_point}...${input.review_commit}`]);
  const diff_command = ["git", "diff", "--no-ext-diff", `${input.fixed_point}...${input.review_commit}`];
  const directory_bundle = buildDirectoryBundle(input, sources, specStatus);
  return {
    fixed_point: input.fixed_point,
    review_commit: input.review_commit,
    commit_list: await commitList(cwd, input.fixed_point, input.review_commit),
    changed_paths,
    checks: [...input.checks, `git diff --check ${input.fixed_point}...${input.review_commit}`],
    diff_command,
    spec_status: specStatus,
    spec_source: specStatus === "absent" ? null : sources[0],
    standards_source,
    directory_bundle,
    shards: changed_paths.map((change, index) => ({
      id: `shard-${String(index + 1).padStart(4, "0")}`,
      paths: [change.path],
      diff_command: [...diff_command, "--", change.path],
    })),
  };
}

export async function prepareDirectoryReviewManifest(cwd, input) {
  return createReviewManifest(await buildDirectoryReviewFacts(cwd, input));
}

export function createDirectoryReviewPrepareEnvelope(manifest, input) {
  const reviewManifest = assertReviewManifest(manifest);
  const verifyInput = structuredClone(input);
  assertFacts(verifyInput);
  if (verifyInput.fixed_point !== reviewManifest.fixed_point || verifyInput.review_commit !== reviewManifest.review_commit) {
    throw new Error("ReviewManifest prepare envelope endpoints must match verify_input");
  }
  if (!reviewManifest.directory_bundle) throw new Error("ReviewManifest prepare envelope requires a directory bundle");
  return assertDirectoryReviewPrepareEnvelope({
    version: PREPARE_ENVELOPE_VERSION,
    type: PREPARE_ENVELOPE_TYPE,
    review_manifest: reviewManifest,
    verify_input: verifyInput,
    manifest_digest: reviewManifest.manifest_digest,
    bundle_digest: reviewManifest.directory_bundle.bundle_digest,
  });
}

export function assertDirectoryReviewPrepareEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("ReviewManifest verify requires a directory review prepare envelope");
  }
  assertKnownFields(envelope, PREPARE_ENVELOPE_FIELDS, "Directory review prepare envelope");
  if (envelope.version !== PREPARE_ENVELOPE_VERSION || envelope.type !== PREPARE_ENVELOPE_TYPE) {
    throw new Error("Directory review prepare envelope has an unsupported format");
  }
  const reviewManifest = assertReviewManifest(envelope.review_manifest);
  if (!reviewManifest.directory_bundle) throw new Error("ReviewManifest prepare envelope requires a directory bundle");
  const verifyInput = structuredClone(envelope.verify_input);
  assertFacts(verifyInput);
  if (verifyInput.fixed_point !== reviewManifest.fixed_point || verifyInput.review_commit !== reviewManifest.review_commit) {
    throw new Error("ReviewManifest prepare envelope endpoints do not match verify_input");
  }
  if (!DIGEST_PATTERN.test(envelope.manifest_digest) || envelope.manifest_digest !== reviewManifest.manifest_digest) {
    throw new Error("ReviewManifest prepare envelope manifest digest is invalid");
  }
  if (!DIGEST_PATTERN.test(envelope.bundle_digest) || envelope.bundle_digest !== reviewManifest.directory_bundle.bundle_digest) {
    throw new Error("ReviewManifest prepare envelope bundle digest is invalid");
  }
  const expectedDiffCheck = `git diff --check ${reviewManifest.fixed_point}...${reviewManifest.review_commit}`;
  if (JSON.stringify(reviewManifest.checks) !== JSON.stringify([...verifyInput.checks, expectedDiffCheck])) {
    throw new Error("ReviewManifest prepare envelope checks do not match the review manifest");
  }
  if (contentDigest(verifyInput.acceptance_evidence) !== reviewManifest.directory_bundle.acceptance_evidence_digest ||
    contentDigest(verifyInput.verification) !== reviewManifest.directory_bundle.verification_digest) {
    throw new Error("ReviewManifest prepare envelope bundle inputs do not match their digests");
  }
  return {
    version: envelope.version,
    type: envelope.type,
    review_manifest: reviewManifest,
    verify_input: verifyInput,
    manifest_digest: envelope.manifest_digest,
    bundle_digest: envelope.bundle_digest,
  };
}

export async function prepareDirectoryReviewEnvelope(cwd, input) {
  return createDirectoryReviewPrepareEnvelope(await prepareDirectoryReviewManifest(cwd, input), input);
}

export async function verifyDirectoryReviewEnvelope(cwd, envelope) {
  const prepared = assertDirectoryReviewPrepareEnvelope(envelope);
  return verifyDirectoryReviewManifest(cwd, prepared.review_manifest, prepared.verify_input);
}

export async function verifyDirectoryReviewManifest(cwd, manifest, input) {
  assertFacts(input);
  manifest = assertReviewManifest(manifest);
  if (!manifest.directory_bundle) throw new Error("ReviewManifest is not a directory review manifest");
  if (input.fixed_point !== manifest.fixed_point || input.review_commit !== manifest.review_commit) {
    throw new Error("ReviewManifest does not match the externally supplied review endpoints");
  }
  const expected = createReviewManifest(await buildDirectoryReviewFacts(cwd, input));
  const fields = [
    "version", "fixed_point", "review_commit", "commit_list", "changed_paths", "checks", "diff_command",
    "spec_status", "spec_source", "standards_source", "shards", "directory_bundle",
  ];
  for (const field of fields) {
    if (JSON.stringify(canonicalize(manifest[field])) !== JSON.stringify(canonicalize(expected[field]))) {
      const label = field === "directory_bundle" ? "directory bundle facts" : field;
      throw new Error(`ReviewManifest ${label} do not match deterministic review facts`);
    }
  }
  if (manifest.manifest_digest !== expected.manifest_digest) {
    throw new Error("ReviewManifest digest does not match deterministic review facts");
  }
  return manifest;
}

export { parseCommittedPathChanges };
