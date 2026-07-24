import { verifyTicketDependencies } from "./spec-intake.mjs";

const inProgressReason = "A ticket is still in progress; confirm its worker has stopped before recovery";

export function selectTicketFrontier({ executionPlan, checkpoint }) {
  verifyTicketDependencies(executionPlan.tickets);
  const states = new Map(checkpoint.tickets.map((ticket) => [ticket.id, ticket]));
  if ([...states.values()].some((ticket) => ticket.status === "blocked")) {
    return { status: "blocked", tickets: [] };
  }
  if ([...states.values()].some((ticket) => ticket.status === "in_progress")) {
    return { status: "blocked", tickets: [], reason: inProgressReason };
  }
  const orderedTickets = [...executionPlan.tickets].sort((left, right) => left.level - right.level || left.id.localeCompare(right.id));
  for (const ticket of orderedTickets) {
    const state = states.get(ticket.id);
    if (!state) throw new Error(`Checkpoint does not contain ticket ${ticket.id}`);
    if (state.status === "pending") {
      const blocker = ticket.blocked_by.find((ticketId) => states.get(ticketId)?.status !== "done");
      if (blocker) return { status: "blocked", tickets: [], reason: `Ticket ${ticket.id} is blocked by ${blocker}` };
      return { status: "ready", tickets: [ticket] };
    }
    if (state.status !== "done") throw new Error(`Checkpoint ticket ${ticket.id} has an unknown status`);
  }
  throw new Error("No unfinished ticket remains");
}
