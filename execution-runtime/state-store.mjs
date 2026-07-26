import { open, readFile, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { checkpointPath } from "../skills/run-matt-spec-to-completion/lib/paths.mjs";
import { writeCheckpoint } from "../skills/run-matt-spec-to-completion/lib/checkpoint.mjs";
import { requireCheckpointIntegrity } from "../skills/run-matt-spec-to-completion/lib/checkpoint-integrity.mjs";

const LOCK_GRACE_MS = 60_000;
const lockContext = new AsyncLocalStorage();

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function lockIsStale(path) {
  try {
    const [contents, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    try {
      return !processIsAlive(JSON.parse(contents).pid);
    } catch {
      return Date.now() - metadata.mtimeMs > LOCK_GRACE_MS;
    }
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function withFeatureLock(repository, featureSlug, action) {
  const root = await realpath(repository);
  const key = `${root}\u0000${featureSlug}`;
  if (lockContext.getStore()?.has(key)) return action();
  const path = join(root, `${checkpointPath(featureSlug)}.runtime.lock`);
  const recoveryPath = `${path}.recovery`;
  let lock;
  while (!lock) {
    try {
      lock = await open(path, "wx");
      await lock.writeFile(`${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`);
      await lock.sync();
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stale = await lockIsStale(path);
      if (stale === null) continue;
      if (!stale) throw new Error("A runtime mutation is already in progress.");
      let recovery;
      try {
        recovery = await open(recoveryPath, "wx");
      } catch (recoveryError) {
        if (recoveryError.code === "EEXIST") throw new Error("A runtime mutation is already in progress.");
        throw recoveryError;
      }
      try {
        if (await lockIsStale(path)) await rm(path, { force: true });
      } finally {
        await recovery.close();
        await rm(recoveryPath, { force: true });
      }
    }
  }
  try {
    const held = new Set(lockContext.getStore() ?? []);
    held.add(key);
    return await lockContext.run(held, action);
  } finally {
    await lock.close();
    await rm(path, { force: true });
  }
}

export function createRuntimeStateStore() {
  const integrity = ({ repository, featureSlug, executionWorktree, checkExecutionWorktree = true, allowWorktreeRelocation = false }) =>
    requireCheckpointIntegrity({ worktree: repository, featureSlug, executionWorktree, checkExecutionWorktree, allowWorktreeRelocation });

  return {
    integrity,
    async initialize({ repository, featureSlug, checkpoint }) {
      return withFeatureLock(repository, featureSlug, async () => {
        await writeCheckpoint(repository, featureSlug, checkpoint);
        return checkpoint;
      });
    },
    async persist({ repository, featureSlug, checkpoint, executionWorktree, checkExecutionWorktree = false, allowWorktreeRelocation = false }) {
      return withFeatureLock(repository, featureSlug, async () => {
        await integrity({ repository, featureSlug, executionWorktree, checkExecutionWorktree, allowWorktreeRelocation });
        await writeCheckpoint(repository, featureSlug, checkpoint);
        return checkpoint;
      });
    },
    async transition({ repository, featureSlug, executionWorktree, checkExecutionWorktree = true, apply }) {
      return withFeatureLock(repository, featureSlug, async () => {
        const current = await integrity({ repository, featureSlug, executionWorktree, checkExecutionWorktree });
        const checkpoint = await apply(current);
        await writeCheckpoint(repository, featureSlug, checkpoint);
        return { ...current, checkpoint };
      });
    },
  };
}
