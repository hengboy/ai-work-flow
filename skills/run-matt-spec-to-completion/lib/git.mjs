import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function gitOutput(cwd, args) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
    return stdout;
  } catch (error) {
    const detail = error.stderr?.trim() || error.message;
    throw new Error(`git ${args.join(" ")} failed: ${detail}`, { cause: error });
  }
}

export async function git(cwd, args) {
  return (await gitOutput(cwd, args)).trim();
}

export async function gitSucceeds(cwd, args) {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

export async function gitSucceedsWithInput(cwd, args, input) {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
    child.stdin.end(input);
  });
}

export async function repoRoot(cwd) {
  return git(cwd, ["rev-parse", "--show-toplevel"]);
}

export async function currentHead(cwd) {
  return git(cwd, ["rev-parse", "HEAD"]);
}

export async function isAncestor(cwd, ancestor, descendant = "HEAD") {
  return gitSucceeds(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
}
