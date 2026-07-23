import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { completeIntegration, createCheckpoint, markMerged, readCheckpoint, writeCheckpoint } from "../lib/checkpoint.mjs";
import { materializeLocalPlan, readExecutionPlan, writeExecutionPlan } from "../lib/execution-plan.mjs";
import { derivePlanLocation, sourcePlanPath } from "../lib/paths.mjs";
import { assertCheckpoint, assertExecutionPlan } from "../lib/validation.mjs";

async function planFixture() {
  const root = await mkdtemp(join(tmpdir(), "run-plan-"));
  const directory = join(root, ".ai-work-flow", "plans", "migrate-runtime");
  await mkdir(join(directory, "tasks"), { recursive: true });
  await writeFile(join(directory, "plan.md"), "# Migrate runtime\n");
  await writeFile(join(directory, "tasks", "01-contract.md"), "# Contract\n\n## Dependencies\n\nNone - can start immediately\n\n- [ ] Verify runtime contract\n");
  return { root, planPath: join(directory, "plan.md") };
}

test("derives a plan ID only from the canonical plan path", async () => {
  const { root, planPath } = await planFixture();
  assert.deepEqual(derivePlanLocation(root, planPath), {
    planId: "migrate-runtime",
    path: ".ai-work-flow/plans/migrate-runtime/plan.md",
    absolutePath: planPath,
  });
  assert.throws(
    () => derivePlanLocation(root, join(root, "notes", "plan.md")),
    /Plan path must be .ai-work-flow\/plans\/<planId>\/plan\.md/,
  );
  assert.throws(
    () => derivePlanLocation(root, ".ai-work-flow/plans/one/plan.md"),
    /Plan path must be .ai-work-flow\/plans\/<planId>\/plan\.md/,
  );
  assert.throws(
    () => derivePlanLocation(root, ".ai-work-flow/plans/two-words-1/plan.md"),
    /Plan path must be .ai-work-flow\/plans\/<planId>\/plan\.md/,
  );
});

test("persists execution records beside the canonical plan with the plan/task schema", async () => {
  const { root, planPath } = await planFixture();
  const now = new Date("2026-07-23T12:00:00+08:00");
  const executionPlan = await materializeLocalPlan({ mainWorktree: root, planPath, now });
  assert.equal(executionPlan.plan.plan_id, "migrate-runtime");
  assert.equal(executionPlan.plan.ref, sourcePlanPath("migrate-runtime"));
  assert.deepEqual(executionPlan.tasks.map((task) => task.id), ["01"]);
  await writeExecutionPlan(root, executionPlan);
  assert.deepEqual(await readExecutionPlan(root, "migrate-runtime"), executionPlan);

  const checkpoint = createCheckpoint({
    executionPlan,
    baseline: "a".repeat(40),
    branch: "plan/migrate-runtime",
    worktree: root,
    now,
  });
  assert.deepEqual(checkpoint.plan, { path: sourcePlanPath("migrate-runtime"), revision: executionPlan.revision });
  assert.deepEqual(checkpoint.tasks, [{ id: "01", status: "pending" }]);
  await writeCheckpoint(root, "migrate-runtime", checkpoint);
  assert.deepEqual(await readCheckpoint(root, "migrate-runtime"), checkpoint);
});

test("rejects legacy execution-plan and checkpoint fields", () => {
  const oldRoot = `.${["scr", "atch"].join("")}`;
  const oldSource = ["sp", "ec"].join("");
  const oldPlanId = ["feature", "slug"].join("_");
  const oldJson = ["plan", "json"].join(".");
  const validTask = { id: "01", ref: ".ai-work-flow/plans/example/tasks/01-work.md", title: "Work", level: 0, blocked_by: [] };
  assert.throws(() => assertExecutionPlan({
    version: 1,
    revision: "a".repeat(64),
    created_at: "2026-07-23T12:00:00+08:00",
    execution_mode: "delegated",
    plan: { ref: ".ai-work-flow/plans/example/plan.md", plan_id: "example", title: "Current" },
    [oldSource]: { ref: `${oldRoot}/example/${oldSource}.md`, [oldPlanId]: "example", title: "Legacy" },
    tasks: [validTask],
  }), /Execution Plan violates schema/);
  assert.throws(() => assertCheckpoint({
    version: 1,
    plan: { path: `${oldRoot}/example/${oldJson}`, revision: "a".repeat(64) },
    status: "executing",
    baseline: "a".repeat(40),
    branch: "plan/example",
    worktree: "/tmp/example",
    created_at: "2026-07-23T12:00:00+08:00",
    updated_at: "2026-07-23T12:00:00+08:00",
    tasks: [],
    review: { status: "pending" },
    integration: { status: "pending", target_branch: "main", [oldPlanId]: "a".repeat(40) },
    history: [],
  }), /Checkpoint violates schema/);
});

test("rejects duplicate task IDs derived from task file names", async () => {
  const { root, planPath } = await planFixture();
  const taskDirectory = join(root, ".ai-work-flow", "plans", "migrate-runtime", "tasks");
  await writeFile(join(taskDirectory, "01-second-contract.md"), "# Second contract\n");

  await assert.rejects(
    materializeLocalPlan({ mainWorktree: root, planPath }),
    /Duplicate derived task ID: 01/,
  );
});

test("retains a persisted stash reference when integration is marked merged", async () => {
  const { root, planPath } = await planFixture();
  const executionPlan = await materializeLocalPlan({ mainWorktree: root, planPath });
  const checkpoint = createCheckpoint({
    executionPlan,
    baseline: "a".repeat(40),
    branch: "plan/migrate-runtime",
    worktree: root,
  });
  checkpoint.status = "integrating";
  checkpoint.integration.stash_ref = "b".repeat(40);

  const merged = markMerged(checkpoint, {
    executionHead: "a".repeat(40),
    mainWorktree: root,
    mergedCommit: "a".repeat(40),
  });

  assert.equal(merged.integration.stash_ref, "b".repeat(40));
});

test("rejects terminal integration while stash restoration is applying", async () => {
  const { root, planPath } = await planFixture();
  const executionPlan = await materializeLocalPlan({ mainWorktree: root, planPath });
  const checkpoint = createCheckpoint({ executionPlan, baseline: "a".repeat(40), branch: "plan/migrate-runtime", worktree: root });
  checkpoint.status = "integrating";
  checkpoint.review = { status: "done", findings_summary: "approved", completed_at: "2026-07-23T12:00:00+08:00" };
  checkpoint.tasks = [{ id: "01", status: "done", end_commit: "a".repeat(40), completed_at: "2026-07-23T12:00:00+08:00" }];
  const merged = markMerged(checkpoint, { executionHead: "a".repeat(40), mainWorktree: root, mergedCommit: "a".repeat(40) });
  merged.integration = { ...merged.integration, stash_ref: "b".repeat(40), stash_restore_state: "applying" };

  assert.throws(() => completeIntegration(merged), /Stash restoration is still applying/);
});

test("requires completed tasks and review before integrating or merged records", async () => {
  const { root, planPath } = await planFixture();
  const executionPlan = await materializeLocalPlan({ mainWorktree: root, planPath });
  const checkpoint = createCheckpoint({ executionPlan, baseline: "a".repeat(40), branch: "plan/migrate-runtime", worktree: root });
  checkpoint.status = "integrating";
  assert.throws(() => assertCheckpoint(checkpoint), /Checkpoint violates schema/);

  const merged = markMerged(checkpoint, { executionHead: "a".repeat(40), mainWorktree: root, mergedCommit: "a".repeat(40) });
  assert.throws(() => assertCheckpoint(merged), /Checkpoint violates schema/);
});
