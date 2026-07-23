import { readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

function relativePathWithin(worktree, path) {
  const relativePath = relative(worktree, path);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Spec artifact must be inside the main worktree: ${path}`);
  }
  return relativePath;
}

async function pathWithin(worktree, path) {
  return relativePathWithin(await realpath(worktree), await realpath(path));
}

async function localIssuePath({ mainWorktree, executionPlan, ticketId }) {
  const ticket = executionPlan.tickets.find((candidate) => candidate.id === ticketId);
  if (!ticket) throw new Error(`Unknown spec ticket: ${ticketId}`);
  const issuePath = resolve(await realpath(mainWorktree), ticket.ref);
  return { issuePath, relativePath: await pathWithin(mainWorktree, issuePath) };
}

export function createIssueTracker({ mainWorktree, executionPlan }) {
  return {
    async read(ticketId) {
      const { issuePath } = await localIssuePath({ mainWorktree, executionPlan, ticketId });
      return readFile(issuePath, "utf8");
    },

    async markComplete(ticketId) {
      const { issuePath, relativePath } = await localIssuePath({ mainWorktree, executionPlan, ticketId });
      const content = await readFile(issuePath, "utf8");
      const updated = content.replace(/^(\s*-\s*)\[ \]/gm, "$1[x]");
      if (updated === content) return [];
      await writeFile(issuePath, updated);
      return [relativePath];
    },

    async paths() {
      return Promise.all(executionPlan.tickets.map(async ({ id: ticketId }) => {
        const { relativePath } = await localIssuePath({ mainWorktree, executionPlan, ticketId });
        return relativePath;
      }));
    }
  };
}
