import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("split plan keeps task commits through serial no-ff merges and aborts conflicts cleanly", (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "split-plan-git-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "AI Work Flow Test");
  git(root, "config", "user.email", "test@example.invalid");
  writeFileSync(resolve(root, "shared.txt"), "base\n");
  const tasksDirectory = resolve(root, ".ai-work-flow", "plans", "example-plan", "tasks");
  mkdirSync(tasksDirectory, { recursive: true });
  const taskOnePath = resolve(tasksDirectory, "01-task-one.md");
  const taskTwoPath = resolve(tasksDirectory, "02-task-two.md");
  const taskBody = (id) => `# ${id}\n\n- [ ] implement\n- [ ] accept\n- [ ] verify\n`;
  writeFileSync(taskOnePath, taskBody("task-one"));
  writeFileSync(taskTwoPath, taskBody("task-two"));
  git(root, "add", "--", "shared.txt", ".ai-work-flow/plans/example-plan/tasks/01-task-one.md", ".ai-work-flow/plans/example-plan/tasks/02-task-two.md");
  git(root, "commit", "-m", "base");
  const mainBase = git(root, "rev-parse", "HEAD");

  const planBranch = "ai-work-flow/example-plan/integration";
  const taskOneBranch = "ai-work-flow/example-plan/tasks/task-one";
  const taskTwoBranch = "ai-work-flow/example-plan/tasks/task-two";
  git(root, "branch", planBranch, mainBase);
  git(root, "branch", taskOneBranch, mainBase);
  git(root, "branch", taskTwoBranch, mainBase);

  const planWorktree = resolve(root, ".worktrees", "example-plan");
  const taskOneWorktree = resolve(root, ".worktrees", "example-plan--task-one");
  const taskTwoWorktree = resolve(root, ".worktrees", "example-plan--task-two");
  git(root, "worktree", "add", planWorktree, planBranch);
  git(root, "worktree", "add", taskOneWorktree, taskOneBranch);
  git(root, "worktree", "add", taskTwoWorktree, taskTwoBranch);

  writeFileSync(resolve(taskOneWorktree, "one.txt"), "one\n");
  git(taskOneWorktree, "add", "--", "one.txt");
  git(taskOneWorktree, "commit", "-m", "task one");
  const taskOneSha = git(taskOneWorktree, "rev-parse", "HEAD");
  writeFileSync(resolve(taskTwoWorktree, "two.txt"), "two\n");
  git(taskTwoWorktree, "add", "--", "two.txt");
  git(taskTwoWorktree, "commit", "-m", "task two");
  const taskTwoSha = git(taskTwoWorktree, "rev-parse", "HEAD");

  git(planWorktree, "merge", "--no-ff", taskOneSha, "-m", "integrate task one");
  const taskOneMergeSha = git(planWorktree, "rev-parse", "HEAD");
  const planTaskOnePath = resolve(planWorktree, ".ai-work-flow", "plans", "example-plan", "tasks", "01-task-one.md");
  writeFileSync(planTaskOnePath, readFileSync(planTaskOnePath, "utf8").replaceAll("- [ ]", "- [x]"));
  git(planWorktree, "add", "--", ".ai-work-flow/plans/example-plan/tasks/01-task-one.md");
  git(planWorktree, "commit", "-m", "complete task one");
  const taskOneCompletionSha = git(planWorktree, "rev-parse", "HEAD");
  git(planWorktree, "merge", "--no-ff", taskTwoSha, "-m", "integrate task two");
  const taskTwoMergeSha = git(planWorktree, "rev-parse", "HEAD");
  const planTaskTwoPath = resolve(planWorktree, ".ai-work-flow", "plans", "example-plan", "tasks", "02-task-two.md");
  writeFileSync(planTaskTwoPath, readFileSync(planTaskTwoPath, "utf8").replaceAll("- [ ]", "- [x]"));
  git(planWorktree, "add", "--", ".ai-work-flow/plans/example-plan/tasks/02-task-two.md");
  git(planWorktree, "commit", "-m", "complete task two");
  const planSha = git(planWorktree, "rev-parse", "HEAD");
  assert.equal(git(planWorktree, "merge-base", "--is-ancestor", taskOneSha, planSha), "");
  assert.equal(git(planWorktree, "merge-base", "--is-ancestor", taskTwoSha, planSha), "");
  assert.equal(git(planWorktree, "merge-base", "--is-ancestor", taskOneMergeSha, taskOneCompletionSha), "");
  assert.equal(git(planWorktree, "rev-list", "--parents", "-n", "1", taskOneMergeSha).split(" ").length, 3);
  assert.equal(git(planWorktree, "rev-list", "--parents", "-n", "1", taskTwoMergeSha).split(" ").length, 3);
  assert.doesNotMatch(readFileSync(planTaskOnePath, "utf8"), /- \[ \]/);
  assert.doesNotMatch(readFileSync(planTaskTwoPath, "utf8"), /- \[ \]/);
  assert.match(readFileSync(planTaskOnePath, "utf8"), /- \[x\]/);
  assert.match(readFileSync(planTaskTwoPath, "utf8"), /- \[x\]/);

  const conflictBranch = "ai-work-flow/example-plan/tasks/conflicting-task";
  const conflictWorktree = resolve(root, ".worktrees", "example-plan--conflicting-task");
  git(root, "branch", conflictBranch, planSha);
  git(root, "worktree", "add", conflictWorktree, conflictBranch);
  writeFileSync(resolve(conflictWorktree, "shared.txt"), "task change\n");
  git(conflictWorktree, "add", "--", "shared.txt");
  git(conflictWorktree, "commit", "-m", "conflicting task");
  const conflictSha = git(conflictWorktree, "rev-parse", "HEAD");
  writeFileSync(resolve(planWorktree, "shared.txt"), "plan change\n");
  git(planWorktree, "add", "--", "shared.txt");
  git(planWorktree, "commit", "-m", "plan-side change");

  assert.throws(() => git(planWorktree, "merge", "--no-ff", conflictSha, "-m", "conflict"));
  assert.deepEqual(git(planWorktree, "diff", "--name-only", "--diff-filter=U").split("\n"), ["shared.txt"]);
  git(planWorktree, "merge", "--abort");
  assert.equal(git(planWorktree, "status", "--porcelain=v1"), "");
  assert.equal(git(conflictWorktree, "rev-parse", "HEAD"), conflictSha);
});
