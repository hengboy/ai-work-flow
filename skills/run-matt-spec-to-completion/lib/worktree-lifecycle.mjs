import { access, lstat, mkdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { git, gitSucceeds, repoRoot } from "./git.mjs";

function parseWorktrees(output) {
  const entries = [];
  let current = {};
  for (const line of output.split("\n")) {
    if (!line) {
      if (current.worktree) entries.push(current);
      current = {};
      continue;
    }
    const [key, ...rest] = line.split(" ");
    current[key] = rest.join(" ");
  }
  if (current.worktree) entries.push(current);
  return entries;
}

export async function findExecutionWorktree(repository, branch) {
  const target = `refs/heads/${branch}`;
  const entries = parseWorktrees(await git(repository, ["worktree", "list", "--porcelain"]));
  return entries.find((entry) => entry.branch === target)?.worktree || null;
}

export async function worktreeIsClean(worktree) {
  return (await git(worktree, ["status", "--porcelain"])) === "";
}

async function assertNoSymlinkPathChain(root, target) {
  const relativeTarget = relative(root, target);
  let current = root;
  for (const segment of relativeTarget.split(sep).slice(0, -1)) {
    current = resolve(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Worktree path contains a symbolic-link parent: ${current}`);
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }
}

async function prepareNewWorktreePath(repository, root, path) {
  const target = resolve(path);
  const repositoryPath = relative(resolve(repository), target);
  if (!repositoryPath || repositoryPath === ".." || repositoryPath.startsWith(`..${sep}`)) {
    throw new Error(`Execution worktree path must be inside the repository: ${target}`);
  }
  const canonicalTarget = resolve(root, repositoryPath);
  await assertNoSymlinkPathChain(root, canonicalTarget);
  try {
    await access(canonicalTarget);
    throw new Error(`Worktree path already exists: ${canonicalTarget}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(canonicalTarget), { recursive: true });
  await assertNoSymlinkPathChain(root, canonicalTarget);
  return canonicalTarget;
}

async function verifyCreatedWorktree(root, target, branch) {
  if (resolve(await repoRoot(target)) !== target) throw new Error("Created worktree root does not match requested path");
  if (await git(target, ["branch", "--show-current"]) !== branch) throw new Error("Created worktree branch does not match requested branch");
  const [mainCommonDir, executionCommonDir] = await Promise.all([
    git(root, ["rev-parse", "--git-common-dir"]),
    git(target, ["rev-parse", "--git-common-dir"]),
  ]);
  if (resolve(root, mainCommonDir) !== resolve(target, executionCommonDir)) {
    throw new Error("Created worktree does not share the repository Git common directory");
  }
}

export async function ensureExecutionWorktree({ repository, branch, path }) {
  const root = await repoRoot(repository);
  const existing = await findExecutionWorktree(root, branch);
  if (existing) return { worktree: existing, created: false };
  if (!await gitSucceeds(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) {
    throw new Error(`Execution branch ${branch} does not exist`);
  }
  const target = await prepareNewWorktreePath(repository, root, path);
  await git(root, ["worktree", "add", target, branch]);
  await verifyCreatedWorktree(root, target, branch);
  return { worktree: target, created: true };
}

export async function createExecutionWorktree({ repository, branch, baseline, path }) {
  const root = await repoRoot(repository);
  const target = await prepareNewWorktreePath(repository, root, path);
  await git(root, ["worktree", "add", "-b", branch, target, baseline]);
  await verifyCreatedWorktree(root, target, branch);
  return target;
}

export async function removeExecutionWorktree({ repository, worktree }) {
  const root = await repoRoot(repository);
  if (!await worktreeIsClean(worktree)) throw new Error(`Execution worktree is not clean: ${worktree}`);
  await git(root, ["worktree", "remove", worktree]);
}

export async function findMainWorktree(repository) {
  return findExecutionWorktree(repository, "main");
}
