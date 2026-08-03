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
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) return { help: true };
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
    const forbidden = ["mode", "spec_path", "plan_path", "task_path"].filter((field) => Object.hasOwn(input, field));
    if (forbidden.length > 0) throw new Error(`prepare spec_status absent must not include ${forbidden.join(", ")}`);
  }
}

try {
  const { command, repository, help } = parseArgs(process.argv.slice(2));
  if (help) {
    process.stdout.write([
      "Usage: review-manifest-cli.mjs <prepare|verify> --repository <review-worktree>",
      "prepare stdin: fixed_point, review_commit, checks, acceptance_evidence, verification",
      "present bundle: spec_status=present (or omitted), spec_path, plan_path, and task_path only for mode=task",
      "absent bundle: spec_status=absent, with no mode, spec_path, plan_path, or task_path; output mode is single",
      "verify stdin: the unchanged directory review prepare envelope",
      "",
    ].join("\n"));
    process.exit(0);
  }
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
