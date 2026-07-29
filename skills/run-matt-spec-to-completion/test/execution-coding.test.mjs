import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { beginReview, completeIntegration, completeReview, completeReviewFix, completeTicket, createCheckpoint, decideReview, markMerged, readCheckpoint, recordReview, startTickets, writeCheckpoint } from "../lib/checkpoint.mjs";
import { createExecutionCoding } from "../lib/execution-coding.mjs";
import { materializeSpec, verifyExecutionPlan, writeExecutionPlan } from "../lib/spec-intake.mjs";
import { assertCheckpoint, assertExecutionPlan } from "../lib/validation.mjs";
import { createReviewManifest, reviewManifestDigest } from "../lib/review-manifest.mjs";

const execFileAsync = promisify(execFile);

function reviewManifest(fixedPoint, reviewCommit, paths = []) {
  const diffCommand = ["git", "diff", "--no-ext-diff", `${fixedPoint}...${reviewCommit}`];
  return createReviewManifest({ fixed_point: fixedPoint, review_commit: reviewCommit, commit_list: [{ sha: reviewCommit, subject: "review" }], changed_paths: paths.map((path) => ({ record_type: "1", index_status: "M", worktree_status: ".", path })), checks: [], diff_command: diffCommand, spec_status: "absent", spec_source: null, standards_source: [{ path: "CONTEXT.md", revision: reviewCommit }], shards: paths.map((path, index) => ({ id: `shard-${index + 1}`, paths: [path], diff_command: [...diffCommand, "--", path] })) });
}

function reviewResult(checkpoint, { blocking = false } = {}) {
  const coverage = { manifest_digest: checkpoint.review.manifest.manifest_digest, completed_shard_ids: checkpoint.review.manifest.shards.map((shard) => shard.id), incomplete_shard_ids: [] };
  const finding = { id: "standards-001", summary: "fixture blocker", evidence: "fixture evidence" };
  return {
    manifest_digest: checkpoint.review.manifest.manifest_digest,
    coverage,
    standards: { verdict: blocking ? "blocked" : "approved", blocking_findings: blocking ? [finding] : [], advisory_findings: [] },
    spec: { verdict: "approved", blocking_findings: [], advisory_findings: [] },
  };
}

function completeReviewWithManifest(checkpoint, findingsSummary) {
  const result = reviewResult(checkpoint);
  return recordReview(checkpoint, { manifestDigest: result.manifest_digest, coverage: result.coverage, findingsSummary, result });
}

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function codingFixture() {
  const root = await mkdtemp(join(tmpdir(), "run-plan-coding-"));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test User");
  const directory = join(root, ".scratch", "migrate-runtime");
  await mkdir(join(directory, "issues"), { recursive: true });
  const specPath = join(directory, "spec.md");
  await writeFile(specPath, "# Migrate runtime\n");
  await writeFile(join(root, "CONTEXT.md"), "# Review standards\n");
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
  checkpoint = beginReview(checkpoint, { fixedPoint: checkpoint.baseline, reviewCommit: completionCommit, manifest: reviewManifest(checkpoint.baseline, completionCommit, ["fixture-completion.txt"]) });
  checkpoint = completeReviewWithManifest(checkpoint, "approved");
  checkpoint = markMerged(checkpoint, { executionHead: completionCommit, mainWorktree: root, mergedCommit: completionCommit });
  return { root, executionPlan, checkpoint };
}

async function pendingIntegrationFixture() {
  const { root, executionPlan } = await codingFixture();
  const head = await git(root, "rev-parse", "HEAD");
  let checkpoint = createCheckpoint({ executionPlan, baseline: head, branch: "feat/migrate-runtime", worktree: root });
  const executionWorktree = join(root, ".worktrees", "execution");
  await git(root, "worktree", "add", "-b", "feat/migrate-runtime", executionWorktree);
  await writeFile(join(executionWorktree, "execution.txt"), "feature change\n");
  await git(executionWorktree, "add", "execution.txt");
  await git(executionWorktree, "commit", "-m", "feature change");
  const completionCommit = await git(executionWorktree, "rev-parse", "HEAD");
  checkpoint = startTickets(checkpoint, ["01"], head);
  checkpoint = completeTicket(checkpoint, "01", completionCommit);
  checkpoint = beginReview(checkpoint, { fixedPoint: checkpoint.baseline, reviewCommit: completionCommit, manifest: reviewManifest(checkpoint.baseline, completionCommit, ["execution.txt"]) });
  checkpoint = completeReviewWithManifest(checkpoint, "approved");
  checkpoint = { ...checkpoint, worktree: relative(root, executionWorktree) };
  await writeCheckpoint(root, "migrate-runtime", checkpoint);
  return { root, executionPlan, checkpoint, executionWorktree };
}

async function completedExecutionFixture() {
  const { root, executionPlan } = await codingFixture();
  const baseline = await git(root, "rev-parse", "HEAD");
  const executionWorktree = join(root, ".worktrees", "execution");
  await git(root, "worktree", "add", "-b", "feat/migrate-runtime", executionWorktree);
  await writeFile(join(executionWorktree, "execution.txt"), "feature change\n");
  await git(executionWorktree, "add", "execution.txt");
  await git(executionWorktree, "commit", "-m", "feature change");
  const featureCommit = await git(executionWorktree, "rev-parse", "HEAD");
  let checkpoint = createCheckpoint({ executionPlan, baseline, branch: "feat/migrate-runtime", repository: root, worktree: executionWorktree });
  checkpoint = startTickets(checkpoint, ["01"], baseline);
  checkpoint = completeTicket(checkpoint, "01", featureCommit);
  await writeCheckpoint(root, "migrate-runtime", checkpoint);
  return { root, executionPlan, checkpoint, executionWorktree, featureCommit };
}

test("requires canonical specPath before either initialization or resume", async () => {
  const coding = createExecutionCoding();
  await assert.rejects(
    coding.run({ repository: "/not-used", branch: "feat/migrate-runtime" }),
    /canonical specPath is required to initialize or resume/,
  );
});

test("rejects the obsolete direct execution mode", async () => {
  const { executionPlan } = await codingFixture();
  executionPlan.execution_mode = "orchestrator";

  assert.throws(() => assertExecutionPlan(executionPlan), /Execution Plan violates schema/);
});

test("allows coding mode for one ticket and rejects it for multiple tickets", async () => {
  const { executionPlan } = await codingFixture();
  const codingPlan = structuredClone(executionPlan);
  codingPlan.execution_mode = "coding";
  {
    const { revision, ...facts } = codingPlan;
    codingPlan.revision = createHash("sha256").update(JSON.stringify(facts)).digest("hex");
  }
  assert.doesNotThrow(() => verifyExecutionPlan(codingPlan));

  const multipleTickets = structuredClone(codingPlan);
  multipleTickets.tickets.push({
    id: "02",
    ref: ".scratch/migrate-runtime/issues/02-follow-up.md",
    title: "Follow up",
    level: 0,
    blocked_by: [],
  });
  {
    const { revision, ...facts } = multipleTickets;
    multipleTickets.revision = createHash("sha256").update(JSON.stringify(facts)).digest("hex");
  }
  assert.throws(() => verifyExecutionPlan(multipleTickets), /Coding execution is only available for a single-ticket spec/);
});

test("resumes a pre-integration checkpoint whose completed ticket commit exists only on the feature branch", async () => {
  const { root, executionWorktree, featureCommit } = await completedExecutionFixture();

  await assert.rejects(git(root, "merge-base", "--is-ancestor", featureCommit, "main"));
  const resumed = await createExecutionCoding().resume({
    repository: root,
    branch: "feat/migrate-runtime",
    specPath: ".scratch/migrate-runtime/spec.md",
    worktreePath: executionWorktree,
  });

  assert.equal(resumed.status, "resumed");
  assert.equal(resumed.checkpoint.tickets[0].end_commit, featureCommit);
});

test("records review through the canonical runtime after all tickets complete", async () => {
  const { root, executionWorktree } = await completedExecutionFixture();
  const issuePath = join(root, ".scratch", "migrate-runtime", "issues", "01-contract.md");
  const recovered = await createExecutionCoding().run({
    repository: root,
    branch: "feat/migrate-runtime",
    specPath: ".scratch/migrate-runtime/spec.md",
    worktreePath: executionWorktree,
  });

  assert.equal(recovered.status, "reviewing");
  assert.equal((await readCheckpoint(root, "migrate-runtime")).status, "reviewing");
  assert.match(await readFile(issuePath, "utf8"), /- \[x\] Verify runtime contract/);
});

test("freezes a non-empty standards source at the committed review revision", async () => {
  const { root, executionPlan, executionWorktree } = await completedExecutionFixture();
  const checkpoint = await createExecutionCoding().startReview({
    mainWorktree: root,
    featureSlug: "migrate-runtime",
    worktree: executionWorktree,
    executionPlan,
  });

  assert.deepEqual(checkpoint.review.manifest.standards_source, [{
    path: "CONTEXT.md",
    revision: checkpoint.review.review_commit,
  }]);
});

test("blocks review before state advancement when the frozen standards source is absent", async () => {
  const { root, executionPlan, executionWorktree } = await completedExecutionFixture();
  await git(executionWorktree, "rm", "CONTEXT.md");
  await git(executionWorktree, "commit", "-m", "remove review standards");

  await assert.rejects(
    createExecutionCoding().startReview({ mainWorktree: root, featureSlug: "migrate-runtime", worktree: executionWorktree, executionPlan }),
    /Review standards source is unavailable at frozen commit/,
  );
  assert.equal((await readCheckpoint(root, "migrate-runtime")).status, "executing");
});

test("recovery rejects a rehashed standards source that differs from the frozen review revision", async () => {
  const { root, executionPlan, executionWorktree } = await completedExecutionFixture();
  const checkpoint = await createExecutionCoding().startReview({
    mainWorktree: root,
    featureSlug: "migrate-runtime",
    worktree: executionWorktree,
    executionPlan,
  });
  const tampered = structuredClone(checkpoint);
  tampered.review.manifest.standards_source[0].revision = tampered.baseline;
  tampered.review.manifest.manifest_digest = reviewManifestDigest(tampered.review.manifest);
  await writeCheckpoint(root, "migrate-runtime", tampered);

  await assert.rejects(
    createExecutionCoding().resume({ repository: root, branch: "feat/migrate-runtime", specPath: ".scratch/migrate-runtime/spec.md", worktreePath: executionWorktree }),
    /standards source.*frozen review context|review-manifest/,
  );
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
  const checkpoint = createCheckpoint({ executionPlan: validPlan, baseline: head, branch: "feat/migrate-runtime", repository: root, worktree: executionWorktree });
  checkpoint.spec.revision = tamperedPlan.revision;
  await writeCheckpoint(root, "migrate-runtime", checkpoint);
  let dispatched = false;

  await assert.rejects(
    createExecutionCoding({
      directExecutor: async () => {
        dispatched = true;
        return { ticket_id: "01", status: "done", commits: [head], checks: [], changed_paths: [], summary: "unexpected" };
      },
    }).executeFrontier({ repository: root, worktree: executionWorktree, mainWorktree: root, featureSlug: "migrate-runtime", executionPlan: validPlan, checkpoint }),
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
  const coding = createExecutionCoding({
    checkpointWriter: async (...args) => {
      writes += 1;
      return writeCheckpoint(...args);
    },
  });

  await assert.rejects(
    coding.resume({ repository: root, branch: "feat/migrate-runtime", specPath: ".scratch/migrate-runtime/spec.md", worktreePath: executionWorktree }),
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
  const checkpoint = createCheckpoint({ executionPlan, baseline, branch: "feat/migrate-runtime", repository: root, worktree: executionWorktree });
  await writeCheckpoint(root, "migrate-runtime", checkpoint);
  let writes = 0;
  const coding = createExecutionCoding({
    directExecutor: async () => ({ ticket_id: "01", status: "done", commits: [startCommit], checks: [], changed_paths: [], summary: "stale commit" }),
    checkpointWriter: async (...args) => {
      writes += 1;
      return writeCheckpoint(...args);
    },
  });

  await assert.rejects(
    coding.executeFrontier({ repository: root, worktree: executionWorktree, mainWorktree: root, featureSlug: "migrate-runtime", executionPlan, checkpoint }),
    /Completion result commit must be after ticket 01 start commit/,
  );
  assert.equal(writes, 0);
  assert.equal((await readCheckpoint(root, "migrate-runtime")).tickets[0].status, "in_progress");
});

test("rejects a completed ticket whose persisted end commit is its start commit before recovery writes", async () => {
  const { root, checkpoint, executionWorktree } = await completedExecutionFixture();
  checkpoint.tickets[0].end_commit = checkpoint.tickets[0].start_commit;
  await writeCheckpoint(root, "migrate-runtime", checkpoint);
  const checkpointPath = join(root, ".scratch", "migrate-runtime", "checkpoint.json");
  const checkpointBefore = await readFile(checkpointPath, "utf8");
  let writes = 0;
  const coding = createExecutionCoding({
    checkpointWriter: async (...args) => {
      writes += 1;
      return writeCheckpoint(...args);
    },
  });

  await assert.rejects(
    coding.resume({ repository: root, branch: "feat/migrate-runtime", specPath: ".scratch/migrate-runtime/spec.md", worktreePath: executionWorktree }),
    /ticket-commit-not-after-start/,
  );
  assert.equal(writes, 0);
  assert.equal(await readFile(checkpointPath, "utf8"), checkpointBefore);
});

test("commits merged execution records with the fixed runtime message", async () => {
  const { root, executionPlan, checkpoint } = await codingFixture();
  const unrelatedPath = join(root, "unrelated.txt");
  await writeFile(unrelatedPath, "preserve this change\n");
  await git(root, "stash", "push", "--include-untracked", "--message", "fixture-unrelated-change", "--", "unrelated.txt");
  const stashRef = await git(root, "rev-parse", "refs/stash");
  const checkpointWithStash = {
    ...checkpoint,
    integration: { ...checkpoint.integration, stash_ref: stashRef },
  };
  await writeCheckpoint(root, "migrate-runtime", checkpointWithStash);
  const result = await createExecutionCoding().completeMergedCleanup({
    repository: root,
    mainWorktree: root,
    featureSlug: "migrate-runtime",
    executionPlan,
    checkpoint: checkpointWithStash,
  });

  assert.equal(result.status, "complete");
  assert.equal((await readCheckpoint(root, "migrate-runtime")).status, "complete");
  assert.equal(await readFile(unrelatedPath, "utf8"), "preserve this change\n");
  assert.equal(await git(root, "log", "-1", "--format=%s"), "chore(ai-work-flow): record migrate-runtime execution");

  const resumed = await createExecutionCoding().resume({
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

  await assert.rejects(
    createExecutionCoding().completeMergedCleanup({ repository: root, mainWorktree: root, featureSlug: "migrate-runtime", executionPlan, checkpoint: checkpointWithStash }),
    new RegExp(`Checkpoint requires stash ${unavailableStash}, but that stash is unavailable`),
  );
  assert.equal((await readCheckpoint(root, "migrate-runtime")).integration.stash_ref, unavailableStash);
  assert.match(await git(root, "worktree", "list", "--porcelain"), new RegExp(executionWorktree));
});

test("does not commit terminal records when their checkpoint fails integrity", async () => {
  const { root, executionPlan, checkpoint } = await codingFixture();
  const invalidComplete = completeIntegration({
    ...checkpoint,
    integration: { ...checkpoint.integration, execution_head: "b".repeat(40) },
  });
  await writeCheckpoint(root, "migrate-runtime", invalidComplete);
  const headBefore = await git(root, "rev-parse", "HEAD");
  await assert.rejects(
    createExecutionCoding().completeMergedCleanup({ repository: root, mainWorktree: root, featureSlug: "migrate-runtime", executionPlan, checkpoint: invalidComplete }),
    /Checkpoint integrity failed/,
  );
  assert.equal(await git(root, "rev-parse", "HEAD"), headBefore);
});

test("runtime-owned integration persistence does not expose writer injection", () => {
  assert.doesNotMatch(createExecutionCoding.toString(), /checkpointWriter|writeCheckpoint/);
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
    createExecutionCoding().integrate({ repository: root, worktree: executionWorktree, featureSlug: "migrate-runtime", executionPlan, checkpoint: invalid }),
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
  const checkpoint = createCheckpoint({ executionPlan: twoTaskPlan, baseline: head, branch: "feat/migrate-runtime", repository: root, worktree: executionWorktree });
  await writeCheckpoint(root, "migrate-runtime", checkpoint);
  const dispatched = [];
  const coding = createExecutionCoding({
    adapter: {
      async executeTicket({ ticket }) {
        dispatched.push(ticket.id);
        return { ticket_id: "01", status: "blocked", commits: [], checks: [], changed_paths: [], summary: "blocked", error: "stop" };
      },
    },
  });

  const result = await coding.executeFrontier({ repository: root, worktree: executionWorktree, mainWorktree: root, featureSlug: "migrate-runtime", executionPlan: twoTaskPlan, checkpoint });
  assert.deepEqual(dispatched, ["01"]);
  assert.equal(result.checkpoint.tickets.find((task) => task.id === "01").status, "blocked");
  assert.equal(result.checkpoint.tickets.find((task) => task.id === "02").status, "pending");
});

test("does not redispatch an in-progress task on recovery", async () => {
  const { root, executionPlan, executionWorktree } = await pendingIntegrationFixture();
  const head = await git(root, "rev-parse", "HEAD");
  const checkpoint = startTickets(createCheckpoint({ executionPlan, baseline: head, branch: "feat/migrate-runtime", repository: root, worktree: executionWorktree }), ["01"], head);
  await writeCheckpoint(root, "migrate-runtime", checkpoint);
  let dispatched = false;
  const coding = createExecutionCoding({ adapter: { async executeFrontier() { dispatched = true; return []; } } });

  const result = await coding.executeFrontier({ repository: root, worktree: executionWorktree, mainWorktree: root, featureSlug: "migrate-runtime", executionPlan, checkpoint });
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

  const multiInProgress = createCheckpoint({ executionPlan, baseline: head, branch: "feat/migrate-runtime", repository: root, worktree: executionWorktree });
    multiInProgress.tickets = executionPlan.tickets.map((ticket) => ({
      id: ticket.id,
      status: "in_progress",
      start_commit: head,
      started_at: "2026-07-23T12:00:00+08:00",
      claim_id: `claim-${ticket.id}`,
      expected_role_id: "full-stack-coder",
      session_id: "session",
  }));
  await writeCheckpoint(root, "migrate-runtime", multiInProgress);
  const multiBefore = await readFile(checkpointFile, "utf8");
  let writes = 0;
  const coding = createExecutionCoding({ checkpointWriter: async (...args) => { writes += 1; return writeCheckpoint(...args); } });

  await assert.rejects(
    coding.resume({ repository: root, branch: "feat/migrate-runtime", specPath: ".scratch/migrate-runtime/spec.md", worktreePath: executionWorktree }),
    /multiple-in-progress/,
  );
  assert.equal(writes, 0);
  assert.equal(await readFile(checkpointFile, "utf8"), multiBefore);

  const outOfOrder = createCheckpoint({ executionPlan, baseline: head, branch: "feat/migrate-runtime", repository: root, worktree: executionWorktree });
  outOfOrder.tickets[1] = {
    id: executionPlan.tickets[1].id,
    status: "done",
    start_commit: head,
    started_at: "2026-07-23T12:00:00+08:00",
    claim_id: "claim-02",
    expected_role_id: "full-stack-coder",
    session_id: "session",
    end_commit: head,
    completed_at: "2026-07-23T12:00:00+08:00",
  };
  await writeCheckpoint(root, "migrate-runtime", outOfOrder);
  const orderBefore = await readFile(checkpointFile, "utf8");

  await assert.rejects(
    coding.resume({ repository: root, branch: "feat/migrate-runtime", specPath: ".scratch/migrate-runtime/spec.md", worktreePath: executionWorktree }),
    /ticket-order/,
  );
  assert.equal(writes, 0);
  assert.equal(await readFile(checkpointFile, "utf8"), orderBefore);
});

test("rejects a caller plan that differs from the verified persisted plan before delegation", async () => {
  const { root, executionPlan, executionWorktree } = await pendingIntegrationFixture();
  const head = await git(root, "rev-parse", "HEAD");
  const checkpoint = createCheckpoint({ executionPlan, baseline: head, branch: "feat/migrate-runtime", repository: root, worktree: executionWorktree });
  await writeCheckpoint(root, "migrate-runtime", checkpoint);
  const checkpointFile = join(root, ".scratch", "migrate-runtime", "checkpoint.json");
  const issueFile = join(root, ".scratch", "migrate-runtime", "issues", "01-contract.md");
  const checkpointBefore = await readFile(checkpointFile, "utf8");
  const issueBefore = await readFile(issueFile, "utf8");
  let delegated = false;
  let writes = 0;
  const coding = createExecutionCoding({
    directExecutor: async () => {
      delegated = true;
      return { ticket_id: "01", status: "done", commits: [head], checks: [], changed_paths: [], summary: "done" };
    },
    checkpointWriter: async (...args) => { writes += 1; return writeCheckpoint(...args); },
  });

  await assert.rejects(
    coding.executeFrontier({
      repository: root, worktree: executionWorktree,
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

test("does not mutate an invalid checkpoint while attempting a relocated resume", async () => {
  const { root, executionPlan } = await codingFixture();
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
  const coding = createExecutionCoding({
    checkpointWriter: async (...args) => {
      writes += 1;
      return writeCheckpoint(...args);
    },
  });

  await assert.rejects(
    coding.resume({ repository: root, branch: "feat/migrate-runtime", specPath: ".scratch/migrate-runtime/spec.md", worktreePath: join(root, "recreated-worktree") }),
    /Checkpoint integrity failed/,
  );
  assert.equal(writes, 0);
  assert.equal(await readFile(checkpointFile, "utf8"), before);
  assert.equal(await git(root, "rev-parse", "HEAD"), headBefore);
});

test("rejects a persisted review range whose review commit is missing", async () => {
  const { root, checkpoint: completed, executionWorktree, featureCommit } = await completedExecutionFixture();
  const reviewing = beginReview(completed, { fixedPoint: completed.baseline, reviewCommit: featureCommit, manifest: reviewManifest(completed.baseline, featureCommit, ["execution.txt"]) });
  reviewing.review.review_commit = "f".repeat(40);
  await writeCheckpoint(root, "migrate-runtime", reviewing);

  await assert.rejects(
    createExecutionCoding().resume({
      repository: root,
      branch: "feat/migrate-runtime",
      specPath: ".scratch/migrate-runtime/spec.md",
      worktreePath: executionWorktree,
    }),
    /review-commit-missing/,
  );
});

test("rejects a persisted review fix whose commit is missing", async () => {
  const { root, checkpoint: completed, executionWorktree, featureCommit } = await completedExecutionFixture();
  let checkpoint = beginReview(completed, { fixedPoint: completed.baseline, reviewCommit: featureCommit, manifest: reviewManifest(completed.baseline, featureCommit, ["execution.txt"]) });
  const result = reviewResult(checkpoint, { blocking: true });
  checkpoint = recordReview(checkpoint, { manifestDigest: result.manifest_digest, coverage: result.coverage, findingsSummary: "requires a fix", result });
  checkpoint = decideReview(checkpoint, "fix", ["standards-001"]);
  checkpoint = completeReviewFix(checkpoint, { fixCommit: "f".repeat(40), checks: ["npm test: pass"] });
  await writeCheckpoint(root, "migrate-runtime", checkpoint);

  await assert.rejects(
    createExecutionCoding().resume({
      repository: root,
      branch: "feat/migrate-runtime",
      specPath: ".scratch/migrate-runtime/spec.md",
      worktreePath: executionWorktree,
    }),
    /review-fix-commit-missing/,
  );
});

test("does not create a recovery worktree when the current checkpoint is unavailable", async () => {
  const { root } = await codingFixture();
  const branch = "feat/migrate-runtime";
  const worktreePath = join(root, "recovery-worktree");
  await git(root, "branch", branch);
  const worktreesBefore = await git(root, "worktree", "list", "--porcelain");

  await assert.rejects(
    createExecutionCoding().resume({ repository: root, branch, specPath: ".scratch/migrate-runtime/spec.md", worktreePath }),
    /Checkpoint integrity failed/,
  );

  assert.equal(await git(root, "worktree", "list", "--porcelain"), worktreesBefore);
  assert.equal(await git(root, "branch", "--show-current"), "main");
});

test("rejects complete checkpoints with pending work before terminal handling", async () => {
  const { root, checkpoint } = await codingFixture();
  const invalidComplete = completeIntegration(checkpoint);
  invalidComplete.tickets[0] = { id: "01", status: "pending" };
  const checkpointFile = join(root, ".scratch", "migrate-runtime", "checkpoint.json");
  const serialized = `${JSON.stringify(invalidComplete, null, 2)}\n`;
  await writeFile(checkpointFile, serialized);
  const headBefore = await git(root, "rev-parse", "HEAD");
  let writes = 0;
  let generated = false;
  const coding = createExecutionCoding({
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
    coding.resume({ repository: root, branch: "feat/migrate-runtime", specPath: ".scratch/migrate-runtime/spec.md", worktreePath: join(root, "unused-worktree") }),
    /Checkpoint integrity failed/,
  );
  assert.equal(writes, 0);
  assert.equal(generated, false);
  assert.equal(await readFile(checkpointFile, "utf8"), serialized);
  assert.equal(await git(root, "rev-parse", "HEAD"), headBefore);
});

test("rejects complete checkpoints whose review is not done", async () => {
  const { checkpoint } = await codingFixture();
  const invalidComplete = completeIntegration(checkpoint);
  invalidComplete.review = { status: "pending" };

  assert.throws(() => assertCheckpoint(invalidComplete), /Checkpoint violates schema/);
});
