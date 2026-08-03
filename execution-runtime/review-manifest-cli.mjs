#!/usr/bin/env node
import process from "node:process";

import { prepareDirectoryReviewEnvelope, verifyDirectoryReviewEnvelope } from "./lib/directory-review-manifest.mjs";

async function stdinJson() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) throw new Error("Expected JSON on stdin");
  return JSON.parse(raw);
}

function parseArgs(argv) {
  const [command, flag, repository, ...rest] = argv;
  if (!["prepare", "verify"].includes(command) || flag !== "--repository" || !repository || rest.length > 0) {
    throw new Error("Usage: review-manifest-cli.mjs <prepare|verify> --repository <review-worktree>");
  }
  return { command, repository };
}

function assertVerifyInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("verify requires a directory review prepare envelope");
  }
}

function assertPrepareInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("prepare requires a JSON object");
  if (input.spec_status === "absent") {
    const forbidden = ["spec_path", "plan_path", "task_path"].filter((field) => Object.hasOwn(input, field));
    if (forbidden.length > 0) throw new Error(`prepare spec_status absent must not include ${forbidden.join(", ")}`);
  }
}

try {
  const { command, repository } = parseArgs(process.argv.slice(2));
  const input = await stdinJson();
  if (command === "verify") assertVerifyInput(input);
  else assertPrepareInput(input);
  const result = command === "prepare"
    ? await prepareDirectoryReviewEnvelope(repository, input)
    : await verifyDirectoryReviewEnvelope(repository, input);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`review-manifest: ${error.message}\n`);
  process.exitCode = 1;
}
