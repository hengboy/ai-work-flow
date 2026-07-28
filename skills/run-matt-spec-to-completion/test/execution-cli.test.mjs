import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const cli = new URL("../../../execution-runtime/execution-cli.mjs", import.meta.url);
const CLAIM = { role_id: "full-stack-coder", session_id: "fixture-session" };

async function git(cwd, ...args) {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "execution-cli-"));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test User");
  const directory = join(root, ".scratch", "cli-flow");
  await mkdir(join(directory, "issues"), { recursive: true });
  await writeFile(join(directory, "spec.md"), "# CLI flow\n");
  await writeFile(join(directory, "issues", "01-work.md"), "# 01 - Work\n\n**Blocked by:** None - can start immediately\n");
  await writeFile(join(root, ".gitignore"), ".worktrees/\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "fixture");
  const baseline = await git(root, "rev-parse", "HEAD");
  return { root, spec: ".scratch/cli-flow/spec.md", worktree: join(root, ".worktrees", "execution"), baseline };
}

async function invoke(paths, command, args = [], input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli.pathname, command, "--repository", paths.root, ...args], { cwd: paths.root });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `exit ${code}`));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
    child.stdin.end(input);
  });
}

async function claim(paths) {
  return invoke(paths, "claim", ["--feature", "cli-flow", "--worktree", paths.worktree, "--role-id", CLAIM.role_id, "--session-id", CLAIM.session_id]);
}

function reviewInput(paths, review, findingsSummary) {
  const manifest = review.checkpoint.review.manifest;
  return {
    manifest_digest: manifest.manifest_digest,
    coverage: { manifest_digest: manifest.manifest_digest, completed_shard_ids: manifest.shards.map((shard) => shard.id), incomplete_shard_ids: [] },
    findings_summary: findingsSummary,
  };
}

async function beginReview(paths) {
  return invoke(paths, "begin-review", ["--feature", "cli-flow", "--worktree", paths.worktree], JSON.stringify({
    spec_status: "present",
    spec_source: { path: paths.spec, revision: "a".repeat(64) },
    standards_source: [],
  }));
}

function handoff(claimed, payload, artifacts = []) {
  return {
    role_id: claimed.ticket.expected_role_id,
    session_id: claimed.ticket.session_id,
    claim_id: claimed.ticket.claim_id,
    status: payload.status,
    summary: payload.summary,
    artifacts,
    checks: payload.checks,
    ...(payload.status === "blocked" ? { error: payload.error } : {}),
    payload,
  };
}

test("execution CLI claims once and records only a JSON Handoff envelope", async () => {
  const paths = await fixture();
  await invoke(paths, "prepare", ["--branch", "feat/cli-flow", "--spec", paths.spec, "--worktree", paths.worktree]);
  const claims = await Promise.allSettled(Array.from({ length: 4 }, () => claim(paths)));
  assert.equal(claims.filter((claim) => claim.status === "fulfilled").length, 1);
  const claimed = claims.find((claim) => claim.status === "fulfilled").value;
  const blocked = handoff(claimed, { ticket_id: "01", status: "blocked", commits: [], checks: [], changed_paths: [], summary: "cannot continue", error: "fixture" });
  const recorded = await invoke(paths, "record-ticket", ["--feature", "cli-flow", "--worktree", paths.worktree], JSON.stringify(blocked));
  assert.equal(recorded.status, "blocked");
  await assert.rejects(
    invoke(paths, "record-ticket", ["--feature", "cli-flow", "--worktree", paths.worktree], JSON.stringify(blocked.payload)),
    /Handoff Result violates schema/,
  );
});

test("record-ticket rejects identity and envelope conflicts without advancing the frontier or accepting replay", async () => {
  const paths = await fixture();
  await invoke(paths, "prepare", ["--branch", "feat/cli-flow", "--spec", paths.spec, "--worktree", paths.worktree]);
  const claimed = await claim(paths);
  const checkpointPath = join(paths.root, ".scratch", "cli-flow", "checkpoint.json");
  const payload = { ticket_id: "01", status: "blocked", commits: [], checks: ["node --test"], changed_paths: [], summary: "blocked", error: "fixture" };
  const valid = handoff(claimed, payload);

  for (const invalid of [
    { ...valid, role_id: "git-committer" },
    { ...valid, session_id: "other-session" },
    { ...valid, claim_id: "other-claim" },
    { ...valid, summary: "rewritten" },
    { ...valid, checks: [] },
    { ...valid, error: "rewritten" },
  ]) {
    const before = await readFile(checkpointPath, "utf8");
    await assert.rejects(
      invoke(paths, "record-ticket", ["--feature", "cli-flow", "--worktree", paths.worktree], JSON.stringify(invalid)),
      /claim identity|must match/,
    );
    assert.equal(await readFile(checkpointPath, "utf8"), before);
  }

  await invoke(paths, "record-ticket", ["--feature", "cli-flow", "--worktree", paths.worktree], JSON.stringify(valid));
  const completed = await readFile(checkpointPath, "utf8");
  await assert.rejects(
    invoke(paths, "record-ticket", ["--feature", "cli-flow", "--worktree", paths.worktree], JSON.stringify(valid)),
    /is not claimed/,
  );
  assert.equal(await readFile(checkpointPath, "utf8"), completed);
});

test("execution CLI recovers a stale lock but preserves a live lock", async () => {
  const paths = await fixture();
  await invoke(paths, "prepare", ["--branch", "feat/cli-flow", "--spec", paths.spec, "--worktree", paths.worktree]);
  const lock = join(paths.root, ".scratch", "cli-flow", "checkpoint.json.runtime.lock");
  await writeFile(lock, JSON.stringify({ pid: 99999999 }));
  assert.equal((await claim(paths)).ticket.id, "01");
  await writeFile(lock, JSON.stringify({ pid: process.pid }));
  await assert.rejects(invoke(paths, "record-review", ["--feature", "cli-flow"], JSON.stringify({ findings_summary: "blocked by lock" })), /runtime mutation is already in progress/);
});

test("execution CLI rejects an absolute legacy worktree without rewriting it", async () => {
  const paths = await fixture();
  await invoke(paths, "prepare", ["--branch", "feat/cli-flow", "--spec", paths.spec, "--worktree", paths.worktree]);
  const path = join(paths.root, ".scratch", "cli-flow", "checkpoint.json");
  const checkpoint = JSON.parse(await readFile(path, "utf8"));
  checkpoint.worktree = paths.worktree;
  await writeFile(path, `${JSON.stringify(checkpoint)}\n`);
  await assert.rejects(invoke(paths, "status", ["--feature", "cli-flow", "--worktree", paths.worktree]), /Checkpoint violates schema|repository-relative path/);
  assert.equal(JSON.parse(await readFile(path, "utf8")).worktree, paths.worktree);
});

test("execution CLI completes review and integration through the same feature lock", async () => {
  const paths = await fixture();
  await invoke(paths, "prepare", ["--branch", "feat/cli-flow", "--spec", paths.spec, "--worktree", paths.worktree]);
  const claimed = await claim(paths);
  await writeFile(join(paths.worktree, "completed.txt"), "done\n");
  await git(paths.worktree, "add", "completed.txt");
  await git(paths.worktree, "commit", "-m", "complete ticket");
  const commit = await git(paths.worktree, "rev-parse", "HEAD");
  const completion = handoff(claimed, { ticket_id: "01", status: "done", commits: [commit], checks: [], changed_paths: [], summary: "completed" }, ["completed.txt"]);
  await invoke(paths, "record-ticket", ["--feature", "cli-flow", "--worktree", paths.worktree], JSON.stringify(completion));
  await assert.rejects(
    invoke(paths, "record-review", ["--feature", "cli-flow"], JSON.stringify({ findings_summary: "range was not frozen" })),
    /Review is not in progress/,
  );
  const review = await beginReview(paths);
  assert.equal(review.checkpoint.review.fixed_point, paths.baseline);
  assert.equal(review.checkpoint.review.review_commit, commit);
  assert.equal(review.manifest.fixed_point, paths.baseline);
  assert.equal(review.manifest.review_commit, commit);
  await invoke(paths, "record-review", ["--feature", "cli-flow"], JSON.stringify(reviewInput(paths, review, "approved")));
  await invoke(paths, "review-decision", ["--feature", "cli-flow"], JSON.stringify({ decision: "approve" }));
  const integrated = await invoke(paths, "integrate", ["--feature", "cli-flow", "--worktree", paths.worktree]);
  assert.equal(integrated.status, "complete");
  const cleaned = await invoke(paths, "cleanup", ["--feature", "cli-flow"]);
  assert.equal(cleaned.status, "complete");
  const checkpointPath = join(paths.root, ".scratch", "cli-flow", "checkpoint.json");
  const tampered = JSON.parse(await readFile(checkpointPath, "utf8"));
  tampered.integration.execution_head = paths.baseline;
  await writeFile(checkpointPath, `${JSON.stringify(tampered)}\n`);
  await assert.rejects(invoke(paths, "status", ["--feature", "cli-flow"]), /review-gate-head/);
});

test("begin-review rejects uncommitted worktree changes", async () => {
  const paths = await fixture();
  await invoke(paths, "prepare", ["--branch", "feat/cli-flow", "--spec", paths.spec, "--worktree", paths.worktree]);
  const claimed = await claim(paths);
  await writeFile(join(paths.worktree, "completed.txt"), "done\n");
  await git(paths.worktree, "add", "completed.txt");
  await git(paths.worktree, "commit", "-m", "complete ticket");
  const commit = await git(paths.worktree, "rev-parse", "HEAD");
  await invoke(paths, "record-ticket", ["--feature", "cli-flow", "--worktree", paths.worktree], JSON.stringify(handoff(claimed, { ticket_id: "01", status: "done", commits: [commit], checks: [], changed_paths: [], summary: "completed" }, ["completed.txt"])));
  await writeFile(join(paths.worktree, "uncommitted.txt"), "must not be reviewed\n");

  await assert.rejects(
    beginReview(paths),
    /Execution worktree must be clean before review/,
  );
});

test("integration rejects commits added after an approved review", async () => {
  const paths = await fixture();
  await invoke(paths, "prepare", ["--branch", "feat/cli-flow", "--spec", paths.spec, "--worktree", paths.worktree]);
  const claimed = await claim(paths);
  await writeFile(join(paths.worktree, "completed.txt"), "done\n");
  await git(paths.worktree, "add", "completed.txt");
  await git(paths.worktree, "commit", "-m", "complete ticket");
  const commit = await git(paths.worktree, "rev-parse", "HEAD");
  await invoke(paths, "record-ticket", ["--feature", "cli-flow", "--worktree", paths.worktree], JSON.stringify(handoff(claimed, { ticket_id: "01", status: "done", commits: [commit], checks: [], changed_paths: [], summary: "completed" }, ["completed.txt"])));
  const review = await beginReview(paths);
  await invoke(paths, "record-review", ["--feature", "cli-flow"], JSON.stringify(reviewInput(paths, review, "approved")));
  await invoke(paths, "review-decision", ["--feature", "cli-flow"], JSON.stringify({ decision: "approve" }));
  await writeFile(join(paths.worktree, "after-review.txt"), "must not be integrated\n");
  await git(paths.worktree, "add", "after-review.txt");
  await git(paths.worktree, "commit", "-m", "unreviewed change");

  await assert.rejects(
    invoke(paths, "integrate", ["--feature", "cli-flow", "--worktree", paths.worktree]),
    /review-gate-head/,
  );
});

test("review fixes advance directly to integration without another review", async () => {
  const paths = await fixture();
  await invoke(paths, "prepare", ["--branch", "feat/cli-flow", "--spec", paths.spec, "--worktree", paths.worktree]);
  const claimed = await claim(paths);
  await writeFile(join(paths.worktree, "fixed.txt"), "fixed\n");
  await git(paths.worktree, "add", "fixed.txt");
  await git(paths.worktree, "commit", "-m", "complete ticket");
  const commit = await git(paths.worktree, "rev-parse", "HEAD");
  await invoke(paths, "record-ticket", ["--feature", "cli-flow", "--worktree", paths.worktree], JSON.stringify(handoff(claimed, { ticket_id: "01", status: "done", commits: [commit], checks: [], changed_paths: [], summary: "completed" })));
  const started = await beginReview(paths);
  await assert.rejects(
    beginReview(paths),
    /Review can only begin from a pending execution review/,
  );
  const stillFrozen = await invoke(paths, "status", ["--feature", "cli-flow", "--worktree", paths.worktree]);
  assert.equal(stillFrozen.checkpoint.review.fixed_point, started.checkpoint.review.fixed_point);
  assert.equal(stillFrozen.checkpoint.review.review_commit, started.checkpoint.review.review_commit);
  await invoke(paths, "record-review", ["--feature", "cli-flow"], JSON.stringify(reviewInput(paths, started, "requires a fix")));
  assert.equal((await invoke(paths, "review-decision", ["--feature", "cli-flow"], JSON.stringify({ decision: "fix" }))).status, "fixing");
  await assert.rejects(
    beginReview(paths),
    /Review can only begin from a pending execution review/,
  );
  await assert.rejects(
    invoke(paths, "complete-review-fix", ["--feature", "cli-flow"], JSON.stringify({ checks: ["npm test: pass"] })),
    /--worktree is required/,
  );
  await assert.rejects(
    invoke(paths, "complete-review-fix", ["--feature", "cli-flow", "--worktree", paths.worktree], JSON.stringify({ checks: ["npm test: pass"] })),
    /Review fix commit must be after the reviewed commit/,
  );
  await writeFile(join(paths.worktree, "review-fix.txt"), "review fix\n");
  await git(paths.worktree, "add", "review-fix.txt");
  await git(paths.worktree, "commit", "-m", "apply review fix");
  const fixCommit = await git(paths.worktree, "rev-parse", "HEAD");
  await assert.rejects(
    invoke(paths, "complete-review-fix", ["--feature", "cli-flow", "--worktree", paths.worktree], JSON.stringify({ checks: [] })),
    /At least one review fix check is required/,
  );
  const completed = await invoke(paths, "complete-review-fix", ["--feature", "cli-flow", "--worktree", paths.worktree], JSON.stringify({ checks: ["npm test: pass"] }));
  assert.equal(completed.status, "integrating");
  assert.equal(completed.checkpoint.review.fix_commit, fixCommit);
  assert.deepEqual(completed.checkpoint.review.fix_checks, ["npm test: pass"]);
  await assert.rejects(
    beginReview(paths),
    /Review can only begin from a pending execution review/,
  );
  await assert.rejects(invoke(paths, "record-review", ["--feature", "cli-flow"], JSON.stringify(reviewInput(paths, started, "automatic re-review"))), /Review is not in progress/);
  const integrated = await invoke(paths, "integrate", ["--feature", "cli-flow", "--worktree", paths.worktree]);
  assert.equal(integrated.status, "complete");
  const cleaned = await invoke(paths, "cleanup", ["--feature", "cli-flow"]);
  assert.equal(cleaned.status, "complete");
});

test("prepare rejects a symbolic-link worktree parent before creating a worktree", async () => {
  const paths = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "execution-cli-outside-"));
  const linked = join(paths.root, "linked-worktrees");
  await symlink(outside, linked);
  await assert.rejects(
    invoke(paths, "prepare", ["--branch", "feat/cli-flow", "--spec", paths.spec, "--worktree", join(linked, "execution")]),
    /symbolic-link parent/,
  );
  assert.equal((await git(paths.root, "worktree", "list", "--porcelain")).split("\n").filter((line) => line.startsWith("worktree ")).length, 1);
});

test("prepare rejects dangling symbolic links and pre-existing worktree targets", async () => {
  const paths = await fixture();
  const dangling = join(paths.root, "dangling-worktrees");
  await symlink(join(paths.root, "missing-target"), dangling);
  await assert.rejects(
    invoke(paths, "prepare", ["--branch", "feat/cli-flow", "--spec", paths.spec, "--worktree", join(dangling, "execution")]),
    /symbolic-link parent/,
  );
  await mkdir(paths.worktree, { recursive: true });
  await assert.rejects(
    invoke(paths, "prepare", ["--branch", "feat/cli-flow", "--spec", paths.spec, "--worktree", paths.worktree]),
    /Worktree path already exists/,
  );
});

test("prepare rejects an external worktree even when its branch name matches", async () => {
  const paths = await fixture();
  const external = await mkdtemp(join(tmpdir(), "execution-cli-external-"));
  await git(external, "init", "-b", "feat/cli-flow");
  await git(external, "config", "user.email", "test@example.com");
  await git(external, "config", "user.name", "Test User");
  await writeFile(join(external, "README.md"), "external\n");
  await git(external, "add", ".");
  await git(external, "commit", "-m", "external fixture");
  await assert.rejects(
    invoke(paths, "prepare", ["--branch", "feat/cli-flow", "--spec", paths.spec, "--worktree", external]),
    /must be inside the repository/,
  );
});

test("concurrent prepare calls share one feature lock", async () => {
  const paths = await fixture();
  const results = await Promise.allSettled(Array.from({ length: 2 }, () => invoke(paths, "prepare", ["--branch", "feat/cli-flow", "--spec", paths.spec, "--worktree", paths.worktree])));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.match(results.find((result) => result.status === "rejected").reason.message, /runtime mutation is already in progress/);
  assert.equal((await git(paths.root, "worktree", "list", "--porcelain")).split("\n").filter((line) => line.startsWith("worktree ")).length, 2);
});

test("only the runtime state store imports the checkpoint writer", async () => {
  const [orchestrator, lifecycle, stateStore] = await Promise.all([
    readFile(new URL("../lib/execution-orchestrator.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/integration-lifecycle.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../../execution-runtime/state-store.mjs", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(orchestrator, /writeCheckpoint|checkpointWriter/);
  assert.doesNotMatch(lifecycle, /writeCheckpoint/);
  assert.match(stateStore, /writeCheckpoint/);
});
