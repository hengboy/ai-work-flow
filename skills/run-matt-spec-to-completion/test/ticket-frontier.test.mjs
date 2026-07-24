import assert from "node:assert/strict";
import test from "node:test";

import { selectTicketFrontier } from "../lib/ticket-frontier.mjs";

const executionPlan = {
  tickets: [
    { id: "02", level: 0, blocked_by: [] },
    { id: "01", level: 1, blocked_by: ["02"] },
    { id: "03", level: 2, blocked_by: ["01"] },
  ],
};

test("selects exactly one pending ticket in execution-plan order", () => {
  const frontier = selectTicketFrontier({
    executionPlan,
    checkpoint: { tickets: [{ id: "02", status: "done" }, { id: "01", status: "pending" }, { id: "03", status: "pending" }] },
  });

  assert.deepEqual(frontier, { status: "ready", tickets: [{ id: "01", level: 1, blocked_by: ["02"] }] });
});

test("selects the lowest level and ID even when the plan array is not ordered", () => {
  const frontier = selectTicketFrontier({
    executionPlan: {
      tickets: [
        { id: "10", level: 0, blocked_by: [] },
        { id: "02", level: 0, blocked_by: [] },
        { id: "01", level: 1, blocked_by: ["02"] },
      ],
    },
    checkpoint: { tickets: [{ id: "10", status: "pending" }, { id: "02", status: "pending" }, { id: "01", status: "pending" }] },
  });

  assert.deepEqual(frontier, { status: "ready", tickets: [{ id: "02", level: 0, blocked_by: [] }] });
});

test("does not select another ticket while a ticket is in progress", () => {
  const frontier = selectTicketFrontier({
    executionPlan,
    checkpoint: { tickets: [{ id: "02", status: "done" }, { id: "01", status: "in_progress" }, { id: "03", status: "pending" }] },
  });

  assert.deepEqual(frontier, {
    status: "blocked",
    tickets: [],
    reason: "A ticket is still in progress; confirm its worker has stopped before recovery",
  });
});

test("does not select another ticket after a blocked ticket", () => {
  const frontier = selectTicketFrontier({
    executionPlan,
    checkpoint: { tickets: [{ id: "02", status: "done" }, { id: "01", status: "blocked" }, { id: "03", status: "pending" }] },
  });

  assert.deepEqual(frontier, { status: "blocked", tickets: [] });
});

test("rejects a frontier when the plan places a ticket before its unfinished blocker", () => {
  assert.throws(
    () => selectTicketFrontier({
      executionPlan: {
        tickets: [
          { id: "01", level: 0, blocked_by: [] },
          { id: "02", level: 0, blocked_by: ["01"] },
        ],
      },
      checkpoint: { tickets: [{ id: "01", status: "pending" }, { id: "02", status: "pending" }] },
    }),
    /Ticket 02 level must follow blocker 01/,
  );
});
