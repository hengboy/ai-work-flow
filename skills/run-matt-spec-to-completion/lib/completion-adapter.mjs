import { assertCompletionResult } from "./validation.mjs";

function protocolError(ticketId, error) {
  return assertCompletionResult({ ticket_id: ticketId, status: "blocked", commits: [], checks: [], changed_paths: [], summary: "Completion protocol error", error });
}

export function normalizeCompletion({ ticketId, raw }) {
  try {
    const result = assertCompletionResult(typeof raw === "string" ? JSON.parse(raw) : raw);
    if (result.ticket_id !== ticketId) throw new Error(`completion belongs to ${result.ticket_id}`);
    return result;
  } catch (error) {
    return protocolError(ticketId, `invalid JSON completion: ${error.message}`);
  }
}

export function createNativeAdapter({ spawn, collect }) {
  return {
    async executeTicket({ ticket, worktree }) {
      try {
        const handle = await spawn({ ticket, worktree });
        return normalizeCompletion({ ticketId: ticket.id, raw: await collect(handle) });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return protocolError(ticket.id, `native dispatch or collection failed: ${reason}`);
      }
    },

    async executeFrontier({ tickets, worktree }) {
      const results = [];
      for (const ticket of [...tickets].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)) {
        const result = await this.executeTicket({ ticket, worktree });
        results.push(result);
        if (result.status === "blocked") break;
      }
      return results;
    },
  };
}

export function createUnsupportedAdapter(name) {
  return {
    async executeTicket({ ticket }) {
      return protocolError(ticket.id, `${name} adapter is unavailable`);
    },

    async executeFrontier({ tickets }) {
      const ticket = [...tickets].sort((left, right) => left.id.localeCompare(right.id))[0];
      return ticket ? [await this.executeTicket({ ticket })] : [];
    },
  };
}

export const createCodexClaudeAdapter = createNativeAdapter;
export const createOpenCodeAdapter = createNativeAdapter;
