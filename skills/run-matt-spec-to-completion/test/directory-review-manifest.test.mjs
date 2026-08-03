import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import { assertDirectoryReviewPrepareEnvelope, prepareDirectoryReviewEnvelope, prepareDirectoryReviewManifest, verifyDirectoryReviewEnvelope, verifyDirectoryReviewManifest } from "../../../execution-runtime/lib/directory-review-manifest.mjs";
import { assertReviewManifest, createReviewManifest, createReviewShardAssignments, reviewBundleDigest, reviewManifestDigest } from "../../../execution-runtime/lib/review-manifest.mjs";

const run = promisify(execFile);
const cli = resolve(import.meta.dirname, "..", "..", "..", "execution-runtime", "review-manifest-cli.mjs");

async function git(cwd, ...args) {
  return (await run("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

async function fixture({ validPlan = true, copy = false, objectFormat, mode = "single", specStatus = "present" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "directory-review-manifest-"));
  const initArgs = ["init", "-b", "main"];
  if (objectFormat) initArgs.push(`--object-format=${objectFormat}`);
  await git(root, ...initArgs);
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test User");
  const planDirectory = join(root, ".ai-work-flow", "plans", "example");
  const specPath = ".ai-work-flow/plans/example/spec.md";
  const planPath = ".ai-work-flow/plans/example/plan.md";
  const taskPath = ".ai-work-flow/plans/example/tasks/01-review.md";
  const spec = "# Example\n\n- status: `approved`\n";
  const specDigest = createHash("sha256").update(spec).digest("hex");
  const plan = [
    "# Plan",
    "",
    `- source_spec: \`${specPath}\``,
    `- source_spec_digest: \`${validPlan ? specDigest : "0".repeat(64)}\``,
    `- task_mode: \`${mode === "single" ? "single" : "split"}\``,
    "",
  ].join("\n");
  const planDigest = createHash("sha256").update(plan).digest("hex");
  await writeFile(join(root, "CONTEXT.md"), "# Standards\n");
  if (specStatus === "present") {
    await mkdir(planDirectory, { recursive: true });
    await writeFile(join(root, specPath), spec);
    await writeFile(join(root, planPath), plan);
    if (mode === "task") {
      await mkdir(join(root, ".ai-work-flow", "plans", "example", "tasks"), { recursive: true });
      await writeFile(join(root, taskPath), [
        "# 01 - Review",
        "",
        "- source_plan: `../plan.md`",
        `- source_plan_digest: \`${planDigest}\``,
        "",
      ].join("\n"));
    }
  }
  await writeFile(join(root, "old-name.txt"), "review me\n");
  if (copy) await writeFile(join(root, "copy-source.txt"), "copy me\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "planning baseline");
  const fixedPoint = await git(root, "rev-parse", "HEAD");
  await rename(join(root, "old-name.txt"), join(root, "new-name.txt"));
  await git(root, "add", "-A");
  await git(root, "commit", "-m", "rename reviewed file");
  if (copy) {
    await writeFile(join(root, "copied-name.txt"), "copy me\n");
    await git(root, "add", "copied-name.txt");
    await git(root, "commit", "-m", "copy reviewed file");
  }
  const reviewCommit = await git(root, "rev-parse", "HEAD");
  return {
    root,
    input: {
      fixed_point: fixedPoint,
      review_commit: reviewCommit,
      spec_status: specStatus,
      ...(specStatus === "present" ? {
        mode,
        spec_path: specPath,
        plan_path: planPath,
        ...(mode === "task" ? { task_path: taskPath } : {}),
      } : {}),
      checks: ["node --test"],
      acceptance_evidence: [{ criterion: "rename", evidence: "new-name.txt exists" }],
      verification: [{ command: "node --test", result: "passed" }],
    },
    sourceFacts: { specDigest, planDigest, specPath, planPath, taskPath },
  };
}

test("prepares and verifies a single spec bundle from committed Git facts", async () => {
  const { root, input } = await fixture();
  const manifest = await prepareDirectoryReviewManifest(root, input);

  assert.equal(manifest.spec_source.path, input.spec_path);
  assert.equal(manifest.spec_source.revision, input.review_commit);
  assert.equal(manifest.standards_source[0].revision, input.review_commit);
  assert.deepEqual(manifest.changed_paths, [{
    record_type: "2",
    index_status: "R",
    worktree_status: ".",
    path: "new-name.txt",
    source_path: "old-name.txt",
  }]);
  assert.deepEqual(manifest.shards.map((shard) => shard.paths), [["new-name.txt"]]);
  assert.equal(manifest.directory_bundle.sources[0].digest, manifest.spec_source.digest);
  assert.equal(Object.isFrozen(manifest), true);
  const verified = await verifyDirectoryReviewManifest(root, manifest, {
    ...input,
    acceptance_evidence: [{ evidence: "new-name.txt exists", criterion: "rename" }],
  });
  assert.deepEqual(verified, manifest);
  assert.equal(Object.isFrozen(verified), true);
});

test("prepares and verifies a task spec bundle with committed plan path, revision, and digest binding", async () => {
  const { root, input, sourceFacts } = await fixture({ mode: "task" });
  const manifest = await prepareDirectoryReviewManifest(root, input);
  const [specSource, planSource, taskSource] = manifest.directory_bundle.sources;

  assert.deepEqual(manifest.directory_bundle.sources.map((source) => source.role), ["spec", "plan", "task"]);
  assert.deepEqual(planSource, {
    role: "plan",
    path: sourceFacts.planPath,
    revision: input.review_commit,
    digest: sourceFacts.planDigest,
  });
  assert.equal(specSource.revision, input.review_commit);
  assert.equal(taskSource.path, sourceFacts.taskPath);
  assert.equal(taskSource.revision, input.review_commit);
  await verifyDirectoryReviewManifest(root, manifest, input);
});

test("prepares and verifies an aggregate spec bundle bound to committed spec and plan sources", async () => {
  const { root, input, sourceFacts } = await fixture({ mode: "aggregate" });
  const manifest = await prepareDirectoryReviewManifest(root, input);

  assert.equal(manifest.directory_bundle.mode, "aggregate");
  assert.deepEqual(manifest.directory_bundle.sources, [
    { role: "spec", path: sourceFacts.specPath, revision: input.review_commit, digest: sourceFacts.specDigest },
    { role: "plan", path: sourceFacts.planPath, revision: input.review_commit, digest: sourceFacts.planDigest },
  ]);
  assert.deepEqual(manifest.spec_source, manifest.directory_bundle.sources[0]);
  await verifyDirectoryReviewManifest(root, manifest, input);
});

test("prepares and verifies an explicit absent spec bundle without planning paths", async () => {
  const { root, input } = await fixture({ specStatus: "absent" });
  for (const field of ["spec_path", "plan_path", "task_path"]) assert.equal(Object.hasOwn(input, field), false, field);

  const manifest = await prepareDirectoryReviewManifest(root, input);

  assert.equal(manifest.spec_status, "absent");
  assert.equal(manifest.spec_source, null);
  assert.equal(manifest.directory_bundle.mode, "absent");
  assert.deepEqual(manifest.directory_bundle.sources, []);
  assert.equal(manifest.directory_bundle.bundle_digest, reviewBundleDigest(manifest.directory_bundle));
  assert.deepEqual(createReviewShardAssignments(manifest), {
    standards: {
      manifest,
      manifest_digest: manifest.manifest_digest,
      shard_ids: manifest.shards.map((shard) => shard.id),
    },
  });

  const verified = await verifyDirectoryReviewManifest(root, manifest, {
    ...input,
    acceptance_evidence: [{ evidence: "new-name.txt exists", criterion: "rename" }],
  });
  assert.deepEqual(verified, manifest);

  for (const field of ["spec_path", "plan_path", "task_path"]) {
    await assert.rejects(
      prepareDirectoryReviewManifest(root, { ...input, [field]: "not-allowed.md" }),
      /spec_status absent must not include/,
      field,
    );
  }
});

test("builds a structured prepare envelope without changing the manifest digest algorithm", async () => {
  const { root, input } = await fixture();
  const envelope = await prepareDirectoryReviewEnvelope(root, input);

  assert.deepEqual(envelope.verify_input, input);
  assert.equal(envelope.review_manifest.manifest_digest, envelope.manifest_digest);
  assert.equal(envelope.review_manifest.directory_bundle.bundle_digest, envelope.bundle_digest);
  assert.doesNotThrow(() => assertDirectoryReviewPrepareEnvelope(envelope));
  assert.deepEqual(await verifyDirectoryReviewEnvelope(root, envelope), envelope.review_manifest);

  const tampered = structuredClone(envelope);
  tampered.verify_input.checks = ["tampered check"];
  assert.throws(() => assertDirectoryReviewPrepareEnvelope(tampered), /prepare envelope/);
});

test("detects a copy from an unchanged committed source", async () => {
  const { root, input } = await fixture({ copy: true });
  const manifest = await prepareDirectoryReviewManifest(root, input);
  const copied = manifest.changed_paths.find((change) => change.index_status === "C");

  assert.deepEqual(copied, {
    record_type: "2",
    index_status: "C",
    worktree_status: ".",
    path: "copied-name.txt",
    source_path: "copy-source.txt",
  });
  await verifyDirectoryReviewManifest(root, manifest, input);
});

test("accepts SHA-256 repositories with 64-character object IDs", async () => {
  const { root, input } = await fixture({ objectFormat: "sha256" });
  assert.match(input.fixed_point, /^[0-9a-f]{64}$/);
  assert.match(input.review_commit, /^[0-9a-f]{64}$/);

  const manifest = await prepareDirectoryReviewManifest(root, input);
  await verifyDirectoryReviewManifest(root, manifest, input);
});

test("fails closed on digest, revision, shard, source binding, and bundle fact mismatches", async () => {
  const { root, input } = await fixture();
  const manifest = await prepareDirectoryReviewManifest(root, input);

  assert.throws(() => assertReviewManifest({ ...manifest, manifest_digest: "0".repeat(64) }), /digest/);
  assert.throws(() => createReviewManifest({
    ...structuredClone(manifest),
    shards: [],
  }), /cover every changed path/);
  assert.throws(() => createReviewManifest({
    ...structuredClone(manifest),
    spec_source: { ...manifest.spec_source, revision: input.fixed_point },
    directory_bundle: {
      ...manifest.directory_bundle,
      sources: manifest.directory_bundle.sources.map((source, index) => index === 0 ? { ...source, revision: input.fixed_point } : source),
    },
  }), /review commit/);
  await assert.rejects(
    verifyDirectoryReviewManifest(root, manifest, { ...input, acceptance_evidence: [{ criterion: "rename", evidence: "tampered" }] }),
    /bundle facts/,
  );

  const invalid = await fixture({ validPlan: false });
  await assert.rejects(prepareDirectoryReviewManifest(invalid.root, invalid.input), /source_spec binding/);
});

test("rejects missing or malformed acceptance evidence, verification, and checks", async () => {
  const { root, input } = await fixture();
  const manifest = await prepareDirectoryReviewManifest(root, input);
  const { checks: _checks, ...withoutChecks } = input;
  const cases = [
    ["missing checks", withoutChecks, /checks/],
    ["empty checks", { ...input, checks: [] }, /checks/],
    ["null check", { ...input, checks: [null] }, /checks/],
    ["empty string check", { ...input, checks: ["  "] }, /checks/],
    ["empty object check", { ...input, checks: [{}] }, /checks/],
    ["null evidence", { ...input, acceptance_evidence: [null] }, /acceptance_evidence/],
    ["empty string evidence", { ...input, acceptance_evidence: [""] }, /acceptance_evidence/],
    ["empty object evidence", { ...input, acceptance_evidence: [{}] }, /acceptance_evidence/],
    ["empty evidence field", { ...input, acceptance_evidence: [{ criterion: "rename", evidence: " " }] }, /acceptance_evidence/],
    ["null verification", { ...input, verification: [null] }, /verification/],
    ["empty string verification", { ...input, verification: [""] }, /verification/],
    ["empty object verification", { ...input, verification: [{}] }, /verification/],
    ["empty verification field", { ...input, verification: [{ command: "node --test", result: "" }] }, /verification/],
  ];

  for (const [name, candidate, pattern] of cases) {
    await assert.rejects(prepareDirectoryReviewManifest(root, candidate), pattern, name);
  }
  await assert.rejects(verifyDirectoryReviewManifest(root, manifest, withoutChecks), /checks/);
});

test("rebuilds all directory facts and rejects rehashed standards, checks, bundle, and shard tampering", async () => {
  const { root, input } = await fixture();
  const manifest = await prepareDirectoryReviewManifest(root, input);
  const tampered = [];

  const standards = structuredClone(manifest);
  standards.standards_source = [{ path: "README.md", revision: input.review_commit }];
  tampered.push(createReviewManifest(standards));

  const checks = structuredClone(manifest);
  checks.checks = [...checks.checks, "tampered check"];
  tampered.push(createReviewManifest(checks));

  const bundle = structuredClone(manifest);
  bundle.directory_bundle.acceptance_evidence_digest = "0".repeat(64);
  bundle.directory_bundle.bundle_digest = reviewBundleDigest(bundle.directory_bundle);
  tampered.push(createReviewManifest(bundle));

  const shard = structuredClone(manifest);
  shard.shards[0].id = "shard-tampered";
  tampered.push(createReviewManifest(shard));

  const shardCommand = structuredClone(manifest);
  shardCommand.shards[0].diff_command = [...shardCommand.shards[0].diff_command, "--tampered"];
  shardCommand.manifest_digest = reviewManifestDigest(shardCommand);
  tampered.push(shardCommand);

  for (const candidate of tampered) {
    await assert.rejects(
      verifyDirectoryReviewManifest(root, candidate, input),
      /deterministic review facts|shard command/,
    );
  }
});

test("binds verification to the external range and fails closed on HEAD drift or a dirty worktree", async () => {
  const mismatched = await fixture();
  const mismatchedManifest = await prepareDirectoryReviewManifest(mismatched.root, mismatched.input);
  await assert.rejects(
    verifyDirectoryReviewManifest(mismatched.root, mismatchedManifest, {
      ...mismatched.input,
      fixed_point: mismatched.input.review_commit,
    }),
    /externally supplied review endpoints/,
  );

  const drifted = await fixture();
  const driftedManifest = await prepareDirectoryReviewManifest(drifted.root, drifted.input);
  await writeFile(join(drifted.root, "head-drift.txt"), "drift\n");
  await git(drifted.root, "add", "head-drift.txt");
  await git(drifted.root, "commit", "-m", "head drift");
  await assert.rejects(
    verifyDirectoryReviewManifest(drifted.root, driftedManifest, drifted.input),
    /HEAD must equal review_commit/,
  );

  const dirty = await fixture();
  const dirtyManifest = await prepareDirectoryReviewManifest(dirty.root, dirty.input);
  await writeFile(join(dirty.root, "uncommitted.txt"), "dirty\n");
  await assert.rejects(
    verifyDirectoryReviewManifest(dirty.root, dirtyManifest, dirty.input),
    /worktree must be clean/,
  );
});

test("exposes an executable prepare and verify CLI for ordinary Coding", async () => {
  const { root, input } = await fixture();
  const prepared = spawnSync(process.execPath, [cli, "prepare", "--repository", root], {
    input: JSON.stringify(input), encoding: "utf8",
  });
  assert.equal(prepared.status, 0, prepared.stderr);
  const envelope = JSON.parse(prepared.stdout);
  assert.equal(envelope.type, "directory-review-prepare");
  assert.deepEqual(envelope.verify_input, input);
  assert.equal(envelope.review_manifest.manifest_digest, envelope.manifest_digest);
  assert.equal(envelope.review_manifest.directory_bundle.bundle_digest, envelope.bundle_digest);

  const verified = spawnSync(process.execPath, [cli, "verify", "--repository", root], {
    input: prepared.stdout, encoding: "utf8",
  });
  assert.equal(verified.status, 0, verified.stderr);
  assert.deepEqual(JSON.parse(verified.stdout), envelope.review_manifest);

  const tamperedVerifyInput = structuredClone(envelope);
  tamperedVerifyInput.verify_input.acceptance_evidence[0].evidence = "changed";
  const rejected = spawnSync(process.execPath, [cli, "verify", "--repository", root], {
    input: JSON.stringify(tamperedVerifyInput), encoding: "utf8",
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /prepare envelope/);

  const missingEnvelope = spawnSync(process.execPath, [cli, "verify", "--repository", root], {
    input: JSON.stringify(envelope.review_manifest), encoding: "utf8",
  });
  assert.notEqual(missingEnvelope.status, 0);
  assert.match(missingEnvelope.stderr, /prepare envelope/);
});

test("exposes an executable absent prepare and endpoint-bound verify CLI", async () => {
  const { root, input } = await fixture({ specStatus: "absent" });
  const prepared = spawnSync(process.execPath, [cli, "prepare", "--repository", root], {
    input: JSON.stringify(input), encoding: "utf8",
  });
  assert.equal(prepared.status, 0, prepared.stderr);
  const envelope = JSON.parse(prepared.stdout);
  assert.equal(envelope.review_manifest.spec_status, "absent");
  assert.deepEqual(envelope.review_manifest.directory_bundle.sources, []);

  const verified = spawnSync(process.execPath, [cli, "verify", "--repository", root], {
    input: prepared.stdout, encoding: "utf8",
  });
  assert.equal(verified.status, 0, verified.stderr);

  const driftedEnvelope = structuredClone(envelope);
  driftedEnvelope.verify_input.fixed_point = input.review_commit;
  const driftedEndpoints = spawnSync(process.execPath, [cli, "verify", "--repository", root], {
    input: JSON.stringify(driftedEnvelope), encoding: "utf8",
  });
  assert.notEqual(driftedEndpoints.status, 0);
  assert.match(driftedEndpoints.stderr, /prepare envelope endpoints/);

  const rejectedPaths = spawnSync(process.execPath, [cli, "prepare", "--repository", root], {
    input: JSON.stringify({ ...input, spec_path: "not-allowed.md" }), encoding: "utf8",
  });
  assert.notEqual(rejectedPaths.status, 0);
  assert.match(rejectedPaths.stderr, /spec_status absent must not include spec_path/);
});
