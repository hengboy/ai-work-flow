import { assertCompletionResult } from "./validation.mjs";

function protocolError(taskId, error) {
  return assertCompletionResult({ task_id: taskId, status: "blocked", commits: [], tests: [], summary: "Completion protocol error", error });
}

function fieldsFrom(raw) {
  const fields = new Map();
  for (const line of raw.trim().split("\n")) {
    const match = line.match(/^([A-Z]+):\s*(.*)$/);
    if (match) fields.set(match[1], match[2]);
  }
  return fields;
}

export function normalizeCompletion({ taskId, raw }) {
  const fields = fieldsFrom(raw);
  const result = fields.get("RESULT");
  const commitsText = fields.get("COMMITS");
  const testsText = fields.get("TESTS");
  const summary = fields.get("SUMMARY");
  const error = fields.get("ERROR");
  if (!result || !commitsText || !testsText || !summary) return protocolError(taskId, "missing required terminal fields");
  if (result !== "DONE" && result !== "BLOCKED") return protocolError(taskId, "RESULT must be DONE or BLOCKED");
  const commits = commitsText === "none" ? [] : commitsText.split(/[\s,]+/).filter(Boolean);
  if (commits.some((commit) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit))) return protocolError(taskId, "COMMITS contains an invalid SHA");
  const tests = testsText === "none" ? [] : [testsText];
  if (result === "DONE" && (commits.length === 0 || error)) return protocolError(taskId, "DONE requires commits and forbids ERROR");
  if (result === "BLOCKED" && (commits.length > 0 || !error)) return protocolError(taskId, "BLOCKED requires ERROR and forbids commits");
  return assertCompletionResult({ task_id: taskId, status: result === "DONE" ? "done" : "blocked", commits, tests, summary, ...(error ? { error } : {}) });
}

export function createNativeAdapter({ spawn, collect }) {
  return {
    async executeFrontier({ tasks, worktree }) {
      const results = [];
      for (const task of [...tasks].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)) {
        try {
          const handle = await spawn({ task, worktree });
          const raw = await collect(handle);
          const result = normalizeCompletion({ taskId: task.id, raw });
          results.push(result);
          if (result.status === "blocked") break;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          results.push(protocolError(task.id, `native dispatch or collection failed: ${reason}`));
          break;
        }
      }
      return results;
    },
  };
}

export function createUnsupportedAdapter(name) {
  return {
    async executeFrontier({ tasks }) {
      const task = [...tasks].sort((left, right) => left.id.localeCompare(right.id))[0];
      return task ? [protocolError(task.id, `${name} adapter is unavailable`)] : [];
    },
  };
}

export const createCodexClaudeAdapter = createNativeAdapter;
export const createOpenCodeAdapter = createNativeAdapter;
