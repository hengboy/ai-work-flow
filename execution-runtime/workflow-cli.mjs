#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { createReviewPacket, verifyReviewPacket } from "./lib/review-packet.mjs";
import { claimAction, finishAction, recoverAction, resolveDecision, startRun, statusRun } from "./lib/workflow-store.mjs";

function options(argumentsList) {
  const parsed = {};
  for (let index = 0; index < argumentsList.length; index += 1) {
    const token = argumentsList[index];
    if (!token.startsWith("--") || index + 1 >= argumentsList.length) throw new Error(`invalid option: ${token}`);
    parsed[token.slice(2).replaceAll("-", "_")] = argumentsList[++index];
  }
  return parsed;
}

async function stdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  if (chunks.length === 0) throw new Error("JSON stdin is required");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const input = options(rest);
  let result;
  if (command === "start") {
    result = await startRun(input);
  } else if (command === "status") {
    result = await statusRun(input);
  } else if (command === "claim") {
    result = await claimAction({ ...input, owner_pid: Number(input.owner_pid) });
  } else if (command === "finish") {
    result = await finishAction({ repository: input.repository, receipt: await stdinJson() });
  } else if (command === "recover") {
    result = await recoverAction(input);
  } else if (command === "decide") {
    result = await resolveDecision({ repository: input.repository, run_id: input.run_id, decision: await stdinJson() });
  } else if (command === "review-packet-create") {
    result = await createReviewPacket({ repository: input.repository, run_id: input.run_id, ...await stdinJson() });
  } else if (command === "review-packet-verify") {
    result = await verifyReviewPacket({ repository: input.repository, run_id: input.run_id, ref: await stdinJson() });
  } else if (command === "contract") {
    result = JSON.parse(await readFile(new URL("./workflow-contract.json", import.meta.url), "utf8"));
  } else {
    throw new Error("usage: workflow-cli <start|status|claim|finish|recover|decide|review-packet-create|review-packet-verify|contract> [options]");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
