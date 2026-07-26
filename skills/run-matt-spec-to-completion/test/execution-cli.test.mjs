import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const cli = new URL("../../../execution-runtime/execution-cli.mjs", import.meta.url);

async function git(cwd, ...args) {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "execution-cli-"));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test User");
  const directory = join(root, ".scratch", "cli-flow");
  await mkdir(join(directory, "issues"), { recursive: true });
  await writeFile(join(directory, "spec.md"), "# CLI flow\n");
  await writeFile(join(directory, "issues", "01-work.md"), "# 01 - Work\n\n**Blocked by:** None - can start immediately\n");
  await writeFile(join(root, ".gitignore"), ".worktrees/\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "fixture");
  return { root, spec: ".scratch/cli-flow/spec.md", worktree: join(root, ".worktrees", "execution") };
}

async function invoke(paths, command, args = [], input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli.pathname, command, "--repository", paths.root, ...args], { cwd: paths.root });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `exit ${code}`));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
    child.stdin.end(input);
  });
}

test("execution CLI claims once and records only a JSON Handoff envelope", async () => {
  const paths = await fixture();
  await invoke(paths, "prepare", ["--branch", "feat/cli-flow", "--spec", paths.spec, "--worktree", paths.worktree]);
  const claims = await Promise.allSettled(Array.from({ length: 4 }, () => invoke(paths, "claim", ["--feature", "cli-flow", "--worktree", paths.worktree])));
  assert.equal(claims.filter((claim) => claim.status === "fulfilled").length, 1);
  const blocked = { role_id: "full-stack-coder", status: "blocked", summary: "cannot continue", artifacts: [], checks: [], error: "fixture", payload: { ticket_id: "01", status: "blocked", commits: [], tests: [], summary: "cannot continue", error: "fixture" } };
  const recorded = await invoke(paths, "record-ticket", ["--feature", "cli-flow", "--worktree", paths.worktree], JSON.stringify(blocked));
  assert.equal(recorded.status, "blocked");
  await assert.rejects(
    invoke(paths, "record-ticket", ["--feature", "cli-flow", "--worktree", paths.worktree], JSON.stringify(blocked.payload)),
    /Handoff Result violates schema/,
  );
});

test("execution CLI rejects an absolute legacy worktree without rewriting it", async () => {
  const paths = await fixture();
  await invoke(paths, "prepare", ["--branch", "feat/cli-flow", "--spec", paths.spec, "--worktree", paths.worktree]);
  const path = join(paths.root, ".scratch", "cli-flow", "checkpoint.json");
  const checkpoint = JSON.parse(await readFile(path, "utf8"));
  checkpoint.worktree = paths.worktree;
  await writeFile(path, `${JSON.stringify(checkpoint)}\n`);
  await assert.rejects(invoke(paths, "status", ["--feature", "cli-flow", "--worktree", paths.worktree]), /Checkpoint violates schema|repository-relative path/);
  assert.equal(JSON.parse(await readFile(path, "utf8")).worktree, paths.worktree);
});

test("execution CLI completes review and integration through the same feature lock", async () => {
  const paths = await fixture();
  await invoke(paths, "prepare", ["--branch", "feat/cli-flow", "--spec", paths.spec, "--worktree", paths.worktree]);
  await invoke(paths, "claim", ["--feature", "cli-flow", "--worktree", paths.worktree]);
  await writeFile(join(paths.worktree, "completed.txt"), "done\n");
  await git(paths.worktree, "add", "completed.txt");
  await git(paths.worktree, "commit", "-m", "complete ticket");
  const commit = await git(paths.worktree, "rev-parse", "HEAD");
  const handoff = { role_id: "full-stack-coder", status: "done", summary: "completed", artifacts: ["completed.txt"], checks: [], payload: { ticket_id: "01", status: "done", commits: [commit], tests: [], summary: "completed" } };
  await invoke(paths, "record-ticket", ["--feature", "cli-flow", "--worktree", paths.worktree], JSON.stringify(handoff));
  await invoke(paths, "record-review", ["--feature", "cli-flow"], JSON.stringify({ findings_summary: "approved" }));
  await invoke(paths, "review-decision", ["--feature", "cli-flow"], JSON.stringify({ decision: "approve" }));
  const integrated = await invoke(paths, "integrate", ["--feature", "cli-flow", "--worktree", paths.worktree]);
  assert.equal(integrated.status, "complete");
});

test("prepare rejects a symbolic-link worktree parent before creating a worktree", async () => {
  const paths = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "execution-cli-outside-"));
  const linked = join(paths.root, "linked-worktrees");
  await symlink(outside, linked);
  await assert.rejects(
    invoke(paths, "prepare", ["--branch", "feat/cli-flow", "--spec", paths.spec, "--worktree", join(linked, "execution")]),
    /symbolic-link parent/,
  );
  assert.equal((await git(paths.root, "worktree", "list", "--porcelain")).split("\n").filter((line) => line.startsWith("worktree ")).length, 1);
});

test("only the runtime state store imports the checkpoint writer", async () => {
  const [orchestrator, lifecycle, stateStore] = await Promise.all([
    readFile(new URL("../lib/execution-orchestrator.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/integration-lifecycle.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../../execution-runtime/state-store.mjs", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(orchestrator, /writeCheckpoint|checkpointWriter/);
  assert.doesNotMatch(lifecycle, /writeCheckpoint/);
  assert.match(stateStore, /writeCheckpoint/);
});
