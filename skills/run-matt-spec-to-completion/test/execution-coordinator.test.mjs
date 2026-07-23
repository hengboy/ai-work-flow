import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { beginReview, completeIntegration, completeReview, completeTicket, createCheckpoint, markMerged, readCheckpoint, startTickets, writeCheckpoint } from "../lib/checkpoint.mjs";
import { createExecutionCoordinator } from "../lib/execution-coordinator.mjs";
import { materializeLocalSpec, writeExecutionPlan } from "../lib/execution-plan.mjs";
import { assertCheckpoint } from "../lib/validation.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function coordinatorFixture() {
  const root = await mkdtemp(join(tmpdir(), "run-plan-coordinator-"));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test User");
  const directory = join(root, ".scratch", "migrate-runtime");
  await mkdir(join(directory, "issues"), { recursive: true });
  const specPath = join(directory, "spec.md");
  await writeFile(specPath, "# Migrate runtime\n");
  await writeFile(join(directory, "issues", "01-contract.md"), "# 01 — Contract\n\n**Blocked by:** None — can start immediately\n\n- [ ] Verify runtime contract\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "fixture");
  const head = await git(root, "rev-parse", "HEAD");
  const executionPlan = await materializeLocalSpec({ mainWorktree: root, specPath, now: new Date("2026-07-23T12:00:00+08:00") });
  await writeExecutionPlan(root, executionPlan);
  let checkpoint = createCheckpoint({ executionPlan, baseline: head, branch: "feat/migrate-runtime", worktree: root, now: new Date("2026-07-23T12:00:00+08:00") });
  checkpoint = startTickets(checkpoint, ["01"], head);
  checkpoint = completeTicket(checkpoint, "01", head);
  checkpoint = beginReview(checkpoint);
  checkpoint = completeReview(checkpoint, "approved");
  checkpoint = markMerged(checkpoint, { executionHead: head, mainWorktree: root, mergedCommit: head });
  return { root, executionPlan, checkpoint };
}

async function pendingIntegrationFixture() {
  const { root, executionPlan } = await coordinatorFixture();
  const head = await git(root, "rev-parse", "HEAD");
  let checkpoint = createCheckpoint({ executionPlan, baseline: head, branch: "feat/migrate-runtime", worktree: root });
  checkpoint = startTickets(checkpoint, ["01"], head);
  checkpoint = completeTicket(checkpoint, "01", head);
  checkpoint = beginReview(checkpoint);
  checkpoint = completeReview(checkpoint, "approved");
  const executionWorktree = `${root}-execution`;
  await git(root, "worktree", "add", "-b", "feat/migrate-runtime", executionWorktree);
  checkpoint = { ...checkpoint, worktree: executionWorktree };
  await writeCheckpoint(root, "migrate-runtime", checkpoint);
  return { root, executionPlan, checkpoint, executionWorktree };
}

test("requires canonical specPath before either initialization or resume", async () => {
  const coordinator = createExecutionCoordinator();
  await assert.rejects(
    coordinator.run({ repository: "/not-used", branch: "feat/migrate-runtime" }),
    /canonical specPath is required to initialize or resume/,
  );
});

test("keeps merged cleanup recoverable when final record commit fails", async () => {
  const { root, executionPlan, checkpoint } = await coordinatorFixture();
  const unrelatedPath = join(root, "unrelated.txt");
  await writeFile(unrelatedPath, "preserve this change\n");
  await git(root, "stash", "push", "--include-untracked", "--message", "fixture-unrelated-change", "--", "unrelated.txt");
  const stashRef = await git(root, "rev-parse", "refs/stash");
  const checkpointWithStash = {
    ...checkpoint,
    integration: { ...checkpoint.integration, stash_ref: stashRef },
  };
  await writeCheckpoint(root, "migrate-runtime", checkpointWithStash);
  const failingCoordinator = createExecutionCoordinator({
    generateCommitMessage: async () => {
      throw new Error("commit generator unavailable");
    },
  });

  await assert.rejects(
    failingCoordinator.completeMergedCleanup({ repository: root, mainWorktree: root, featureSlug: "migrate-runtime", executionPlan, checkpoint: checkpointWithStash }),
    /commit generator unavailable/,
  );
  const recoverable = await readCheckpoint(root, "migrate-runtime");
  assert.equal(recoverable.status, "integrating");
  assert.equal(recoverable.integration.status, "merged");
  assert.equal(recoverable.integration.stash_restored, true);
  assert.equal(recoverable.integration.stash_ref, stashRef);
  assert.equal(await readFile(unrelatedPath, "utf8"), "preserve this change\n");

  const coordinator = createExecutionCoordinator({ generateCommitMessage: async () => "chore: record execution" });
  const result = await coordinator.completeMergedCleanup({
    repository: root,
    mainWorktree: root,
    featureSlug: "migrate-runtime",
    executionPlan,
    checkpoint: recoverable,
  });

  assert.equal(result.status, "complete");
  assert.equal((await readCheckpoint(root, "migrate-runtime")).status, "complete");
  assert.equal(await git(root, "log", "-1", "--format=%s"), "chore: record execution");

  const resumed = await coordinator.resume({
    repository: root,
    branch: "feat/migrate-runtime",
    specPath: ".scratch/migrate-runtime/spec.md",
    featureSlug: "untrusted-plan-id",
    worktreePath: join(root, "unused-worktree"),
  });
  assert.equal(resumed.status, "complete");
});

test("reports an explicitly recorded but unavailable stash during merged cleanup", async () => {
  const { root, executionPlan, checkpoint, executionWorktree } = await pendingIntegrationFixture();
  const unavailableStash = "b".repeat(40);
  const head = await git(root, "rev-parse", "HEAD");
  const checkpointWithStash = markMerged(checkpoint, { executionHead: head, mainWorktree: root, mergedCommit: head, stashRef: unavailableStash });
  await writeCheckpoint(root, "migrate-runtime", checkpointWithStash);

  const coordinator = createExecutionCoordinator({ generateCommitMessage: async () => "chore: record execution" });
  await assert.rejects(
    coordinator.completeMergedCleanup({ repository: root, mainWorktree: root, featureSlug: "migrate-runtime", executionPlan, checkpoint: checkpointWithStash }),
    new RegExp(`Checkpoint requires stash ${unavailableStash}, but that stash is unavailable`),
  );
  assert.equal((await readCheckpoint(root, "migrate-runtime")).integration.stash_ref, unavailableStash);
  assert.match(await git(root, "worktree", "list", "--porcelain"), new RegExp(executionWorktree));
});

test("does not commit terminal records when their checkpoint fails integrity", async () => {
  const { root, executionPlan, checkpoint } = await coordinatorFixture();
  const invalidComplete = completeIntegration({
    ...checkpoint,
    integration: { ...checkpoint.integration, execution_head: "b".repeat(40) },
  });
  await writeCheckpoint(root, "migrate-runtime", invalidComplete);
  const headBefore = await git(root, "rev-parse", "HEAD");
  let generated = false;
  const coordinator = createExecutionCoordinator({
    generateCommitMessage: async () => {
      generated = true;
      return "chore: record execution";
    },
  });

  await assert.rejects(
    coordinator.completeMergedCleanup({ repository: root, mainWorktree: root, featureSlug: "migrate-runtime", executionPlan, checkpoint: invalidComplete }),
    /Checkpoint integrity failed/,
  );
  assert.equal(generated, false);
  assert.equal(await git(root, "rev-parse", "HEAD"), headBefore);
});

test("recovers a stash application after its restored checkpoint write fails", async () => {
  const { root, executionPlan, checkpoint } = await coordinatorFixture();
  const unrelatedPath = join(root, "unrelated.txt");
  await writeFile(unrelatedPath, "preserve this change\n");
  await git(root, "stash", "push", "--include-untracked", "--message", "fixture-unrelated-change", "--", "unrelated.txt");
  const stashRef = await git(root, "rev-parse", "refs/stash");
  const checkpointWithStash = { ...checkpoint, integration: { ...checkpoint.integration, stash_ref: stashRef } };
  await writeCheckpoint(root, "migrate-runtime", checkpointWithStash);
  let failed = false;
  const failingCoordinator = createExecutionCoordinator({
    checkpointWriter: async (worktree, featureSlug, next) => {
      if (!failed && next.integration.stash_restore_state === "restored") {
        failed = true;
        throw new Error("checkpoint storage unavailable");
      }
      return writeCheckpoint(worktree, featureSlug, next);
    },
    generateCommitMessage: async () => "chore: record execution",
  });

  await assert.rejects(
    failingCoordinator.completeMergedCleanup({ repository: root, mainWorktree: root, featureSlug: "migrate-runtime", executionPlan, checkpoint: checkpointWithStash }),
    /checkpoint storage unavailable/,
  );
  const interrupted = await readCheckpoint(root, "migrate-runtime");
  assert.equal(interrupted.integration.stash_restore_state, "applying");
  assert.equal(await readFile(unrelatedPath, "utf8"), "preserve this change\n");
  assert.equal(await git(root, "rev-parse", "refs/stash"), stashRef);

  const coordinator = createExecutionCoordinator({ generateCommitMessage: async () => "chore: record execution" });
  const resumed = await coordinator.resume({
    repository: root,
    branch: "feat/migrate-runtime",
    specPath: ".scratch/migrate-runtime/spec.md",
    worktreePath: join(root, "unused-worktree"),
  });

  assert.equal(resumed.status, "complete");
  assert.equal((await readCheckpoint(root, "migrate-runtime")).status, "complete");
  assert.equal(await readFile(unrelatedPath, "utf8"), "preserve this change\n");
  assert.equal(await git(root, "stash", "list", "--format=%H"), "");
});

test("reconciles a dropped restored stash when its cleanup checkpoint write fails", async () => {
  const { root, executionPlan, checkpoint } = await coordinatorFixture();
  await writeFile(join(root, "unrelated.txt"), "preserve this change\n");
  await git(root, "stash", "push", "--include-untracked", "--message", "fixture-unrelated-change", "--", "unrelated.txt");
  const stashRef = await git(root, "rev-parse", "refs/stash");
  const checkpointWithStash = { ...checkpoint, integration: { ...checkpoint.integration, stash_ref: stashRef } };
  await writeCheckpoint(root, "migrate-runtime", checkpointWithStash);
  const failingCoordinator = createExecutionCoordinator({
    checkpointWriter: async (worktree, featureSlug, next) => {
      if (next.integration.stash_cleanup_state === "dropped") throw new Error("checkpoint storage unavailable");
      return writeCheckpoint(worktree, featureSlug, next);
    },
    generateCommitMessage: async () => "chore: record execution",
  });

  await assert.rejects(
    failingCoordinator.completeMergedCleanup({ repository: root, mainWorktree: root, featureSlug: "migrate-runtime", executionPlan, checkpoint: checkpointWithStash }),
    /checkpoint storage unavailable/,
  );
  const interrupted = await readCheckpoint(root, "migrate-runtime");
  assert.equal(interrupted.integration.stash_restore_state, "restored");
  assert.equal(interrupted.integration.stash_cleanup_state, "pending");
  assert.equal(await git(root, "stash", "list", "--format=%H"), "");

  const result = await createExecutionCoordinator({ generateCommitMessage: async () => "chore: record execution" }).completeMergedCleanup({
    repository: root,
    mainWorktree: root,
    featureSlug: "migrate-runtime",
    executionPlan,
    checkpoint: interrupted,
  });
  assert.equal(result.status, "complete");
  assert.equal(await readFile(join(root, "unrelated.txt"), "utf8"), "preserve this change\n");
});

test("records a pre-merge stash operation before its stash reference can be persisted", async () => {
  const { root, executionPlan, checkpoint, executionWorktree } = await pendingIntegrationFixture();
  await writeFile(join(executionWorktree, "execution.txt"), "execution change\n");
  await git(executionWorktree, "add", "execution.txt");
  await git(executionWorktree, "commit", "-m", "execution change");
  await writeFile(join(root, "unrelated.txt"), "preserve this change\n");
  const headBefore = await git(root, "rev-parse", "HEAD");
  const failingCoordinator = createExecutionCoordinator({
    checkpointWriter: async (worktree, featureSlug, next) => {
      if (next.integration.stash_ref) throw new Error("checkpoint storage unavailable");
      return writeCheckpoint(worktree, featureSlug, next);
    },
    generateCommitMessage: async () => "chore: record execution",
  });

  await assert.rejects(
    failingCoordinator.integrate({ repository: root, worktree: executionWorktree, featureSlug: "migrate-runtime", executionPlan, checkpoint }),
    /checkpoint storage unavailable/,
  );
  const recoverable = await readCheckpoint(root, "migrate-runtime");
  assert.ok(recoverable.integration.stash_operation_id);
  assert.equal(recoverable.integration.stash_ref, undefined);
  assert.notEqual(await git(root, "stash", "list", "--format=%H"), "");
  assert.equal(await git(root, "rev-parse", "HEAD"), headBefore);

  const coordinator = createExecutionCoordinator({ generateCommitMessage: async () => "chore: record execution" });
  const resumed = await coordinator.resume({ repository: root, branch: "feat/migrate-runtime", specPath: ".scratch/migrate-runtime/spec.md", worktreePath: executionWorktree });
  assert.equal(resumed.status, "resumed");
  const completed = await coordinator.integrate({ repository: root, worktree: resumed.worktree, featureSlug: "migrate-runtime", executionPlan, checkpoint: resumed.checkpoint });
  assert.equal(completed.status, "complete");
  assert.equal(await readFile(join(root, "unrelated.txt"), "utf8"), "preserve this change\n");
});

test("does not stash, merge, or remove a worktree when integration integrity is invalid", async () => {
  const { root, executionPlan, checkpoint, executionWorktree } = await pendingIntegrationFixture();
  const invalid = { ...checkpoint, baseline: "b".repeat(40) };
  await writeCheckpoint(root, "migrate-runtime", invalid);
  const checkpointFile = join(root, ".scratch", "migrate-runtime", "checkpoint.json");
  const before = await readFile(checkpointFile, "utf8");
  const head = await git(root, "rev-parse", "HEAD");
  await writeFile(join(root, "unrelated.txt"), "preserve this change\n");

  await assert.rejects(
    createExecutionCoordinator().integrate({ repository: root, worktree: executionWorktree, featureSlug: "migrate-runtime", executionPlan, checkpoint: invalid }),
    /Checkpoint integrity failed/,
  );
  assert.equal(await readFile(checkpointFile, "utf8"), before);
  assert.equal(await git(root, "rev-parse", "HEAD"), head);
  assert.equal(await readFile(join(root, "unrelated.txt"), "utf8"), "preserve this change\n");
  assert.equal(await git(root, "stash", "list", "--format=%H"), "");
  assert.match(await git(root, "worktree", "list", "--porcelain"), new RegExp(executionWorktree));
});

test("keeps undispatched tasks pending after the first serial blocked result", async () => {
  const { root, executionPlan, executionWorktree } = await pendingIntegrationFixture();
  await writeFile(join(root, ".scratch", "migrate-runtime", "tasks", "02-follow-up.md"), "# Follow up\n");
  const specPath = join(root, ".scratch", "migrate-runtime", "spec.md");
  const twoTaskPlan = await materializeLocalSpec({ mainWorktree: root, specPath });
  await writeExecutionPlan(root, twoTaskPlan);
  const head = await git(root, "rev-parse", "HEAD");
  const checkpoint = createCheckpoint({ executionPlan: twoTaskPlan, baseline: head, branch: "feat/migrate-runtime", worktree: executionWorktree });
  await writeCheckpoint(root, "migrate-runtime", checkpoint);
  const dispatched = [];
  const coordinator = createExecutionCoordinator({
    adapter: {
      async executeFrontier({ tickets: tasks }) {
        dispatched.push(...tasks.map((task) => task.id));
        return [{ ticket_id: "01", status: "blocked", commits: [], tests: [], summary: "blocked", error: "stop" }];
      },
    },
  });

  const result = await coordinator.executeFrontier({ worktree: executionWorktree, mainWorktree: root, featureSlug: "migrate-runtime", executionPlan: twoTaskPlan, checkpoint });
  assert.deepEqual(dispatched, ["01"]);
  assert.equal(result.checkpoint.tickets.find((task) => task.id === "01").status, "blocked");
  assert.equal(result.checkpoint.tickets.find((task) => task.id === "02").status, "pending");
});

test("does not redispatch an in-progress task on recovery", async () => {
  const { root, executionPlan, executionWorktree } = await pendingIntegrationFixture();
  const head = await git(root, "rev-parse", "HEAD");
  const checkpoint = startTickets(createCheckpoint({ executionPlan, baseline: head, branch: "feat/migrate-runtime", worktree: executionWorktree }), ["01"], head);
  await writeCheckpoint(root, "migrate-runtime", checkpoint);
  let dispatched = false;
  const coordinator = createExecutionCoordinator({ adapter: { async executeFrontier() { dispatched = true; return []; } } });

  const result = await coordinator.executeFrontier({ worktree: executionWorktree, mainWorktree: root, featureSlug: "migrate-runtime", executionPlan, checkpoint });
  assert.equal(result.status, "blocked");
  assert.equal(dispatched, false);
  assert.equal((await readCheckpoint(root, "migrate-runtime")).tickets[0].status, "in_progress");
});

test("recovers a pre-merge restoration after its restored checkpoint write fails", async () => {
  const { root, executionPlan, checkpoint, executionWorktree } = await pendingIntegrationFixture();
  const conflict = join(executionWorktree, "conflict.txt");
  await writeFile(conflict, "execution branch\n");
  await git(executionWorktree, "add", "conflict.txt");
  await git(executionWorktree, "commit", "-m", "execution conflict");
  await writeFile(join(root, "conflict.txt"), "main branch\n");
  await git(root, "add", "conflict.txt");
  await git(root, "commit", "-m", "main conflict");
  await writeFile(join(root, "unrelated.txt"), "preserve this change\n");
  let failed = false;
  const failingCoordinator = createExecutionCoordinator({
    checkpointWriter: async (worktree, featureSlug, next) => {
      if (!failed && next.integration.stash_restore_state === "restored") {
        failed = true;
        throw new Error("checkpoint storage unavailable");
      }
      return writeCheckpoint(worktree, featureSlug, next);
    },
  });

  await assert.rejects(
    failingCoordinator.integrate({ repository: root, worktree: executionWorktree, featureSlug: "migrate-runtime", executionPlan, checkpoint }),
    /checkpoint storage unavailable/,
  );
  const interrupted = await readCheckpoint(root, "migrate-runtime");
  assert.equal(interrupted.integration.stash_restore_state, "applying");
  assert.equal(await readFile(join(root, "unrelated.txt"), "utf8"), "preserve this change\n");

  const coordinator = createExecutionCoordinator();
  const resumed = await coordinator.resume({ repository: root, branch: "feat/migrate-runtime", specPath: ".scratch/migrate-runtime/spec.md", worktreePath: executionWorktree });
  await assert.rejects(
    coordinator.integrate({ repository: root, worktree: resumed.worktree, featureSlug: "migrate-runtime", executionPlan, checkpoint: resumed.checkpoint }),
    /git merge --no-edit plan\/migrate-runtime failed/,
  );
  const recovered = await readCheckpoint(root, "migrate-runtime");
  assert.equal(recovered.integration.stash_ref, undefined);
  assert.equal(recovered.integration.stash_restore_state, undefined);
  assert.equal(await readFile(join(root, "unrelated.txt"), "utf8"), "preserve this change\n");
  assert.equal(await git(root, "stash", "list", "--format=%H"), "");
});

test("does not mutate an invalid checkpoint while attempting a relocated resume", async () => {
  const { root, executionPlan } = await coordinatorFixture();
  const invalid = createCheckpoint({
    executionPlan,
    baseline: "b".repeat(40),
    branch: "feat/migrate-runtime",
    worktree: join(root, "former-execution-worktree"),
  });
  await writeCheckpoint(root, "migrate-runtime", invalid);
  const checkpointFile = join(root, ".scratch", "migrate-runtime", "checkpoint.json");
  const before = await readFile(checkpointFile, "utf8");
  const headBefore = await git(root, "rev-parse", "HEAD");
  let writes = 0;
  const coordinator = createExecutionCoordinator({
    checkpointWriter: async (...args) => {
      writes += 1;
      return writeCheckpoint(...args);
    },
  });

  await assert.rejects(
    coordinator.resume({ repository: root, branch: "feat/migrate-runtime", specPath: ".scratch/migrate-runtime/spec.md", worktreePath: join(root, "recreated-worktree") }),
    /Checkpoint integrity failed/,
  );
  assert.equal(writes, 0);
  assert.equal(await readFile(checkpointFile, "utf8"), before);
  assert.equal(await git(root, "rev-parse", "HEAD"), headBefore);
});

test("rejects complete checkpoints with pending work before terminal handling", async () => {
  const { root, checkpoint } = await coordinatorFixture();
  const invalidComplete = completeIntegration(checkpoint);
  invalidComplete.tickets[0] = { id: "01", status: "pending" };
  const checkpointFile = join(root, ".scratch", "migrate-runtime", "checkpoint.json");
  const serialized = `${JSON.stringify(invalidComplete, null, 2)}\n`;
  await writeFile(checkpointFile, serialized);
  const headBefore = await git(root, "rev-parse", "HEAD");
  let writes = 0;
  let generated = false;
  const coordinator = createExecutionCoordinator({
    checkpointWriter: async (...args) => {
      writes += 1;
      return writeCheckpoint(...args);
    },
    generateCommitMessage: async () => {
      generated = true;
      return "chore: record execution";
    },
  });

  await assert.rejects(
    coordinator.resume({ repository: root, branch: "feat/migrate-runtime", specPath: ".scratch/migrate-runtime/spec.md", worktreePath: join(root, "unused-worktree") }),
    /Checkpoint violates schema/,
  );
  assert.equal(writes, 0);
  assert.equal(generated, false);
  assert.equal(await readFile(checkpointFile, "utf8"), serialized);
  assert.equal(await git(root, "rev-parse", "HEAD"), headBefore);
});

test("rejects complete checkpoints whose review is not done", async () => {
  const { checkpoint } = await coordinatorFixture();
  const invalidComplete = completeIntegration(checkpoint);
  invalidComplete.review = { status: "pending" };

  assert.throws(() => assertCheckpoint(invalidComplete), /Checkpoint violates schema/);
});
