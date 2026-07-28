import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { parsePorcelainV2, pathChangesEqual } from "../lib/paths.mjs";
import { commitWithPathChangeReport } from "../lib/git.mjs";
import { assertReviewCoverage, assertReviewManifest, createReviewManifest, createReviewShardAssignments } from "../lib/review-manifest.mjs";

test("parses porcelain v2 NUL records without splitting special or rename/copy paths", () => {
  const changes = parsePorcelainV2(Buffer.from(
    "1 .M N... 100644 100644 100644 a b name with\nnewline\tand space\0" +
    "2 R. N... 100644 100644 100644 a b R100 renamed file\0original file\0" +
    "2 C. N... 100644 100644 100644 a b C100 copied file\0source file\0" +
    "? -leading-quote\\path\0",
  ));
  assert.deepEqual(changes, [
    { record_type: "1", index_status: ".", worktree_status: "M", path: "name with\nnewline\tand space" },
    { record_type: "2", index_status: "C", worktree_status: ".", path: "copied file", source_path: "source file" },
    { record_type: "2", index_status: "R", worktree_status: ".", path: "renamed file", source_path: "original file" },
    { record_type: "?", index_status: ".", worktree_status: ".", path: "-leading-quote\\path" },
  ]);
  assert.equal(pathChangesEqual(changes, [...changes].reverse()), true);
});

test("uses one immutable review manifest for every required review axis and complete coverage", () => {
  const fixedPoint = "a".repeat(40);
  const reviewCommit = "b".repeat(40);
  const manifest = createReviewManifest({
    fixed_point: fixedPoint,
    review_commit: reviewCommit,
    commit_list: [{ sha: reviewCommit, subject: "reviewed change" }],
    changed_paths: [{ record_type: "1", index_status: "M", worktree_status: ".", path: "a file" }],
    checks: ["git diff --check"],
    diff_command: ["git", "diff", "--no-ext-diff", `${fixedPoint}...${reviewCommit}`],
    spec_status: "present",
    spec_source: { path: ".scratch/example/spec.md", revision: "c".repeat(64) },
    standards_source: [{ path: "CONTEXT.md", revision: "d".repeat(64) }],
    shards: [
      { id: "a", paths: ["a file"], diff_command: ["git", "diff", "--no-ext-diff", `${fixedPoint}...${reviewCommit}`, "--", "a file"] },
      { id: "b", paths: ["b file"], diff_command: ["git", "diff", "--no-ext-diff", `${fixedPoint}...${reviewCommit}`, "--", "b file"] },
    ],
  });
  const assignments = createReviewShardAssignments(manifest);
  assert.equal(assignments.standards.manifest_digest, assignments.spec.manifest_digest);
  assert.equal(assignments.standards.manifest, assignments.spec.manifest);
  assert.equal(Object.isFrozen(assignments.standards.manifest.shards), true);
  assert.doesNotThrow(() => assertReviewCoverage(manifest, { manifest_digest: manifest.manifest_digest, completed_shard_ids: ["a", "b"], incomplete_shard_ids: [] }));
  assert.throws(() => assertReviewCoverage(manifest, { manifest_digest: manifest.manifest_digest, completed_shard_ids: ["a", "a"], incomplete_shard_ids: [] }), /coverage/);
  assert.throws(() => assertReviewManifest({ ...manifest, review_commit: "e".repeat(40) }), /digest/);
});

test("omits Spec only when the manifest explicitly declares it absent", () => {
  const manifest = createReviewManifest({
    fixed_point: "a".repeat(40), review_commit: "b".repeat(40), commit_list: [], changed_paths: [], checks: [], diff_command: ["git", "diff"],
    spec_status: "absent", spec_source: null, standards_source: [], shards: [],
  });
  assert.deepEqual(Object.keys(createReviewShardAssignments(manifest)), ["standards"]);
});

test("reports staged and worktree path changes after a failing hook without resetting either", async () => {
  const root = await mkdtemp(join(tmpdir(), "path-change-hook-"));
  const run = promisify(execFile);
  await run("git", ["init", "-b", "main"], { cwd: root });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await run("git", ["config", "user.name", "Test User"], { cwd: root });
  await writeFile(join(root, "staged name\nfile"), "staged\n");
  await run("git", ["add", "--", "staged name\nfile"], { cwd: root });
  await writeFile(join(root, "worktree file"), "unstaged\n");
  const hook = join(root, ".git", "hooks", "pre-commit");
  await writeFile(hook, "#!/bin/sh\nexit 1\n");
  await chmod(hook, 0o755);

  await assert.rejects(
    commitWithPathChangeReport(root, ["commit", "-m", "must fail"]),
    (error) => {
      assert.deepEqual(error.path_changes, [
        { record_type: "1", index_status: "A", worktree_status: ".", path: "staged name\nfile" },
        { record_type: "?", index_status: ".", worktree_status: ".", path: "worktree file" },
      ]);
      return true;
    },
  );
});
