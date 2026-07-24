import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { beginReview, completeIntegration, completeReview, completeTicket, createCheckpoint, markMerged, readCheckpoint, startTickets, writeCheckpoint } from "../lib/checkpoint.mjs";
import { materializeSpec, readExecutionPlan, writeExecutionPlan } from "../lib/spec-intake.mjs";
import { deriveSpecLocation, sourceSpecPath } from "../lib/paths.mjs";
import { assertCheckpoint, assertExecutionPlan } from "../lib/validation.mjs";

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
    worktree: "/tmp/example",
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
    worktree: "/tmp/example",
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
    worktree: "/tmp/example",
    created_at: "2026-07-23T12:00:00+08:00",
    updated_at: "2026-07-23T12:00:00+08:00",
    tickets: [{ id: "01", status: "in_progress", start_commit: "a".repeat(40), started_at: "2026-07-23T12:00:00+08:00" }],
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
  checkpoint = beginReview(checkpoint);
  checkpoint = completeReview(checkpoint, "approved");
  checkpoint.integration.stash_ref = "b".repeat(40);

  const merged = markMerged(checkpoint, {
    executionHead: "a".repeat(40),
    mainWorktree: root,
    mergedCommit: "a".repeat(40),
  });

  assert.equal(merged.integration.stash_ref, "b".repeat(40));
});

test("rejects terminal integration while stash restoration is applying", async () => {
  const { root, specPath } = await specFixture();
  const executionPlan = await materializeSpec({ mainWorktree: root, specPath });
  const checkpoint = createCheckpoint({ executionPlan, baseline: "a".repeat(40), branch: "feat/migrate-runtime", worktree: root });
  checkpoint.status = "integrating";
  checkpoint.review = { status: "done", findings_summary: "approved", completed_at: "2026-07-23T12:00:00+08:00" };
  checkpoint.tickets = [{ id: "01", status: "done", start_commit: "a".repeat(40), started_at: "2026-07-23T12:00:00+08:00", end_commit: "a".repeat(40), completed_at: "2026-07-23T12:00:00+08:00" }];
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
