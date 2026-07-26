#!/usr/bin/env node
import process from "node:process";
import { createExecutionOrchestrator } from "../skills/run-matt-spec-to-completion/lib/execution-orchestrator.mjs";
import { deriveSpecLocation } from "../skills/run-matt-spec-to-completion/lib/paths.mjs";
import { findMainWorktree } from "../skills/run-matt-spec-to-completion/lib/worktree-lifecycle.mjs";
import { blockTicket, beginReview, completeReviewFix, completeTicket, decideReview, recordReview, startTickets } from "../skills/run-matt-spec-to-completion/lib/checkpoint.mjs";
import { currentHead, gitSucceeds, isAncestor } from "../skills/run-matt-spec-to-completion/lib/git.mjs";
import { selectTicketFrontier } from "../skills/run-matt-spec-to-completion/lib/ticket-frontier.mjs";
import { assertCompletionResult, assertHandoffResult } from "../skills/run-matt-spec-to-completion/lib/validation.mjs";
import { toShanghaiTimestamp } from "../skills/run-matt-spec-to-completion/lib/time.mjs";
import { createRuntimeStateStore, withFeatureLock } from "./state-store.mjs";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument: ${key ?? ""}`);
    options[key.slice(2).replaceAll("-", "_")] = value;
  }
  return options;
}

function requireOption(options, name) {
  if (!options[name]) throw new Error(`--${name.replaceAll("_", "-")} is required.`);
  return options[name];
}

async function stdinJson() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) throw new Error("Expected JSON on stdin.");
  return JSON.parse(raw);
}

async function assertTicketCommits(worktree, ticket, commits) {
  for (const commit of commits) {
    if (!await gitSucceeds(worktree, ["rev-parse", "--verify", `${commit}^{commit}`])) throw new Error(`Completion result commit does not exist: ${commit}`);
    if (!await isAncestor(worktree, commit)) throw new Error(`Completion result commit is not on the execution branch: ${commit}`);
    if (commit === ticket.start_commit || !await isAncestor(worktree, ticket.start_commit, commit)) {
      throw new Error(`Completion result commit must be after ticket ${ticket.id} start commit`);
    }
  }
}

function completionFromHandoff(input) {
  const handoff = assertHandoffResult(input);
  const completion = assertCompletionResult(handoff.payload);
  if (handoff.status !== completion.status) throw new Error("Handoff envelope status must match its Ticket Completion Result status.");
  return completion;
}

async function run(options) {
  const repository = requireOption(options, "repository");
  const stateStore = createRuntimeStateStore();
  if (options.command === "prepare") {
    const args = { repository, branch: requireOption(options, "branch"), specPath: requireOption(options, "spec"), worktreePath: requireOption(options, "worktree") };
    const orchestrator = createExecutionOrchestrator();
    const { featureSlug } = deriveSpecLocation(repository, args.specPath);
    const result = await withFeatureLock(repository, featureSlug, async () => (
      await gitSucceeds(repository, ["show-ref", "--verify", "--quiet", `refs/heads/${args.branch}`])
        ? orchestrator.resume(args)
        : orchestrator.initialize(args)
    ));
    return { command: "prepare", status: result.status ?? "initialized", feature_slug: result.executionPlan?.spec.feature_slug, checkpoint: result.checkpoint };
  }
  const featureSlug = requireOption(options, "feature");
  const worktree = options.worktree;
  if (options.command === "status") {
    const result = await stateStore.integrity({ repository, featureSlug, executionWorktree: worktree, checkExecutionWorktree: Boolean(worktree) });
    return { command: "status", status: result.checkpoint.status, checkpoint: result.checkpoint, execution_plan: result.executionPlan };
  }
  if (options.command === "claim") {
    const result = await stateStore.transition({ repository, featureSlug, executionWorktree: requireOption(options, "worktree"), async apply(current) {
      const frontier = selectTicketFrontier({ executionPlan: current.executionPlan, checkpoint: current.checkpoint });
      if (frontier.status !== "ready") throw new Error(frontier.reason ?? "No ticket is ready to claim.");
      const ticket = frontier.tickets[0];
      const checkpoint = startTickets(current.checkpoint, [ticket.id], await currentHead(worktree), toShanghaiTimestamp(new Date()));
      return checkpoint;
    } });
    const ticket = result.executionPlan.tickets.find((candidate) => candidate.id === result.checkpoint.tickets.find((state) => state.status === "in_progress")?.id);
    return { command: "claim", status: "in_progress", ticket, checkpoint: result.checkpoint };
  }
  if (options.command === "record-ticket") {
    const completion = completionFromHandoff(await stdinJson());
    const result = await stateStore.transition({ repository, featureSlug, executionWorktree: requireOption(options, "worktree"), async apply(current) {
      const ticket = current.checkpoint.tickets.find((candidate) => candidate.id === completion.ticket_id);
      if (!ticket || ticket.status !== "in_progress") throw new Error(`Ticket ${completion.ticket_id} is not claimed.`);
      if (completion.status === "done") await assertTicketCommits(worktree, ticket, completion.commits);
      return completion.status === "done"
        ? completeTicket(current.checkpoint, completion.ticket_id, completion.commits.at(-1), toShanghaiTimestamp(new Date()))
        : blockTicket(current.checkpoint, completion.ticket_id, completion.error, toShanghaiTimestamp(new Date()));
    } });
    return { command: "record-ticket", status: completion.status, ticket_id: completion.ticket_id, checkpoint: result.checkpoint };
  }
  if (options.command === "record-review") {
    const input = await stdinJson();
    if (typeof input.findings_summary !== "string" || !input.findings_summary) throw new Error("findings_summary is required.");
    const result = await stateStore.transition({ repository, featureSlug, checkExecutionWorktree: false, async apply(current) {
      const started = current.checkpoint.status === "executing" && current.checkpoint.tickets.every((ticket) => ticket.status === "done")
        ? beginReview(current.checkpoint, toShanghaiTimestamp(new Date()))
        : current.checkpoint;
      return recordReview(started, input.findings_summary, toShanghaiTimestamp(new Date()));
    } });
    return { command: "record-review", status: result.checkpoint.review.status, checkpoint: result.checkpoint };
  }
  if (options.command === "review-decision") {
    const input = await stdinJson();
    const result = await stateStore.transition({ repository, featureSlug, checkExecutionWorktree: false, apply: ({ checkpoint }) => decideReview(checkpoint, input.decision, toShanghaiTimestamp(new Date())) });
    return { command: "review-decision", status: result.checkpoint.status, checkpoint: result.checkpoint };
  }
  if (options.command === "complete-review-fix") {
    const result = await stateStore.transition({ repository, featureSlug, checkExecutionWorktree: false, apply: ({ checkpoint }) => completeReviewFix(checkpoint, toShanghaiTimestamp(new Date())) });
    return { command: "complete-review-fix", status: result.checkpoint.status, checkpoint: result.checkpoint };
  }
  if (options.command === "integrate") {
    return withFeatureLock(repository, featureSlug, async () => {
      const integrity = await stateStore.integrity({ repository, featureSlug, executionWorktree: requireOption(options, "worktree") });
      const orchestrator = createExecutionOrchestrator({ generateCommitMessage: async () => "chore: record execution" });
      const integrated = await orchestrator.integrate({ repository, worktree, featureSlug, executionPlan: integrity.executionPlan, checkpoint: integrity.checkpoint });
      return { command: "integrate", status: integrated.status, checkpoint: integrated.checkpoint };
    });
  }
  if (options.command === "cleanup") {
    return withFeatureLock(repository, featureSlug, async () => {
      const mainWorktree = await findMainWorktree(repository);
      if (!mainWorktree) throw new Error("Main worktree is unavailable");
      const integrity = await stateStore.integrity({ repository: mainWorktree, featureSlug, checkExecutionWorktree: false });
      const orchestrator = createExecutionOrchestrator({ generateCommitMessage: async () => "chore: record execution" });
      const cleaned = await orchestrator.completeMergedCleanup({ repository, mainWorktree, featureSlug, executionPlan: integrity.executionPlan, checkpoint: integrity.checkpoint });
      return { command: "cleanup", status: cleaned.status, checkpoint: cleaned.checkpoint };
    });
  }
  throw new Error(`Unknown command: ${options.command ?? ""}`);
}

try {
  process.stdout.write(`${JSON.stringify(await run(parseArgs(process.argv.slice(2))))}\n`);
} catch (error) {
  process.stderr.write(`execution-cli: ${error.message}\n`);
  process.exitCode = 1;
}
