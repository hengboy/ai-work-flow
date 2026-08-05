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
  assert.ok(listed.result.tools[0].inputSchema.properties.operation.enum.includes("support_validate"));
  assert.ok(listed.result.tools[0].inputSchema.properties.input);
  assert.deepEqual(listed.result.tools[0].inputSchema.properties.request.required, ["objective"]);
  assert.match(listed.result.tools[0].description, /contract takes exactly/);
  assert.match(listed.result.tools[0].description, /must never validate pre-run discovery/);
  assert.equal(listed.result.tools[0].inputSchema.allOf[0].then.maxProperties, 1);
  assert.deepEqual(listed.result.tools[0].inputSchema.allOf[1].then.required, ["repository", "caller_ref", "input", "receipt"]);
  assert.equal(JSON.stringify(listed).includes("command"), false);
  const unknown = await handleBrokerRequest({
    jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "shell", arguments: {} },
  });
  assert.equal(unknown.error.code, -32602);
});

test("contract accepts no repository or workflow kind fields", async () => {
  const contract = await dispatchWorkflowState({ operation: "contract" });
  assert.ok(contract.actions["coding.prepare"]);
  await assert.rejects(dispatchWorkflowState({ operation: "contract", repository: "/tmp/repo" }), /unsupported field/);
  await assert.rejects(dispatchWorkflowState({ operation: "contract", kind: "coding" }), /unsupported field/);
});

test("repository status discovers runs without requiring a run id", async () => {
  const root = await repository();
  const empty = await dispatchWorkflowState({ operation: "status", repository: root, kind: "coding" }, { cwd: root, pid: process.pid });
  assert.deepEqual(empty.runs, []);
  assert.equal(empty.kind, "coding");
  const started = await dispatchWorkflowState({
    operation: "start", repository: root, kind: "coding", plan_digest: "e".repeat(64), task_mode: "single",
  }, { cwd: root, pid: process.pid });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const latest = await dispatchWorkflowState({
    operation: "start", repository: root, kind: "coding", plan_digest: "f".repeat(64), task_mode: "split",
  }, { cwd: root, pid: process.pid });
  const discovered = await dispatchWorkflowState({ operation: "status", repository: root, kind: "coding" }, { cwd: root, pid: process.pid });
  assert.deepEqual(discovered.runs.map((run) => run.run_id), [latest.run_id, started.run_id]);
  assert.deepEqual(await dispatchWorkflowState({ operation: "status", repository: root, run_id: started.run_id }, { cwd: root, pid: process.pid }), started);
  await assert.rejects(dispatchWorkflowState({ operation: "status", repository: root, action_id: "coding.prepare" }, { cwd: root, pid: process.pid }), /without run_id/);
});

test("broker starts direct coding requests without plan fields", async () => {
  const root = await repository();
  const request = { objective: "Fix the reproducible save crash" };
  const started = await dispatchWorkflowState({ operation: "start", repository: root, kind: "coding", request }, { cwd: root, pid: process.pid });
  assert.equal(started.source_type, "direct");
  assert.deepEqual(started.direct_request, request);
  assert.deepEqual(started.ready_actions, ["coding.triage"]);
  await assert.rejects(dispatchWorkflowState({
    operation: "start", repository: root, kind: "coding", request, plan_digest: "a".repeat(64), task_mode: "single",
  }, { cwd: root, pid: process.pid }), /start input/);
});

test("workflow broker validates support receipts without advancing the parent phase", async () => {
  const root = await repository();
  const planDigest = "d".repeat(64);
  const started = await dispatchWorkflowState({ operation: "start", repository: root, kind: "coding", plan_digest: planDigest, task_mode: "single" }, { cwd: root, pid: process.pid });
  const parentInput = { fields: { plan_digest: planDigest, task_mode: "single", target_base: "main" }, artifacts: [] };
  const prepare = await dispatchWorkflowState({ operation: "claim", repository: root, run_id: started.run_id, action_id: "coding.prepare", claimant: "caller", input: parentInput }, { cwd: root, pid: process.pid });
  await dispatchWorkflowState({ operation: "finish", repository: root, receipt: {
    run_id: started.run_id, action_id: "coding.prepare", attempt: prepare.attempt, result: "completed", summary: "prepared",
    outputs: { worktree: root, branch: "main", base_sha: "a".repeat(40), initial_status: { clean: true } }, artifacts: [], checks: [],
  } }, { cwd: root, pid: process.pid });
  const claim = await dispatchWorkflowState({ operation: "claim", repository: root, run_id: started.run_id, action_id: "coding.implement", claimant: "caller", input: {
    fields: { worktree: root, base_sha: "a".repeat(40), spec_or_task_ids: ["task"], acceptance: ["accepted"] }, artifacts: [],
  } }, { cwd: root, pid: process.pid });
  const supportInput = { fields: { objective: "locate implementation", terms: ["workflow"], known_paths: [] }, artifacts: [] };
  const receipt = {
    run_id: started.run_id, caller_ref: claim.claim_id, call_id: "broker-support-001", action_id: "support.locate", result: "completed", summary: "complete",
    outputs: { entry_paths: ["execution-runtime/lib/workflow-store.mjs"], direct_dependencies: ["workflow-contract.mjs"], facts: ["located"], open_decisions: [] }, artifacts: [], checks: ["read-back"],
  };
  assert.deepEqual(await dispatchWorkflowState({ operation: "support_validate", repository: root, caller_ref: claim.claim_id, input: supportInput, receipt }, { cwd: root, pid: process.pid }), receipt);
  const status = await dispatchWorkflowState({ operation: "status", repository: root, run_id: started.run_id }, { cwd: root, pid: process.pid });
  assert.equal(status.phase, "prepared");
  assert.equal(status.revision, 1);
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
