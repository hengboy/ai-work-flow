import assert from "node:assert/strict";
import test from "node:test";

import { createNativeAdapter, createUnsupportedAdapter } from "../lib/completion-adapter.mjs";

const SHA = "a".repeat(40);
const done = (summary) => `RESULT: DONE\nCOMMITS: ${SHA}\nTESTS: none\nSUMMARY: ${summary}`;

test("dispatches and collects frontier tasks serially in task ID order", async () => {
  const events = [];
  const adapter = createNativeAdapter({
    async spawn({ ticket }) {
      events.push(`spawn:${ticket.id}`);
      return ticket.id;
    },
    async collect(id) {
      events.push(`collect:${id}`);
      return done(id);
    },
  });

  const results = await adapter.executeFrontier({
    tickets: [{ id: "02" }, { id: "01" }],
    worktree: "/tmp/execution",
  });

  assert.deepEqual(events, ["spawn:01", "collect:01", "spawn:02", "collect:02"]);
  assert.deepEqual(results.map((result) => result.ticket_id), ["01", "02"]);
});

test("does not retry an unclassified native dispatch failure", async () => {
  let attempts = 0;
  const adapter = createNativeAdapter({
    async spawn() {
      attempts += 1;
      throw new Error("invalid request");
    },
    async collect() {
      throw new Error("unreachable");
    },
  });

  const [result] = await adapter.executeFrontier({ tickets: [{ id: "01" }], worktree: "/tmp/execution" });

  assert.equal(attempts, 1);
  assert.equal(result.status, "blocked");
  assert.match(result.error, /native dispatch or collection failed: invalid request/);
});

test("stops dispatching after a blocked completion", async () => {
  const dispatched = [];
  const adapter = createNativeAdapter({
    async spawn({ ticket }) {
      dispatched.push(ticket.id);
      return ticket.id;
    },
    async collect(id) {
      return `RESULT: BLOCKED\nCOMMITS: none\nTESTS: none\nSUMMARY: ${id}\nERROR: blocked`;
    },
  });

  const results = await adapter.executeFrontier({ tickets: [{ id: "01" }, { id: "02" }], worktree: "/tmp/execution" });

  assert.deepEqual(dispatched, ["01"]);
  assert.deepEqual(results.map((result) => result.ticket_id), ["01"]);
  assert.equal(results[0].status, "blocked");
});

test("stops dispatching after a native dispatch failure", async () => {
  const dispatched = [];
  const adapter = createNativeAdapter({
    async spawn({ ticket }) {
      dispatched.push(ticket.id);
      throw new Error("connection reset");
    },
    async collect() {
      throw new Error("unreachable");
    },
  });

  const results = await adapter.executeFrontier({ tickets: [{ id: "01" }, { id: "02" }], worktree: "/tmp/execution" });

  assert.deepEqual(dispatched, ["01"]);
  assert.deepEqual(results.map((result) => result.ticket_id), ["01"]);
  assert.match(results[0].error, /connection reset/);
});

test("stops dispatching after a native collection failure", async () => {
  const dispatched = [];
  const adapter = createNativeAdapter({
    async spawn({ ticket }) {
      dispatched.push(ticket.id);
      return ticket.id;
    },
    async collect() {
      throw new Error("connection reset");
    },
  });

  const results = await adapter.executeFrontier({ tickets: [{ id: "01" }, { id: "02" }], worktree: "/tmp/execution" });

  assert.deepEqual(dispatched, ["01"]);
  assert.deepEqual(results.map((result) => result.ticket_id), ["01"]);
  assert.match(results[0].error, /connection reset/);
});

test("unsupported adapters only block the first serial task", async () => {
  const adapter = createUnsupportedAdapter("native");
  const results = await adapter.executeFrontier({ tickets: [{ id: "02" }, { id: "01" }], worktree: "/tmp/execution" });

  assert.deepEqual(results.map((result) => result.ticket_id), ["01"]);
  assert.equal(results[0].status, "blocked");
});
