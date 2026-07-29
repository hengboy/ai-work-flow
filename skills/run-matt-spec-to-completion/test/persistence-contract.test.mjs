import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { beginReview, completeIntegration, completeReview, completeReviewFix, completeTicket, createCheckpoint, decideReview, markMerged, readCheckpoint, recordReview, startTickets, writeCheckpoint } from "../lib/checkpoint.mjs";
import { materializeSpec, readExecutionPlan, writeExecutionPlan } from "../lib/spec-intake.mjs";
import { deriveSpecLocation, sourceSpecPath } from "../lib/paths.mjs";
import { assertCheckpoint, assertExecutionPlan } from "../lib/validation.mjs";
import { createReviewManifest } from "../lib/review-manifest.mjs";

function reviewManifest(fixedPoint, reviewCommit) {
  return createReviewManifest({ fixed_point: fixedPoint, review_commit: reviewCommit, commit_list: [{ sha: reviewCommit, subject: "review" }], changed_paths: [], checks: [], diff_command: ["git", "diff", "--no-ext-diff", `${fixedPoint}...${reviewCommit}`], spec_status: "absent", spec_source: null, standards_source: [{ path: "CONTEXT.md", revision: reviewCommit }], shards: [] });
}

async function specFixture() {
  const root = await mkdtemp(join(tmpdir(), "run-plan-"));
  const directory = join(root, ".scratch", "migrate-runtime");
  await mkdir(join(directory, "issues"), { recursive: true });
  await writeFile(join(directory, "spec.md"), "# Migrate runtime\n");
  await writeFile(join(directory, "issues", "01-contract.md"), "# 01 — Contract\n\n**Blocked by:** None — can start immediately\n\n- [ ] Verify runtime contract\n");
  return { root, specPath: join(directory, "spec.md") };
}

test("derives a feature slug only from the canonical spec path", async () => {
  const { root, specPath } = await specFixture();
  assert.deepEqual(deriveSpecLocation(root, specPath), {
    featureSlug: "migrate-runtime",
    path: ".scratch/migrate-runtime/spec.md",
    absolutePath: specPath,
  });
  assert.throws(
    () => deriveSpecLocation(root, join(root, "notes", "spec.md")),
    /Spec path must be \.scratch\/<featureSlug>\/spec\.md/,
  );
  assert.throws(
    () => deriveSpecLocation(root, ".scratch/UPPERCASE/spec.md"),
    /Spec path must be \.scratch\/<featureSlug>\/spec\.md/,
  );
  assert.throws(
    () => deriveSpecLocation(root, ".scratch/two words/spec.md"),
    /Spec path must be \.scratch\/<featureSlug>\/spec\.md/,
  );
});

test("persists execution records beside the canonical spec with the spec/ticket schema", async () => {
  const { root, specPath } = await specFixture();
  const now = new Date("2026-07-23T12:00:00+08:00");
  const executionPlan = await materializeSpec({ mainWorktree: root, specPath, now });
  assert.equal(executionPlan.spec.feature_slug, "migrate-runtime");
  assert.equal(executionPlan.spec.ref, sourceSpecPath("migrate-runtime"));
  assert.deepEqual(executionPlan.tickets.map((ticket) => ticket.id), ["01"]);
  await writeExecutionPlan(root, executionPlan);
  assert.deepEqual(await readExecutionPlan(root, "migrate-runtime"), executionPlan);

  let checkpoint = createCheckpoint({
    executionPlan,
    baseline: "a".repeat(40),
    branch: "feat/migrate-runtime",
    worktree: root,
    now,
  });
  assert.deepEqual(checkpoint.spec, { path: sourceSpecPath("migrate-runtime"), revision: executionPlan.revision });
  assert.deepEqual(checkpoint.tickets, [{ id: "01", status: "pending" }]);
  await writeCheckpoint(root, "migrate-runtime", checkpoint);
  assert.deepEqual(await readCheckpoint(root, "migrate-runtime"), checkpoint);
});

test("persists only repository-relative worktree paths and rejects legacy absolute paths", async () => {
  const { root, specPath } = await specFixture();
  const executionPlan = await materializeSpec({ mainWorktree: root, specPath });
  const worktree = join(root, "worktrees", "migrate-runtime-worktree");
  const checkpoint = createCheckpoint({
    executionPlan,
    baseline: "a".repeat(40),
    branch: "feat/migrate-runtime",
    repository: root,
    worktree,
  });

  assert.equal(checkpoint.worktree, relative(root, worktree));
  await writeCheckpoint(root, "migrate-runtime", checkpoint);
  assert.equal((await readCheckpoint(root, "migrate-runtime")).worktree, relative(root, worktree));
  await writeFile(join(root, ".scratch", "migrate-runtime", "checkpoint.json"), `${JSON.stringify({ ...checkpoint, worktree }, null, 2)}\n`);
  await assert.rejects(readCheckpoint(root, "migrate-runtime"), /Checkpoint violates schema|repository-relative path/);
  assert.throws(
    () => assertCheckpoint({ ...checkpoint, worktree: "/tmp/migrate-runtime-worktree" }),
    /Checkpoint violates schema/,
  );
  await assert.rejects(
    writeCheckpoint(root, "migrate-runtime", { ...checkpoint, worktree: "../migrate-runtime-worktree" }),
    /Checkpoint violates schema|relative traversal segments/,
  );
});

test("rejects legacy execution-plan and checkpoint fields", () => {
  const oldPlan = ["pl", "an"].join("");
  const oldSlug = ["plan", "id"].join("_");
  const validTicket = { id: "01", ref: ".scratch/example/issues/01-work.md", title: "Work", level: 0, blocked_by: [] };
  assert.throws(() => assertExecutionPlan({
    version: 1,
    revision: "a".repeat(64),
    created_at: "2026-07-23T12:00:00+08:00",
    execution_mode: "delegated",
    spec: { ref: ".scratch/example/spec.md", feature_slug: "example", title: "Current" },
    [oldPlan]: { ref: ".scratch/example/spec.md", [oldSlug]: "example", title: "Legacy" },
    tickets: [validTicket],
  }), /Execution Plan violates schema/);
  assert.throws(() => assertCheckpoint({
    version: 1,
    spec: { path: ".scratch/example/spec.md", revision: "a".repeat(64) },
    [oldPlan]: { path: ".scratch/example/spec.md", revision: "a".repeat(64) },
    status: "executing",
    baseline: "a".repeat(40),
    branch: "feat/example",
    worktree: ".",
    created_at: "2026-07-23T12:00:00+08:00",
    updated_at: "2026-07-23T12:00:00+08:00",
    tickets: [],
    review: { status: "pending" },
    integration: { status: "pending", target_branch: "main" },
    history: [],
  }), /Checkpoint violates schema/);
});

test("rejects checkpoint ticket fields that conflict with their status", () => {
  const base = {
    version: 1,
    spec: { path: ".scratch/example/spec.md", revision: "a".repeat(64) },
    status: "executing",
    baseline: "a".repeat(40),
    branch: "feat/example",
    worktree: ".",
    created_at: "2026-07-23T12:00:00+08:00",
    updated_at: "2026-07-23T12:00:00+08:00",
    review: { status: "pending" },
    integration: { status: "pending", target_branch: "main" },
    history: [],
  };

  assert.throws(() => assertCheckpoint({
    ...base,
    tickets: [{ id: "01", status: "pending", start_commit: "a".repeat(40) }],
  }), /Checkpoint violates schema/);
  assert.throws(() => assertCheckpoint({
    ...base,
    tickets: [{ id: "01", status: "done", end_commit: "a".repeat(40), completed_at: "2026-07-23T12:00:00+08:00" }],
  }), /Checkpoint violates schema/);
});

test("accepts an interrupted in-progress checkpoint in the current format", () => {
  assert.doesNotThrow(() => assertCheckpoint({
    version: 1,
    spec: { path: ".scratch/example/spec.md", revision: "a".repeat(64) },
    status: "executing",
    baseline: "a".repeat(40),
    branch: "feat/example",
    worktree: ".",
    created_at: "2026-07-23T12:00:00+08:00",
    updated_at: "2026-07-23T12:00:00+08:00",
    tickets: [{ id: "01", status: "in_progress", start_commit: "a".repeat(40), started_at: "2026-07-23T12:00:00+08:00", claim_id: "claim", expected_role_id: "full-stack-coder", session_id: "session" }],
    review: { status: "pending" },
    integration: { status: "pending", target_branch: "main" },
    history: [{ event: "dispatched", detail: "01", at: "2026-07-23T12:00:00+08:00" }],
  }));
});

test("starts exactly one pending ticket at a time", async () => {
  const { root, specPath } = await specFixture();
  const issues = join(root, ".scratch", "migrate-runtime", "issues");
  await writeFile(join(issues, "02-follow-up.md"), "# 02 — Follow up\n\n**Blocked by:** None — can start immediately\n");
  const executionPlan = await materializeSpec({ mainWorktree: root, specPath });
  const checkpoint = createCheckpoint({ executionPlan, baseline: "a".repeat(40), branch: "feat/migrate-runtime", worktree: root });

  assert.throws(
    () => startTickets(checkpoint, ["01", "02"], "a".repeat(40)),
    /Exactly one pending ticket can be started at a time/,
  );
});

test("freezes the committed range when review begins", async () => {
  const { root, specPath } = await specFixture();
  const executionPlan = await materializeSpec({ mainWorktree: root, specPath });
  const fixedPoint = "a".repeat(40);
  const reviewCommit = "b".repeat(40);
  let checkpoint = createCheckpoint({ executionPlan, baseline: fixedPoint, branch: "feat/migrate-runtime", worktree: root });
  checkpoint = startTickets(checkpoint, ["01"], fixedPoint);
  checkpoint = completeTicket(checkpoint, "01", reviewCommit);

  checkpoint = beginReview(checkpoint, { fixedPoint, reviewCommit, manifest: reviewManifest(fixedPoint, reviewCommit) }, new Date("2026-07-23T12:00:00+08:00"));

  assert.equal(checkpoint.review.manifest.fixed_point, fixedPoint);
  assert.equal(checkpoint.review.manifest.review_commit, reviewCommit);
  assert.equal(checkpoint.review.manifest.manifest_digest.length, 64);
  assert.equal(checkpoint.review.started_at, "2026-07-23T12:00:00.000+08:00");
  const frozen = structuredClone(checkpoint);
  assert.throws(
    () => beginReview(checkpoint, { fixedPoint, reviewCommit: "c".repeat(40), manifest: reviewManifest(fixedPoint, "c".repeat(40)) }),
    /Review can only begin from a pending execution review/,
  );
  assert.deepEqual(checkpoint, frozen);
  assert.throws(
    () => beginReview({ ...checkpoint, status: "executing", review: { status: "pending" } }, { fixedPoint: "c".repeat(40), reviewCommit, manifest: reviewManifest("c".repeat(40), reviewCommit) }),
    /fixed point must match the most recently synchronized main commit/,
  );
});

test("rejects duplicate ticket IDs derived from issue file names", async () => {
  const { root, specPath } = await specFixture();
  const issueDirectory = join(root, ".scratch", "migrate-runtime", "issues");
  await writeFile(join(issueDirectory, "01-second-contract.md"), "# 01 — Second contract\n");

  await assert.rejects(
    materializeSpec({ mainWorktree: root, specPath }),
    /Duplicate derived ticket ID: 01/,
  );
});

test("retains a persisted stash reference when integration is marked merged", async () => {
  const { root, specPath } = await specFixture();
  const executionPlan = await materializeSpec({ mainWorktree: root, specPath });
  let checkpoint = createCheckpoint({
    executionPlan,
    baseline: "a".repeat(40),
    branch: "feat/migrate-runtime",
    worktree: root,
  });
  checkpoint = startTickets(checkpoint, ["01"], "a".repeat(40));
  checkpoint = completeTicket(checkpoint, "01", "a".repeat(40));
  checkpoint = beginReview(checkpoint, { fixedPoint: checkpoint.baseline, reviewCommit: "a".repeat(40), manifest: reviewManifest(checkpoint.baseline, "a".repeat(40)) });
  checkpoint = recordReview(checkpoint, { manifestDigest: checkpoint.review.manifest.manifest_digest, coverage: { manifest_digest: checkpoint.review.manifest.manifest_digest, completed_shard_ids: [], incomplete_shard_ids: [] }, findingsSummary: "approved" });
  checkpoint = decideReview(checkpoint, "approve");
  checkpoint.integration.stash_ref = "b".repeat(40);

  const merged = markMerged(checkpoint, {
    executionHead: "a".repeat(40),
    mainWorktree: root,
    mergedCommit: "a".repeat(40),
  });

  assert.equal(merged.integration.stash_ref, "b".repeat(40));
  assert.equal(merged.integration.main_worktree, ".");
});

test("rejects terminal integration while stash restoration is applying", async () => {
  const { root, specPath } = await specFixture();
  const executionPlan = await materializeSpec({ mainWorktree: root, specPath });
  const checkpoint = createCheckpoint({ executionPlan, baseline: "a".repeat(40), branch: "feat/migrate-runtime", worktree: root });
  checkpoint.status = "integrating";
  const manifest = reviewManifest("a".repeat(40), "a".repeat(40));
  checkpoint.review = { status: "done", fixed_point: "a".repeat(40), review_commit: "a".repeat(40), manifest, manifest_digest: manifest.manifest_digest, coverage: { manifest_digest: manifest.manifest_digest, completed_shard_ids: [], incomplete_shard_ids: [] }, findings_summary: "approved", started_at: "2026-07-23T12:00:00+08:00", completed_at: "2026-07-23T12:00:00+08:00" };
  checkpoint.tickets = [{ id: "01", status: "done", start_commit: "a".repeat(40), started_at: "2026-07-23T12:00:00+08:00", claim_id: "claim", expected_role_id: "full-stack-coder", session_id: "session", end_commit: "a".repeat(40), completed_at: "2026-07-23T12:00:00+08:00" }];
  const merged = markMerged(checkpoint, { executionHead: "a".repeat(40), mainWorktree: root, mergedCommit: "a".repeat(40) });
  merged.integration = { ...merged.integration, stash_ref: "b".repeat(40), stash_restore_state: "applying" };

  assert.throws(() => completeIntegration(merged), /Stash restoration is still applying/);
});

test("rejects integration states before tickets and review complete", async () => {
  const { root, specPath } = await specFixture();
  const executionPlan = await materializeSpec({ mainWorktree: root, specPath });
  const checkpoint = createCheckpoint({ executionPlan, baseline: "a".repeat(40), branch: "feat/migrate-runtime", worktree: root });
  checkpoint.status = "integrating";
  assert.throws(() => assertCheckpoint(checkpoint), /Checkpoint violates schema/);
  assert.throws(() => markMerged(checkpoint, { executionHead: "a".repeat(40), mainWorktree: root, mergedCommit: "a".repeat(40) }), /Checkpoint violates schema/);
});

test("returns user-approved review fixes to synchronization before final review", async () => {
  const { root, specPath } = await specFixture();
  const executionPlan = await materializeSpec({ mainWorktree: root, specPath });
  let checkpoint = createCheckpoint({ executionPlan, baseline: "a".repeat(40), branch: "feat/migrate-runtime", worktree: root });
  checkpoint = startTickets(checkpoint, ["01"], "a".repeat(40));
  checkpoint = completeTicket(checkpoint, "01", "b".repeat(40));
  checkpoint = beginReview(checkpoint, { fixedPoint: checkpoint.baseline, reviewCommit: "b".repeat(40), manifest: reviewManifest(checkpoint.baseline, "b".repeat(40)) });
  checkpoint = recordReview(checkpoint, { manifestDigest: checkpoint.review.manifest.manifest_digest, coverage: { manifest_digest: checkpoint.review.manifest.manifest_digest, completed_shard_ids: [], incomplete_shard_ids: [] }, findingsSummary: "needs a user choice" });
  assert.equal(checkpoint.review.status, "awaiting_user");
  checkpoint = decideReview(checkpoint, "fix");
  assert.equal(checkpoint.status, "fixing");
  assert.equal(checkpoint.review.status, "done");
  assert.equal(checkpoint.review.decision, "fix");
  checkpoint = completeReviewFix(checkpoint, { fixCommit: "c".repeat(40), checks: ["npm test: pass"] });
  assert.equal(checkpoint.status, "executing");
  assert.equal(checkpoint.review.status, "pending");
  assert.equal(checkpoint.review_attempts[0].fix_commit, "c".repeat(40));
  assert.deepEqual(checkpoint.review_attempts[0].fix_checks, ["npm test: pass"]);
});
