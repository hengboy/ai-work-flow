import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { validateArtifactRef } from "./workflow-contract.mjs";
import { loadWorkflowContract } from "./workflow-contract.mjs";
import { ensureWorkflowDirectory, statusRun, workflowRunPaths } from "./workflow-store.mjs";

const execFileAsync = promisify(execFile);

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
  if (!commit.test(input.review_base_commit) || !commit.test(input.review_commit) ||
    !input.review_context || !Array.isArray(input.review_slices) || input.review_slices.length === 0 ||
    !input.runtime_identity || !/^[0-9a-f]{64}$/.test(input.runtime_identity.contract_digest)) {
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
  const contract = await loadWorkflowContract();
  if (input.runtime_identity.contract_digest !== contract.digest) throw new Error("Review packet runtime identity is drifted");
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
  const content = await readFile(join(paths.run, "artifacts", `${ref.id}.json`));
  if (content.byteLength !== ref.bytes || digest(content) !== ref.sha256) throw new Error("Review packet digest or size does not match");
  const packet = JSON.parse(content);
  assertPacketInput({ repository, ...packet });
  await assertGitFacts({ repository, ...packet });
  await assertReviewSlices({ repository, ...packet });
  await assertRuntimeIdentity(packet);
  return packet;
}
