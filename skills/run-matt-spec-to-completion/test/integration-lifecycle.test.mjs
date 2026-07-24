import assert from "node:assert/strict";
import test from "node:test";

import { createIntegrationLifecycle } from "../lib/integration-lifecycle.mjs";
import { createPreMergeStash } from "../lib/pre-merge-stash.mjs";

test("does not report a stash patch as applied when its async reverse check is false or fails", async () => {
  const calls = [];
  const stash = createPreMergeStash({
    git: async (_worktree, args) => {
      calls.push(args);
      if (args[0] === "stash" && args[1] === "list") return "a".repeat(40);
      if (args[0] === "stash" && args[1] === "show") return "diff --git a/file b/file\n";
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    },
    gitSucceeds: async () => true,
    gitOutput: async () => "diff --git a/file b/file\n",
    gitSucceedsWithInput: async () => false,
  });

  assert.deepEqual(await stash.reconcile("/main", "a".repeat(40)), { listed: true, applied: false });
  assert.equal(calls.some((args) => args.includes("drop")), false);

  const failingStash = createPreMergeStash({
    git: async (_worktree, args) => args[0] === "stash" && args[1] === "list" ? "a".repeat(40) : "",
    gitSucceeds: async () => true,
    gitOutput: async () => "diff --git a/file b/file\n",
    gitSucceedsWithInput: async () => { throw new Error("reverse check failed"); },
  });
  await assert.rejects(failingStash.reconcile("/main", "a".repeat(40)), /reverse check failed/);
});

test("does not mark or drop a restored stash until its reverse check confirms the patch", async () => {
  const checkpoint = {
    version: 1,
    spec: { path: ".scratch/example/spec.md", revision: "b".repeat(64) },
    status: "integrating",
    baseline: "a".repeat(40),
    branch: "feat/example",
    worktree: "/execution",
    created_at: "2026-07-23T12:00:00+08:00",
    updated_at: "2026-07-23T12:00:00+08:00",
    tickets: [{
      id: "01",
      status: "done",
      start_commit: "a".repeat(40),
      started_at: "2026-07-23T12:00:00+08:00",
      end_commit: "a".repeat(40),
      completed_at: "2026-07-23T12:00:00+08:00",
    }],
    review: { status: "done", findings_summary: "approved", completed_at: "2026-07-23T12:00:00+08:00" },
    integration: {
      status: "merged",
      target_branch: "main",
      execution_head: "a".repeat(40),
      main_worktree: "/main",
      merged_commit: "a".repeat(40),
      merged_at: "2026-07-23T12:00:00+08:00",
      stash_ref: "a".repeat(40),
      stash_restore_state: "restored",
      stash_cleanup_state: "pending",
    },
    history: [],
  };
  let dropped = false;
  let persisted = false;
  const lifecycle = createIntegrationLifecycle({
    now: () => "2026-07-23T12:00:00+08:00",
    requireIntegrity: async () => ({ checkpoint, executionPlan: {} }),
    persist: async () => { persisted = true; },
    stash: {
      reconcile: async () => ({ listed: true, applied: false }),
      drop: async () => { dropped = true; },
    },
    executionRecordsHaveChanges: async () => false,
    commitExecutionRecords: async () => {},
    findExecutionWorktree: async () => null,
    removeExecutionWorktree: async () => {},
    gitSucceeds: async () => true,
    git: async () => "",
    unexpectedMainWorktreeChanges: async () => [],
  });

  await assert.rejects(
    lifecycle.completeMergedCleanup({ repository: "/repo", mainWorktree: "/main", featureSlug: "example", executionPlan: {}, checkpoint }),
    /Could not reconcile restored stash/,
  );
  assert.equal(dropped, false);
  assert.equal(persisted, false);
});

test("stops merged cleanup before removing a worktree when a recorded stash is unavailable", async () => {
  let removed = false;
  const checkpoint = {
    status: "integrating",
    integration: {
      status: "merged",
      stash_ref: "a".repeat(40),
      stash_restore_state: "applying",
    },
  };
  const lifecycle = createIntegrationLifecycle({
    now: () => "2026-07-23T12:00:00+08:00",
    requireIntegrity: async () => ({ checkpoint }),
    persist: async () => {},
    stash: {},
    executionRecordsHaveChanges: async () => false,
    commitExecutionRecords: async () => {},
    findExecutionWorktree: async () => "/tmp/execution",
    removeExecutionWorktree: async () => { removed = true; },
    gitSucceeds: async () => false,
    git: async () => "",
    unexpectedMainWorktreeChanges: async () => [],
  });
  await assert.rejects(
    lifecycle.completeMergedCleanup({ repository: "/repo", mainWorktree: "/main", featureSlug: "example", executionPlan: {}, checkpoint }),
    /Checkpoint requires stash/,
  );

  assert.equal(removed, false);
});
