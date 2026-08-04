import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

import { validateArtifactRef } from "./workflow-contract.mjs";
import { ensureWorkflowDirectory, statusRun, workflowRunPaths } from "./workflow-store.mjs";

const KIND_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function fsyncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function createArtifact({ repository, run_id, kind, content }) {
  if (!KIND_PATTERN.test(kind) || kind === "review_packet" || content === undefined) {
    throw new Error("Artifact kind is invalid or reserved");
  }
  await statusRun({ repository, run_id });
  const paths = await workflowRunPaths(repository, run_id);
  const directory = join(paths.run, "artifacts");
  await ensureWorkflowDirectory(repository, directory);
  const body = Buffer.from(`${JSON.stringify(content, null, 2)}\n`);
  const sha256 = digest(body);
  const id = `${kind}_${sha256.slice(0, 24)}`;
  const temporary = join(directory, `.${id}.${randomBytes(8).toString("hex")}.tmp`);
  const target = join(directory, `${id}.json`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, target);
  await fsyncDirectory(directory);
  return { kind, id, sha256, bytes: body.byteLength };
}

export async function verifyArtifact({ repository, run_id, ref }) {
  validateArtifactRef(ref);
  if (!KIND_PATTERN.test(ref.kind) || ref.kind === "review_packet") {
    throw new Error("ArtifactRef kind or id is invalid");
  }
  if (ref.id !== `${ref.kind}_${ref.sha256.slice(0, 24)}`) throw new Error("Artifact digest does not match its id");
  const paths = await workflowRunPaths(repository, run_id);
  const target = join(paths.run, "artifacts", `${ref.id}.json`);
  const stat = await lstat(target);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Artifact path is unsafe");
  const body = await readFile(target);
  if (body.byteLength !== ref.bytes || digest(body) !== ref.sha256) throw new Error("Artifact digest or size does not match");
  return JSON.parse(body);
}
