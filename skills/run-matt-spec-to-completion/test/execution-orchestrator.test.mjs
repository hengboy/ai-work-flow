import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { beginReview, completeIntegration, completeReview, completeTicket, createCheckpoint, markMerged, readCheckpoint, startTickets, writeCheckpoint } from "../lib/checkpoint.mjs";
import { createExecutionOrchestrator } from "../lib/execution-orchestrator.mjs";
import { materializeSpec, writeExecutionPlan } from "../lib/spec-intake.mjs";
import { assertCheckpoint, assertExecutionPlan } from "../lib/validation.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function orchestratorFixture() {
  const root = await mkdtemp(join(tmpdir(), "run-plan-orchestrator-"));
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
  const executionPlan = await materializeSpec({ mainWorktree: root, specPath, now: new Date("2026-07-23T12:00:00+08:00") });
  await writeExecutionPlan(root, executionPlan);
  await writeFile(join(root, "fixture-completion.txt"), "completed ticket\n");
  await git(root, "add", "fixture-completion.txt");
  await git(root, "commit", "-m", "complete ticket");
  const completionCommit = await git(root, "rev-parse", "HEAD");
  let checkpoint = createCheckpoint({ executionPlan, baseline: head, branch: "feat/migrate-runtime", worktree: root, now: new Date("2026-07-23T12:00:00+08:00") });
  checkpoint = startTickets(checkpoint, ["01"], head);
  checkpoint = completeTicket(checkpoint, "01", completionCommit);
  checkpoint = beginReview(checkpoint);
  checkpoint = completeReview(checkpoint, "approved");
  checkpoint = markMerged(checkpoint, { executionHead: completionCommit, mainWorktree: root, mergedCommit: completionCommit });
  return { root, executionPlan, checkpoint };
}

async function pendingIntegrationFixture() {
  const { root, executionPlan } = await orchestratorFixture();
  const head = await git(root, "rev-parse", "HEAD");
  let checkpoint = createCheckpoint({ executionPlan, baseline: head, branch: "feat/migrate-runtime", worktree: root });
  const executionWorktree = `${root}-execution`;
  await git(root, "worktree", "add", "-b", "feat/migrate-runtime", executionWorktree);
  await writeFile(join(executionWorktree, "execution.txt"), "feature change\n");
  await git(executionWorktree, "add", "execution.txt");
  await git(executionWorktree, "commit", "-m", "feature change");
  const completionCommit = await git(executionWorktree, "rev-parse", "HEAD");
  checkpoint = startTickets(checkpoint, ["01"], head);
  checkpoint = completeTicket(checkpoint, "01", completionCommit);
  checkpoint = beginReview(checkpoint);
  checkpoint = completeReview(checkpoint, "approved");
  checkpoint = { ...checkpoint, worktree: executionWorktree };
  await writeCheckpoint(root, "migrate-runtime", checkpoint);
  return { root, executionPlan, checkpoint, executionWorktree };
}

async function completedExecutionFixture() {
  const { root, executionPlan } = await orchestratorFixture();
  const baseline = await git(root, "rev-parse", "HEAD");
  const executionWorktree = `${root}-execution`;
  await git(root, "worktree", "add", "-b", "feat/migrate-runtime", executionWorktree);
  await writeFile(join(executionWorktree, "execution.txt"), "feature change\n");
  await git(executionWorktree, "add", "execution.txt");
  await git(executionWorktree, "commit", "-m", "feature change");
  const featureCommit = await git(executionWorktree, "rev-parse", "HEAD");
  let checkpoint = createCheckpoint({ executionPlan, baseline, branch: "feat/migrate-runtime", worktree: executionWorktree });
  checkpoint = startTickets(checkpoint, ["01"], baseline);
  checkpoint = completeTicket(checkpoint, "01", featureCommit);
  await writeCheckpoint(root, "migrate-runtime", checkpoint);
  return { root, executionPlan, checkpoint, executionWorktree, featureCommit };
}

test("requires canonical specPath before either initialization or resume", async () => {
  const orchestrator = createExecutionOrchestrator();
  await assert.rejects(
    orchestrator.run({ repository: "/not-used", branch: "feat/migrate-runtime" }),
    /canonical specPath is required to initialize or resume/,
  );
});

test("rejects the obsolete direct execution mode", async () => {
  const { executionPlan } = await orchestratorFixture();
  executionPlan.execution_mode = ["coord", "inator"].join("");

  assert.throws(() => assertExecutionPlan(executionPlan), /Execution Plan violates schema/);
});

test("resumes a pre-integration checkpoint whose completed ticket commit exists only on the feature branch", async () => {
  const { root, executionWorktree, featureCommit } = await completedExecutionFixture();

  await assert.rejects(git(root, "merge-base", "--is-ancestor", featureCommit, "main"));
  const resumed = await createExecutionOrchestrator().resume({
    repository: root,
    branch: "feat/migrate-runtime",
    specPath: ".scratch/migrate-runtime/spec.md",
    worktreePath: executionWorktree,
  });

  assert.equal(resumed.status, "resumed");
  assert.equal(resumed.checkpoint.tickets[0].end_commit, featureCommit);
});

test("recovers an all-done execution by synchronizing issues before persisting review", async () => {
  const { root, executionWorktree } = await completedExecutionFixture();
  const issuePath = join(root, ".scratch", "migrate-runtime", "issues", "01-contract.md");
  let reviewWriteFailed = false;
  const interrupted = createExecutionOrchestrator({
    checkpointWriter: async (worktree, featureSlug, checkpoint) => {
      if (checkpoint.status === "reviewing") {
        reviewWriteFailed = true;
        throw new Error("review persistence interrupted");
      }
      return writeCheckpoint(worktree, featureSlug, checkpoint);
    },
  });

  await assert.rejects(
    interrupted.run({ repository: root, branch: "feat/migrate-runtime", specPath: ".scratch/migrate-runtime/spec.md", worktreePath: executionWorktree }),
    /review persistence interrupted/,
  );
  assert.equal(reviewWriteFailed, true);
  assert.equal((await readCheckpoint(root, "migrate-runtime")).status, "executing");
  assert.match(await readFile(issuePath, "utf8"), /- \[x\] Verify runtime contract/);

  const recovered = await createExecutionOrchestrator().run({
    repository: root,
    branch: "feat/migrate-runtime",
    specPath: ".scratch/migrate-runtime/spec.md",
    worktreePath: executionWorktree,
  });

  assert.equal(recovered.status, "reviewing");
  assert.equal((await readCheckpoint(root, "migrate-runtime")).status, "reviewing");
  assert.match(await readFile(issuePath, "utf8"), /- \[x\] Verify runtime contract/);
});

test("does not dispatch a revision-consistent plan whose dependency level was tampered", async () => {
  const { root, executionWorktree } = await pendingIntegrationFixture();
  const specPath = join(root, ".scratch", "migrate-runtime", "spec.md");
  const issuePath = join(root, ".scratch", "migrate-runtime", "issues", "02-follow-up.md");
  await writeFile(issuePath, "# 02 — Follow up\n\n**Blocked by:** 01\n");
  const validPlan = await materializeSpec({ mainWorktree: root, specPath });
  const tamperedPlan = structuredClone(validPlan);
  tamperedPlan.tickets.find((ticket) => ticket.id === "02").level = 0;
  const { revision, ...facts } = tamperedPlan;
  tamperedPlan.revision = createHash("sha256").update(JSON.stringify(facts)).digest("hex");
  await writeFile(join(root, ".scratch", "migrate-runtime", "execution-plan.json"), `${JSON.stringify(tamperedPlan, null, 2)}\n`);
  const head = await git(root, "rev-parse", "HEAD");
  const checkpoint = createCheckpoint({ executionPlan: validPlan, baseline: head, branch: "feat/migrate-runtime", worktree: executionWorktree });
  checkpoint.spec.revision = tamperedPlan.revision;
  await writeCheckpoint(root, "migrate-runtime", checkpoint);
  let dispatched = false;

  await assert.rejects(
    createExecutionOrchestrator({
      directExecutor: async () => {
        dispatched = true;
        return { ticket_id: "01", status: "done", commits: [head], tests: [], summary: "unexpected" };
      },
    }).executeFrontier({ worktree: executionWorktree, mainWorktree: root, featureSlug: "migrate-runtime", executionPlan: validPlan, checkpoint }),
    /Ticket 02 level must follow blocker 01/,
  );
  assert.equal(dispatched, false);
});

test("rejects a revision-consistent persisted plan with duplicate ticket IDs before recovery writes", async () => {
  const { root, executionPlan, checkpoint, executionWorktree } = await pendingIntegrationFixture();
  const duplicatePlan = structuredClone(executionPlan);
  duplicatePlan.tickets.push(structuredClone(duplicatePlan.tickets[0]));
  duplicatePlan.execution_mode = "delegated";
  const { revision, ...facts } = duplicatePlan;
  duplicatePlan.revision = createHash("sha256").update(JSON.stringify(facts)).digest("hex");
  await writeFile(join(root, ".scratch", "migrate-runtime", "execution-plan.json"), `${JSON.stringify(duplicatePlan, null, 2)}\n`);
  checkpoint.spec.revision = duplicatePlan.revision;
  await writeCheckpoint(root, "migrate-runtime", checkpoint);
  const checkpointPath = join(root, ".scratch", "migrate-runtime", "checkpoint.json");
  const checkpointBefore = await readFile(checkpointPath, "utf8");
  const headBefore = await git(root, "rev-parse", "HEAD");
  let writes = 0;
  const orchestrator = createExecutionOrchestrator({
    checkpointWriter: async (...args) => {
      writes += 1;
      return writeCheckpoint(...args);
    },
  });

  await assert.rejects(
    orchestrator.resume({ repository: root, branch: "feat/migrate-runtime", specPath: ".scratch/migrate-runtime/spec.md", worktreePath: executionWorktree }),
    /Duplicate execution plan ticket ID: 01/,
  );
  assert.equal(writes, 0);
  assert.equal(await readFile(checkpointPath, "utf8"), checkpointBefore);
  assert.equal(await git(root, "rev-parse", "HEAD"), headBefore);
});

test("rejects a completion result that returns the ticket start commit without marking it done", async () => {
  const { root, executionPlan, executionWorktree } = await pendingIntegrationFixture();
  const startCommit = await git(executionWorktree, "rev-parse", "HEAD");
  const baseline = await git(root, "rev-parse", "HEAD");
  const checkpoint = createCheckpoint({ executionPlan, baseline, branch: "feat/migrate-runtime", worktree: executionWorktree });
  await writeCheckpoint(root, "migrate-runtime", checkpoint);
  let writes = 0;
  const orchestrator = createExecutionOrchestrator({
    directExecutor: async () => ({ ticket_id: "01", status: "done", commits: [startCommit], tests: [], summary: "stale commit" }),
    checkpointWriter: async (...args) => {
      writes += 1;
      return writeCheckpoint(...args);
    },
  });

  await assert.rejects(
    orchestrator.executeFrontier({ worktree: executionWorktree, mainWorktree: root, featureSlug: "migrate-runtime", executionPlan, checkpoint }),
    /Completion result commit must be after ticket 01 start commit/,
  );
  assert.equal(writes, 1);
  assert.equal((await readCheckpoint(root, "migrate-runtime")).tickets[0].status, "in_progress");
});

test("rejects a completed ticket whose persisted end commit is its start commit before recovery writes", async () => {
  const { root, checkpoint, executionWorktree } = await completedExecutionFixture();
  checkpoint.tickets[0].end_commit = checkpoint.tickets[0].start_commit;
  await writeCheckpoint(root, "migrate-runtime", checkpoint);
  const checkpointPath = join(root, ".scratch", "migrate-runtime", "checkpoint.json");
  const checkpointBefore = await readFile(checkpointPath, "utf8");
  let writes = 0;
  const orchestrator = createExecutionOrchestrator({
    checkpointWriter: async (...args) => {
      writes += 1;
      return writeCheckpoint(...args);
    },
  });

  await assert.rejects(
    orchestrator.resume({ repository: root, branch: "feat/migrate-runtime", specPath: ".scratch/migrate-runtime/spec.md", worktreePath: executionWorktree }),
    /ticket-commit-not-after-start/,
  );
  assert.equal(writes, 0);
  assert.equal(await readFile(checkpointPath, "utf8"), checkpointBefore);
});

test("keeps merged cleanup recoverable when final record commit fails", async () => {
  const { root, executionPlan, checkpoint } = await orchestratorFixture();
  const unrelatedPath = join(root, "unrelated.txt");
  await writeFile(unrelatedPath, "preserve this change\n");
  await git(root, "stash", "push", "--include-untracked", "--message", "fixture-unrelated-change", "--", "unrelated.txt");
  const stashRef = await git(root, "rev-parse", "refs/stash");
  const checkpointWithStash = {
    ...checkpoint,
    integration: { ...checkpoint.integration, stash_ref: stashRef },
  };
  await writeCheckpoint(root, "migrate-runtime", checkpointWithStash);
  const failingOrchestrator = createExecutionOrchestrator({
    generateCommitMessage: async () => {
      throw new Error("commit generator unavailable");
    },
  });

  await assert.rejects(
    failingOrchestrator.completeMergedCleanup({ repository: root, mainWorktree: root, featureSlug: "migrate-runtime", executionPlan, checkpoint: checkpointWithStash }),
    /commit generator unavailable/,
  );
  const recoverable = await readCheckpoint(root, "migrate-runtime");
  assert.equal(recoverable.status, "integrating");
  assert.equal(recoverable.integration.status, "merged");
  assert.equal(recoverable.integration.stash_restored, true);
  assert.equal(recoverable.integration.stash_ref, stashRef);
  assert.equal(await readFile(unrelatedPath, "utf8"), "preserve this change\n");

  const orchestrator = createExecutionOrchestrator({ generateCommitMessage: async () => "chore: record execution" });
  const result = await orchestrator.completeMergedCleanup({
    repository: root,
    mainWorktree: root,
    featureSlug: "migrate-runtime",
    executionPlan,
    checkpoint: recoverable,
  });

  assert.equal(result.status, "complete");
  assert.equal((await readCheckpoint(root, "migrate-runtime")).status, "complete");
  assert.equal(await git(root, "log", "-1", "--format=%s"), "chore: record execution");

  const resumed = await orchestrator.resume({
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
  await git(root, "merge", "--no-edit", "feat/migrate-runtime");
  const head = await git(root, "rev-parse", "HEAD");
  const checkpointWithStash = markMerged(checkpoint, { executionHead: head, mainWorktree: root, mergedCommit: head, stashRef: unavailableStash });
  await writeCheckpoint(root, "migrate-runtime", checkpointWithStash);

  const orchestrator = createExecutionOrchestrator({ generateCommitMessage: async () => "chore: record execution" });
  await assert.rejects(
    orchestrator.completeMergedCleanup({ repository: root, mainWorktree: root, featureSlug: "migrate-runtime", executionPlan, checkpoint: checkpointWithStash }),
    new RegExp(`Checkpoint requires stash ${unavailableStash}, but that stash is unavailable`),
  );
  assert.equal((await readCheckpoint(root, "migrate-runtime")).integration.stash_ref, unavailableStash);
  assert.match(await git(root, "worktree", "list", "--porcelain"), new RegExp(executionWorktree));
});

test("does not commit terminal records when their checkpoint fails integrity", async () => {
  const { root, executionPlan, checkpoint } = await orchestratorFixture();
  const invalidComplete = completeIntegration({
    ...checkpoint,
    integration: { ...checkpoint.integration, execution_head: "b".repeat(40) },
  });
  await writeCheckpoint(root, "migrate-runtime", invalidComplete);
  const headBefore = await git(root, "rev-parse", "HEAD");
  let generated = false;
  const orchestrator = createExecutionOrchestrator({
    generateCommitMessage: async () => {
      generated = true;
      return "chore: record execution";
    },
  });

  await assert.rejects(
    orchestrator.completeMergedCleanup({ repository: root, mainWorktree: root, featureSlug: "migrate-runtime", executionPlan, checkpoint: invalidComplete }),
    /Checkpoint integrity failed/,
  );
  assert.equal(generated, false);
  assert.equal(await git(root, "rev-parse", "HEAD"), headBefore);
});

test("recovers a stash application after its restored checkpoint write fails", async () => {
  const { root, executionPlan, checkpoint } = await orchestratorFixture();
  const unrelatedPath = join(root, "unrelated.txt");
  await writeFile(unrelatedPath, "preserve this change\n");
  await git(root, "stash", "push", "--include-untracked", "--message", "fixture-unrelated-change", "--", "unrelated.txt");
  const stashRef = await git(root, "rev-parse", "refs/stash");
  const checkpointWithStash = { ...checkpoint, integration: { ...checkpoint.integration, stash_ref: stashRef } };
  await writeCheckpoint(root, "migrate-runtime", checkpointWithStash);
  let failed = false;
  const failingOrchestrator = createExecutionOrchestrator({
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
    failingOrchestrator.completeMergedCleanup({ repository: root, mainWorktree: root, featureSlug: "migrate-runtime", executionPlan, checkpoint: checkpointWithStash }),
    /checkpoint storage unavailable/,
  );
  const interrupted = await readCheckpoint(root, "migrate-runtime");
  assert.equal(interrupted.integration.stash_restore_state, "applying");
  assert.equal(await readFile(unrelatedPath, "utf8"), "preserve this change\n");
  assert.equal(await git(root, "rev-parse", "refs/stash"), stashRef);

  const orchestrator = createExecutionOrchestrator({ generateCommitMessage: async () => "chore: record execution" });
  const resumed = await orchestrator.resume({
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
  const { root, executionPlan, checkpoint } = await orchestratorFixture();
  await writeFile(join(root, "unrelated.txt"), "preserve this change\n");
  await git(root, "stash", "push", "--include-untracked", "--message", "fixture-unrelated-change", "--", "unrelated.txt");
  const stashRef = await git(root, "rev-parse", "refs/stash");
  const checkpointWithStash = { ...checkpoint, integration: { ...checkpoint.integration, stash_ref: stashRef } };
  await writeCheckpoint(root, "migrate-runtime", checkpointWithStash);
  const failingOrchestrator = createExecutionOrchestrator({
    checkpointWriter: async (worktree, featureSlug, next) => {
      if (next.integration.stash_cleanup_state === "dropped") throw new Error("checkpoint storage unavailable");
      return writeCheckpoint(worktree, featureSlug, next);
    },
    generateCommitMessage: async () => "chore: record execution",
  });

  await assert.rejects(
    failingOrchestrator.completeMergedCleanup({ repository: root, mainWorktree: root, featureSlug: "migrate-runtime", executionPlan, checkpoint: checkpointWithStash }),
    /checkpoint storage unavailable/,
  );
  const interrupted = await readCheckpoint(root, "migrate-runtime");
  assert.equal(interrupted.integration.stash_restore_state, "restored");
  assert.equal(interrupted.integration.stash_cleanup_state, "pending");
  assert.equal(await git(root, "stash", "list", "--format=%H"), "");

  const result = await createExecutionOrchestrator({ generateCommitMessage: async () => "chore: record execution" }).completeMergedCleanup({
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
  const failingOrchestrator = createExecutionOrchestrator({
    checkpointWriter: async (worktree, featureSlug, next) => {
      if (next.integration.stash_ref) throw new Error("checkpoint storage unavailable");
      return writeCheckpoint(worktree, featureSlug, next);
    },
    generateCommitMessage: async () => "chore: record execution",
  });

  await assert.rejects(
    failingOrchestrator.integrate({ repository: root, worktree: executionWorktree, featureSlug: "migrate-runtime", executionPlan, checkpoint }),
    /checkpoint storage unavailable/,
  );
  const recoverable = await readCheckpoint(root, "migrate-runtime");
  assert.ok(recoverable.integration.stash_operation_id);
  assert.equal(recoverable.integration.stash_ref, undefined);
  assert.notEqual(await git(root, "stash", "list", "--format=%H"), "");
  assert.equal(await git(root, "rev-parse", "HEAD"), headBefore);

  const orchestrator = createExecutionOrchestrator({ generateCommitMessage: async () => "chore: record execution" });
  const resumed = await orchestrator.resume({ repository: root, branch: "feat/migrate-runtime", specPath: ".scratch/migrate-runtime/spec.md", worktreePath: executionWorktree });
  assert.equal(resumed.status, "resumed");
  const completed = await orchestrator.integrate({ repository: root, worktree: resumed.worktree, featureSlug: "migrate-runtime", executionPlan, checkpoint: resumed.checkpoint });
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
    createExecutionOrchestrator().integrate({ repository: root, worktree: executionWorktree, featureSlug: "migrate-runtime", executionPlan, checkpoint: invalid }),
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
  await writeFile(join(root, ".scratch", "migrate-runtime", "issues", "02-follow-up.md"), "# Follow up\n");
  const specPath = join(root, ".scratch", "migrate-runtime", "spec.md");
  const twoTaskPlan = await materializeSpec({ mainWorktree: root, specPath });
  await writeExecutionPlan(root, twoTaskPlan);
  const head = await git(root, "rev-parse", "HEAD");
  const checkpoint = createCheckpoint({ executionPlan: twoTaskPlan, baseline: head, branch: "feat/migrate-runtime", worktree: executionWorktree });
  await writeCheckpoint(root, "migrate-runtime", checkpoint);
  const dispatched = [];
  const orchestrator = createExecutionOrchestrator({
    adapter: {
      async executeTicket({ ticket }) {
        dispatched.push(ticket.id);
        return { ticket_id: "01", status: "blocked", commits: [], tests: [], summary: "blocked", error: "stop" };
      },
    },
  });

  const result = await orchestrator.executeFrontier({ worktree: executionWorktree, mainWorktree: root, featureSlug: "migrate-runtime", executionPlan: twoTaskPlan, checkpoint });
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
  const orchestrator = createExecutionOrchestrator({ adapter: { async executeFrontier() { dispatched = true; return []; } } });

  const result = await orchestrator.executeFrontier({ worktree: executionWorktree, mainWorktree: root, featureSlug: "migrate-runtime", executionPlan, checkpoint });
  assert.equal(result.status, "blocked");
  assert.equal(dispatched, false);
  assert.equal((await readCheckpoint(root, "migrate-runtime")).tickets[0].status, "in_progress");
});

test("rejects multi-in-progress and out-of-order completed checkpoints before recovery writes", async () => {
  const { root, executionWorktree } = await pendingIntegrationFixture();
  const specPath = join(root, ".scratch", "migrate-runtime", "spec.md");
  await writeFile(join(root, ".scratch", "migrate-runtime", "issues", "02-follow-up.md"), "# 02 — Follow up\n\n**Blocked by:** None — can start immediately\n");
  const executionPlan = await materializeSpec({ mainWorktree: root, specPath });
  await writeExecutionPlan(root, executionPlan);
  const head = await git(root, "rev-parse", "HEAD");
  const checkpointFile = join(root, ".scratch", "migrate-runtime", "checkpoint.json");

  const multiInProgress = createCheckpoint({ executionPlan, baseline: head, branch: "feat/migrate-runtime", worktree: executionWorktree });
  multiInProgress.tickets = executionPlan.tickets.map((ticket) => ({
    id: ticket.id,
    status: "in_progress",
    start_commit: head,
    started_at: "2026-07-23T12:00:00+08:00",
  }));
  await writeCheckpoint(root, "migrate-runtime", multiInProgress);
  const multiBefore = await readFile(checkpointFile, "utf8");
  let writes = 0;
  const orchestrator = createExecutionOrchestrator({ checkpointWriter: async (...args) => { writes += 1; return writeCheckpoint(...args); } });

  await assert.rejects(
    orchestrator.resume({ repository: root, branch: "feat/migrate-runtime", specPath: ".scratch/migrate-runtime/spec.md", worktreePath: executionWorktree }),
    /multiple-in-progress/,
  );
  assert.equal(writes, 0);
  assert.equal(await readFile(checkpointFile, "utf8"), multiBefore);

  const outOfOrder = createCheckpoint({ executionPlan, baseline: head, branch: "feat/migrate-runtime", worktree: executionWorktree });
  outOfOrder.tickets[1] = {
    id: executionPlan.tickets[1].id,
    status: "done",
    start_commit: head,
    started_at: "2026-07-23T12:00:00+08:00",
    end_commit: head,
    completed_at: "2026-07-23T12:00:00+08:00",
  };
  await writeCheckpoint(root, "migrate-runtime", outOfOrder);
  const orderBefore = await readFile(checkpointFile, "utf8");

  await assert.rejects(
    orchestrator.resume({ repository: root, branch: "feat/migrate-runtime", specPath: ".scratch/migrate-runtime/spec.md", worktreePath: executionWorktree }),
    /ticket-order/,
  );
  assert.equal(writes, 0);
  assert.equal(await readFile(checkpointFile, "utf8"), orderBefore);
});

test("rejects a caller plan that differs from the verified persisted plan before delegation", async () => {
  const { root, executionPlan, executionWorktree } = await pendingIntegrationFixture();
  const head = await git(root, "rev-parse", "HEAD");
  const checkpoint = createCheckpoint({ executionPlan, baseline: head, branch: "feat/migrate-runtime", worktree: executionWorktree });
  await writeCheckpoint(root, "migrate-runtime", checkpoint);
  const checkpointFile = join(root, ".scratch", "migrate-runtime", "checkpoint.json");
  const issueFile = join(root, ".scratch", "migrate-runtime", "issues", "01-contract.md");
  const checkpointBefore = await readFile(checkpointFile, "utf8");
  const issueBefore = await readFile(issueFile, "utf8");
  let delegated = false;
  let writes = 0;
  const orchestrator = createExecutionOrchestrator({
    directExecutor: async () => {
      delegated = true;
      return { ticket_id: "01", status: "done", commits: [head], tests: [], summary: "done" };
    },
    checkpointWriter: async (...args) => { writes += 1; return writeCheckpoint(...args); },
  });

  await assert.rejects(
    orchestrator.executeFrontier({
      worktree: executionWorktree,
      mainWorktree: root,
      featureSlug: "migrate-runtime",
      executionPlan: { ...executionPlan, revision: "b".repeat(64) },
      checkpoint,
    }),
    /does not match the verified persisted execution plan/,
  );
  assert.equal(delegated, false);
  assert.equal(writes, 0);
  assert.equal(await readFile(checkpointFile, "utf8"), checkpointBefore);
  assert.equal(await readFile(issueFile, "utf8"), issueBefore);
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
  const failingOrchestrator = createExecutionOrchestrator({
    checkpointWriter: async (worktree, featureSlug, next) => {
      if (!failed && next.integration.stash_restore_state === "restored") {
        failed = true;
        throw new Error("checkpoint storage unavailable");
      }
      return writeCheckpoint(worktree, featureSlug, next);
    },
  });

  await assert.rejects(
    failingOrchestrator.integrate({ repository: root, worktree: executionWorktree, featureSlug: "migrate-runtime", executionPlan, checkpoint }),
    /checkpoint storage unavailable/,
  );
  const interrupted = await readCheckpoint(root, "migrate-runtime");
  assert.equal(interrupted.integration.stash_restore_state, "applying");
  assert.equal(await readFile(join(root, "unrelated.txt"), "utf8"), "preserve this change\n");

  const orchestrator = createExecutionOrchestrator();
  const resumed = await orchestrator.resume({ repository: root, branch: "feat/migrate-runtime", specPath: ".scratch/migrate-runtime/spec.md", worktreePath: executionWorktree });
  await assert.rejects(
    orchestrator.integrate({ repository: root, worktree: resumed.worktree, featureSlug: "migrate-runtime", executionPlan, checkpoint: resumed.checkpoint }),
    /git merge --no-edit feat\/migrate-runtime failed/,
  );
  const recovered = await readCheckpoint(root, "migrate-runtime");
  assert.equal(recovered.integration.stash_ref, undefined);
  assert.equal(recovered.integration.stash_restore_state, undefined);
  assert.equal(await readFile(join(root, "unrelated.txt"), "utf8"), "preserve this change\n");
  assert.equal(await git(root, "stash", "list", "--format=%H"), "");
});

test("does not mutate an invalid checkpoint while attempting a relocated resume", async () => {
  const { root, executionPlan } = await orchestratorFixture();
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
  const orchestrator = createExecutionOrchestrator({
    checkpointWriter: async (...args) => {
      writes += 1;
      return writeCheckpoint(...args);
    },
  });

  await assert.rejects(
    orchestrator.resume({ repository: root, branch: "feat/migrate-runtime", specPath: ".scratch/migrate-runtime/spec.md", worktreePath: join(root, "recreated-worktree") }),
    /Checkpoint integrity failed/,
  );
  assert.equal(writes, 0);
  assert.equal(await readFile(checkpointFile, "utf8"), before);
  assert.equal(await git(root, "rev-parse", "HEAD"), headBefore);
});

test("does not create a recovery worktree when the current checkpoint is unavailable", async () => {
  const { root } = await orchestratorFixture();
  const branch = "feat/migrate-runtime";
  const worktreePath = join(root, "recovery-worktree");
  await git(root, "branch", branch);
  const worktreesBefore = await git(root, "worktree", "list", "--porcelain");

  await assert.rejects(
    createExecutionOrchestrator().resume({ repository: root, branch, specPath: ".scratch/migrate-runtime/spec.md", worktreePath }),
    /Checkpoint integrity failed/,
  );

  assert.equal(await git(root, "worktree", "list", "--porcelain"), worktreesBefore);
  assert.equal(await git(root, "branch", "--show-current"), "main");
});

test("rejects complete checkpoints with pending work before terminal handling", async () => {
  const { root, checkpoint } = await orchestratorFixture();
  const invalidComplete = completeIntegration(checkpoint);
  invalidComplete.tickets[0] = { id: "01", status: "pending" };
  const checkpointFile = join(root, ".scratch", "migrate-runtime", "checkpoint.json");
  const serialized = `${JSON.stringify(invalidComplete, null, 2)}\n`;
  await writeFile(checkpointFile, serialized);
  const headBefore = await git(root, "rev-parse", "HEAD");
  let writes = 0;
  let generated = false;
  const orchestrator = createExecutionOrchestrator({
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
    orchestrator.resume({ repository: root, branch: "feat/migrate-runtime", specPath: ".scratch/migrate-runtime/spec.md", worktreePath: join(root, "unused-worktree") }),
    /Checkpoint integrity failed/,
  );
  assert.equal(writes, 0);
  assert.equal(generated, false);
  assert.equal(await readFile(checkpointFile, "utf8"), serialized);
  assert.equal(await git(root, "rev-parse", "HEAD"), headBefore);
});

test("rejects complete checkpoints whose review is not done", async () => {
  const { checkpoint } = await orchestratorFixture();
  const invalidComplete = completeIntegration(checkpoint);
  invalidComplete.review = { status: "pending" };

  assert.throws(() => assertCheckpoint(invalidComplete), /Checkpoint violates schema/);
});
