#!/usr/bin/env node
import { dispatchWorkflowTool, workflowTools } from "./lib/workflow-broker.mjs";

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
  if (command === "tools") {
    process.stdout.write(`${JSON.stringify((await workflowTools()).map((tool) => tool.name))}\n`);
    return;
  }
  const name = command?.replaceAll("-", "_");
  const declared = (await workflowTools()).some((tool) => tool.name === name);
  if (!declared) throw new Error("usage: workflow-cli <narrow-tool-name|tools> [--field value]; completion tools read one JSON object from stdin");
  const input = name.startsWith("workflow_complete_") ? await stdinJson() : options(rest);
  const result = await dispatchWorkflowTool(name, input, { cwd: process.cwd() });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
