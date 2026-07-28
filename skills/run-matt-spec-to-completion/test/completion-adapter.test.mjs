import assert from "node:assert/strict";
import test from "node:test";

import { createNativeAdapter, createUnsupportedAdapter, normalizeCompletion } from "../lib/completion-adapter.mjs";

const SHA = "a".repeat(40);
const done = (ticketId) => ({ ticket_id: ticketId, status: "done", commits: [SHA], checks: ["node --test: pass"], changed_paths: [], summary: ticketId });

test("accepts only canonical JSON completion payloads", () => {
  assert.deepEqual(normalizeCompletion({ ticketId: "01", raw: JSON.stringify(done("01")) }), done("01"));
  const result = normalizeCompletion({ ticketId: "01", raw: "RESULT: DONE\nCOMMITS: ignored" });
  assert.equal(result.status, "blocked");
  assert.match(result.error, /invalid JSON completion/);
});

test("executes one ticket and turns a native exception into a blocked result", async () => {
  const adapter = createNativeAdapter({
    async spawn() { throw new Error("connection reset"); },
    async collect() { throw new Error("unreachable"); },
  });
  const result = await adapter.executeTicket({ ticket: { id: "01" }, worktree: "/tmp/execution" });
  assert.equal(result.ticket_id, "01");
  assert.equal(result.status, "blocked");
  assert.match(result.error, /connection reset/);
});

test("dispatches JSON completions serially in task ID order and stops after blocked", async () => {
  const events = [];
  const adapter = createNativeAdapter({
    async spawn({ ticket }) { events.push(`spawn:${ticket.id}`); return ticket.id; },
    async collect(id) {
      events.push(`collect:${id}`);
      return id === "01" ? { ticket_id: id, status: "blocked", commits: [], checks: [], changed_paths: [], summary: id, error: "blocked" } : done(id);
    },
  });
  const results = await adapter.executeFrontier({ tickets: [{ id: "02" }, { id: "01" }], worktree: "/tmp/execution" });
  assert.deepEqual(events, ["spawn:01", "collect:01"]);
  assert.deepEqual(results.map((result) => result.ticket_id), ["01"]);
  assert.equal(results[0].status, "blocked");
});

test("unsupported adapters only block the first serial task", async () => {
  const adapter = createUnsupportedAdapter("native");
  const results = await adapter.executeFrontier({ tickets: [{ id: "02" }, { id: "01" }], worktree: "/tmp/execution" });
  assert.deepEqual(results.map((result) => result.ticket_id), ["01"]);
  assert.equal(results[0].status, "blocked");
});
