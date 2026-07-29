import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createExecutionWorktree, ensureExecutionWorktree } from "../lib/worktree-lifecycle.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "worktree-lifecycle-"));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test User");
  await writeFile(join(root, "README.md"), "fixture\n");
  await git(root, "add", "README.md");
  await git(root, "commit", "-m", "fixture");
  return root;
}

test("creates locally excluded worktrees and only restores the matching path", async () => {
  const root = await fixture();
  const branch = "ai-work-flow/example";
  const path = join(root, ".worktrees", "example");
  await createExecutionWorktree({ repository: root, branch, baseline: "main", path });

  assert.match(await git(root, "check-ignore", "-v", ".worktrees/example"), /\.worktrees/);
  const restored = await ensureExecutionWorktree({ repository: root, branch, path });
  assert.equal(restored.created, false);
  assert.equal(await git(restored.worktree, "branch", "--show-current"), branch);
  await assert.rejects(
    ensureExecutionWorktree({ repository: root, branch, path: join(root, ".worktrees", "other") }),
    /already attached to a different worktree/,
  );
});
