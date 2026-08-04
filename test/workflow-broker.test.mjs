import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import test from "node:test";

import { dispatchWorkflowState, handleBrokerRequest } from "../execution-runtime/lib/workflow-broker.mjs";

const run = promisify(execFile);

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "workflow-broker-"));
  await run("git", ["init", "-b", "main"], { cwd: root });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await run("git", ["config", "user.name", "Test User"], { cwd: root });
  await writeFile(join(root, "README.md"), "baseline\n");
  await run("git", ["add", "README.md"], { cwd: root });
  await run("git", ["commit", "-m", "baseline"], { cwd: root });
  return root;
}

test("workflow broker exposes one fixed MCP tool and no command execution surface", async () => {
  const listed = await handleBrokerRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  assert.equal(listed.result.tools.length, 1);
  assert.equal(listed.result.tools[0].name, "workflow_state");
  assert.equal(JSON.stringify(listed).includes("command"), false);
  const unknown = await handleBrokerRequest({
    jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "shell", arguments: {} },
  });
  assert.equal(unknown.error.code, -32602);
});

test("workflow broker writes only the current repository Git common workflow directory", async () => {
  const root = await repository();
  const other = await repository();
  const before = await readFile(join(root, "README.md"), "utf8");
  const started = await dispatchWorkflowState({
    operation: "start",
    repository: root,
    kind: "coding",
    plan_digest: "a".repeat(64),
    task_mode: "single",
  }, { cwd: root, pid: process.pid });

  assert.match(started.run_id, /^run_[0-9a-f]{24}$/);
  assert.equal(await readFile(join(root, "README.md"), "utf8"), before);
  const runFile = join(root, ".git", "ai-work-flow", "runs", started.run_id, "run.json");
  assert.equal(JSON.parse(await readFile(runFile, "utf8")).run_id, started.run_id);
  await assert.rejects(dispatchWorkflowState({
    operation: "start", repository: other, kind: "planning", plan_digest: "b".repeat(64),
  }, { cwd: root, pid: process.pid }), /current repository/);
  await assert.rejects(dispatchWorkflowState({
    operation: "execute", repository: root, command: "touch forbidden",
  }, { cwd: root, pid: process.pid }), /operation/);
  await assert.rejects(dispatchWorkflowState({
    operation: "status", repository: root, run_id: started.run_id, command: "touch forbidden",
  }, { cwd: root, pid: process.pid }), /unsupported field/);
});

test("workflow broker converts tool results and errors into MCP responses", async () => {
  const root = await repository();
  const response = await handleBrokerRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "workflow_state",
      arguments: { operation: "start", repository: root, kind: "planning", plan_digest: "c".repeat(64) },
    },
  }, { cwd: root, pid: process.pid });
  assert.equal(response.result.isError, false);
  assert.match(response.result.content[0].text, /"run_id":"run_/);

  const failed = await handleBrokerRequest({
    jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "workflow_state", arguments: { operation: "missing", repository: root } },
  }, { cwd: root, pid: process.pid });
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.content[0].text, /operation/);
});

test("workflow broker entry serves newline-delimited MCP over stdio", async () => {
  const root = await repository();
  const child = spawn(process.execPath, [new URL("../execution-runtime/workflow-broker.mjs", import.meta.url).pathname], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const responses = [];
  lines.on("line", (line) => responses.push(JSON.parse(line)));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  for (let attempt = 0; attempt < 20 && responses.length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  child.stdin.end();
  await once(child, "exit");
  assert.equal(responses[0].result.serverInfo.name, "ai-work-flow");
  assert.equal(responses[1].result.tools[0].name, "workflow_state");
});
