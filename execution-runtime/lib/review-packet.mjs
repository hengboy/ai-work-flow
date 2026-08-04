import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { validateArtifactRef } from "./workflow-contract.mjs";
import { loadAndAssertRuntimeIdentity } from "./runtime-identity.mjs";
import { ensureWorkflowDirectory, statusRun, workflowRunPaths } from "./workflow-store.mjs";

const execFileAsync = promisify(execFile);
const RUNTIME_ROOT = resolve(import.meta.dirname, "..");

function digest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function git(repository, args) {
  const { stdout } = await execFileAsync("git", args, { cwd: repository, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

async function gitRaw(repository, args) {
  const { stdout } = await execFileAsync("git", args, { cwd: repository, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

function assertPacketInput(input) {
  const commit = /^[0-9a-f]{40,64}$/;
  const reviewContext = input.review_context;
  const identity = input.runtime_identity;
  const specSource = reviewContext?.spec_source;
  if (!reviewContext || typeof reviewContext !== "object" || Array.isArray(reviewContext) ||
    !specSource || typeof specSource.path !== "string" || !specSource.path || !/^[0-9a-f]{64}$/.test(specSource.sha256) ||
    !Array.isArray(reviewContext.acceptance_evidence) || reviewContext.acceptance_evidence.length === 0 ||
    reviewContext.acceptance_evidence.some((item) => !item || typeof item.criterion !== "string" || !item.criterion || typeof item.evidence !== "string" || !item.evidence) ||
    !Array.isArray(reviewContext.verification) || reviewContext.verification.length === 0 ||
    reviewContext.verification.some((item) => !item || typeof item.command !== "string" || !item.command || typeof item.result !== "string" || !item.result)) {
    throw new Error("Review packet review context is incomplete");
  }
  if (!commit.test(input.review_base_commit) || !commit.test(input.review_commit) ||
    !Array.isArray(input.review_slices) || input.review_slices.length === 0 ||
    !identity || Object.keys(identity).sort().join() !== "identity_digest,source_revision" ||
    !/^[0-9a-f]{64}$/.test(identity.identity_digest) || !/^[0-9a-f]{64}$/.test(identity.source_revision)) {
    throw new Error("Review packet input is invalid");
  }
}

async function assertGitFacts(input) {
  if (await git(input.repository, ["rev-parse", "HEAD"]) !== input.review_commit) throw new Error("Review packet HEAD must equal review_commit");
  if (await git(input.repository, ["status", "--porcelain"])) throw new Error("Review packet worktree must be clean");
  try {
    await git(input.repository, ["merge-base", "--is-ancestor", input.review_base_commit, input.review_commit]);
  } catch {
    throw new Error("Review packet base must be an ancestor of review_commit");
  }
}

async function assertReviewSlices(input) {
  const output = await gitRaw(input.repository, ["diff", "--name-only", "-z", `${input.review_base_commit}...${input.review_commit}`]);
  const changed = output.split("\0").filter(Boolean).sort();
  const ids = input.review_slices.map((slice) => slice?.id);
  const covered = input.review_slices.flatMap((slice) => Array.isArray(slice?.paths) ? slice.paths : []);
  if (ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length ||
    covered.some((path) => typeof path !== "string" || !path) || new Set(covered).size !== covered.length ||
    JSON.stringify([...covered].sort()) !== JSON.stringify(changed)) {
    throw new Error("Review packet slices must cover every changed path exactly once");
  }
}

async function assertRuntimeIdentity(input) {
  const { evidence } = loadAndAssertRuntimeIdentity(RUNTIME_ROOT);
  if (input.runtime_identity.identity_digest !== evidence.identity_digest || input.runtime_identity.source_revision !== evidence.source_revision) {
    throw new Error("Review packet runtime identity is drifted");
  }
}

export async function createReviewPacket(input) {
  assertPacketInput(input);
  await statusRun({ repository: input.repository, run_id: input.run_id });
  await assertGitFacts(input);
  await assertReviewSlices(input);
  await assertRuntimeIdentity(input);
  const paths = await workflowRunPaths(input.repository, input.run_id);
  const packet = {
    review_base_commit: input.review_base_commit,
    review_commit: input.review_commit,
    review_context: input.review_context,
    review_slices: input.review_slices,
    runtime_identity: input.runtime_identity,
  };
  const content = Buffer.from(`${JSON.stringify(packet, null, 2)}\n`);
  const sha256 = digest(content);
  const id = `review_packet_${sha256.slice(0, 24)}`;
  const ref = { kind: "review_packet", id, sha256, bytes: content.byteLength };
  const { open, rename } = await import("node:fs/promises");
  const directory = join(paths.run, "artifacts");
  await ensureWorkflowDirectory(input.repository, directory);
  const temporary = join(directory, `.${id}.tmp`);
  const target = join(directory, `${id}.json`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, target);
  return ref;
}

export async function verifyReviewPacket({ repository, run_id, ref }) {
  validateArtifactRef(ref);
  if (ref.kind !== "review_packet" || !/^review_packet_[0-9a-f]{24}$/.test(ref.id)) throw new Error("ReviewPacketRef is invalid");
  const paths = await workflowRunPaths(repository, run_id);
  const target = join(paths.run, "artifacts", `${ref.id}.json`);
  const stat = await lstat(target);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Review packet path is unsafe");
  const content = await readFile(target);
  if (content.byteLength !== ref.bytes || digest(content) !== ref.sha256) throw new Error("Review packet digest or size does not match");
  const packet = JSON.parse(content);
  assertPacketInput({ repository, ...packet });
  await assertGitFacts({ repository, ...packet });
  await assertReviewSlices({ repository, ...packet });
  await assertRuntimeIdentity(packet);
  return packet;
}
