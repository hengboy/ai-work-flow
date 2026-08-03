#!/usr/bin/env node
import process from "node:process";

import { prepareDirectoryReviewManifest, verifyDirectoryReviewManifest } from "./lib/directory-review-manifest.mjs";

async function stdinJson() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) throw new Error("Expected JSON on stdin");
  return JSON.parse(raw);
}

function parseArgs(argv) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) return { help: true };
  const [command, flag, repository, ...rest] = argv;
  if (!["prepare", "verify"].includes(command) || flag !== "--repository" || !repository || rest.length > 0) {
    throw new Error("Usage: review-manifest-cli.mjs <prepare|verify> --repository <review-worktree>");
  }
  return { command, repository };
}

function assertVerifyInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.fixed_point !== "string" || typeof input.review_commit !== "string") {
    throw new Error("verify requires external fixed_point and review_commit inputs");
  }
}

try {
  const { command, repository, help } = parseArgs(process.argv.slice(2));
  if (help) {
    process.stdout.write("Usage: review-manifest-cli.mjs <prepare|verify> --repository <review-worktree>\n");
    process.exit(0);
  }
  const input = await stdinJson();
  if (command === "verify") assertVerifyInput(input);
  const manifest = command === "prepare"
    ? await prepareDirectoryReviewManifest(repository, input)
    : await verifyDirectoryReviewManifest(repository, input.manifest, input);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`review-manifest: ${error.message}\n`);
  process.exitCode = 1;
}
