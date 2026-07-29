#!/usr/bin/env node
import process from "node:process";
import { randomUUID } from "node:crypto";
import { createExecutionCoding } from "../skills/run-matt-spec-to-completion/lib/execution-coding.mjs";
import { deriveSpecLocation } from "../skills/run-matt-spec-to-completion/lib/paths.mjs";
import { findMainWorktree } from "../skills/run-matt-spec-to-completion/lib/worktree-lifecycle.mjs";
import { beginSync, blockTicket, beginReview, completeReviewFix, completeSync, completeTicket, decideReview, recordReview, startTickets } from "../skills/run-matt-spec-to-completion/lib/checkpoint.mjs";
import { currentHead, git, gitOutput, gitSucceeds, isAncestor } from "../skills/run-matt-spec-to-completion/lib/git.mjs";
import { selectTicketFrontier } from "../skills/run-matt-spec-to-completion/lib/ticket-frontier.mjs";
import { assertCompletionResult, assertHandoffResult } from "../skills/run-matt-spec-to-completion/lib/validation.mjs";
import { assertReviewCoverage, createReviewManifest } from "../skills/run-matt-spec-to-completion/lib/review-manifest.mjs";
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

async function reviewManifestFromInput(worktree, fixedPoint, reviewCommit, input) {
  if (!input || !["present", "absent"].includes(input.spec_status) || !Array.isArray(input.standards_source) || input.standards_source.length === 0) {
    throw new Error("begin-review requires explicit spec_status and a non-empty standards_source.");
  }
  if ((input.spec_status === "present") !== Boolean(input.spec_source)) {
    throw new Error("begin-review spec_source must match explicit spec_status.");
  }
  for (const source of input.standards_source) {
    if (!source || typeof source.path !== "string" || !source.path || source.revision !== reviewCommit) {
      throw new Error("begin-review standards_source must identify the frozen review commit.");
    }
    if (!await gitSucceeds(worktree, ["cat-file", "-e", `${reviewCommit}:${source.path}`])) {
      throw new Error(`Review standards source is unavailable at frozen commit: ${source.path}`);
    }
  }
  const paths = (await git(worktree, ["diff", "--name-only", "-z", `${fixedPoint}...${reviewCommit}`])).split("\0").filter(Boolean).sort();
  const commitList = (await gitOutput(worktree, ["log", "--format=%H%x1f%s", `${fixedPoint}..${reviewCommit}`])).trim().split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf("\x1f");
    if (separator < 1) throw new Error("Could not create a structured review commit list");
    return { sha: line.slice(0, separator), subject: line.slice(separator + 1) };
  });
  const diffCommand = ["git", "diff", "--no-ext-diff", `${fixedPoint}...${reviewCommit}`];
  return createReviewManifest({
    fixed_point: fixedPoint,
    review_commit: reviewCommit,
    commit_list: commitList,
    changed_paths: paths.map((path) => ({ record_type: "1", index_status: "M", worktree_status: ".", path })),
    checks: [`git diff --check ${fixedPoint}...${reviewCommit}`],
    diff_command: diffCommand,
    spec_status: input.spec_status,
    spec_source: input.spec_source ?? null,
    standards_source: input.standards_source,
    shards: paths.map((path, index) => ({ id: `shard-${String(index + 1).padStart(4, "0")}`, paths: [path], diff_command: [...diffCommand, "--", path] })),
  });
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

async function unmergedPaths(worktree) {
  return (await gitOutput(worktree, ["diff", "--name-only", "--diff-filter=U", "-z"]))
    .split("\0").filter(Boolean).sort();
}

function completionFromHandoff(input) {
  const handoff = assertHandoffResult(input);
  const completion = assertCompletionResult(handoff.payload);
  for (const field of ["status", "summary", "checks", "error"]) {
    if (JSON.stringify(handoff[field]) !== JSON.stringify(completion[field])) {
      throw new Error(`Handoff envelope ${field} must match its Ticket Completion Result ${field}.`);
    }
  }
  return { handoff, completion };
}

async function run(options) {
  const repository = requireOption(options, "repository");
  const stateStore = createRuntimeStateStore();
  if (options.command === "prepare") {
    const args = { repository, branch: requireOption(options, "branch"), specPath: requireOption(options, "spec"), worktreePath: requireOption(options, "worktree") };
    const coding = createExecutionCoding();
    const { featureSlug } = deriveSpecLocation(repository, args.specPath);
    const result = await withFeatureLock(repository, featureSlug, async () => (
      await gitSucceeds(repository, ["show-ref", "--verify", "--quiet", `refs/heads/${args.branch}`])
        ? coding.resume(args)
        : coding.initialize(args)
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
    const expectedRoleId = requireOption(options, "role_id");
    const sessionId = requireOption(options, "session_id");
    const result = await stateStore.transition({ repository, featureSlug, executionWorktree: requireOption(options, "worktree"), async apply(current) {
      const frontier = selectTicketFrontier({ executionPlan: current.executionPlan, checkpoint: current.checkpoint });
      if (frontier.status !== "ready") throw new Error(frontier.reason ?? "No ticket is ready to claim.");
      const ticket = frontier.tickets[0];
      const checkpoint = startTickets(current.checkpoint, [ticket.id], await currentHead(worktree), { claimId: randomUUID(), expectedRoleId, sessionId }, toShanghaiTimestamp(new Date()));
      return checkpoint;
    } });
    const ticket = result.executionPlan.tickets.find((candidate) => candidate.id === result.checkpoint.tickets.find((state) => state.status === "in_progress")?.id);
    const ticketState = result.checkpoint.tickets.find((state) => state.id === ticket.id);
    return { command: "claim", status: "in_progress", ticket: { ...ticket, claim_id: ticketState.claim_id, expected_role_id: ticketState.expected_role_id, session_id: ticketState.session_id }, checkpoint: result.checkpoint };
  }
  if (options.command === "record-ticket") {
    const { handoff, completion } = completionFromHandoff(await stdinJson());
    const result = await stateStore.transition({ repository, featureSlug, executionWorktree: requireOption(options, "worktree"), async apply(current) {
      const ticket = current.checkpoint.tickets.find((candidate) => candidate.id === completion.ticket_id);
      if (!ticket || ticket.status !== "in_progress") throw new Error(`Ticket ${completion.ticket_id} is not claimed.`);
      if (handoff.role_id !== ticket.expected_role_id || handoff.session_id !== ticket.session_id || handoff.claim_id !== ticket.claim_id) {
        throw new Error("Handoff claim identity does not match the current ticket claim.");
      }
      if (completion.status === "done") await assertTicketCommits(worktree, ticket, completion.commits);
      return completion.status === "done"
        ? completeTicket(current.checkpoint, completion.ticket_id, completion.commits.at(-1), toShanghaiTimestamp(new Date()))
        : blockTicket(current.checkpoint, completion.ticket_id, completion.error, toShanghaiTimestamp(new Date()));
    } });
    return { command: "record-ticket", status: completion.status, ticket_id: completion.ticket_id, checkpoint: result.checkpoint };
  }
  if (options.command === "begin-review") {
    const executionWorktree = requireOption(options, "worktree");
    const input = await stdinJson();
    const result = await stateStore.transition({ repository, featureSlug, executionWorktree, async apply(current) {
      if (current.checkpoint.status !== "executing" || current.checkpoint.review.status !== "pending") {
        throw new Error("Review can only begin from a pending execution review");
      }
      if (await git(executionWorktree, ["status", "--short"])) throw new Error("Execution worktree must be clean before review");
      const fixedPoint = current.checkpoint.sync?.main_commit;
      if (current.checkpoint.sync?.status !== "complete" || !fixedPoint) {
        throw new Error("Main must be synchronized before final review");
      }
      const reviewCommit = await currentHead(executionWorktree);
      if (!await isAncestor(executionWorktree, fixedPoint, reviewCommit)) throw new Error("Review fixed point must be an ancestor of the review commit");
      if (await gitSucceeds(executionWorktree, ["diff", "--quiet", `${fixedPoint}...${reviewCommit}`])) throw new Error("Review diff must not be empty");
      const manifest = await reviewManifestFromInput(executionWorktree, fixedPoint, reviewCommit, input);
      return beginReview(current.checkpoint, { fixedPoint, reviewCommit, manifest }, toShanghaiTimestamp(new Date()));
    } });
    const { fixed_point: fixedPoint, review_commit: reviewCommit } = result.checkpoint.review;
    return {
      command: "begin-review",
      status: result.checkpoint.status,
      checkpoint: result.checkpoint,
      manifest: result.checkpoint.review.manifest,
    };
  }
  if (options.command === "record-review") {
    const input = await stdinJson();
    if (typeof input.findings_summary !== "string" || !input.findings_summary) throw new Error("findings_summary is required.");
    const result = await stateStore.transition({ repository, featureSlug, checkExecutionWorktree: false, async apply(current) {
      if (!['in_progress', 'awaiting_user'].includes(current.checkpoint.review.status)) throw new Error("Review is not in progress");
      if (input.manifest_digest !== current.checkpoint.review?.manifest?.manifest_digest) throw new Error("Review result manifest digest does not match the frozen ReviewManifest");
      assertReviewCoverage(current.checkpoint.review.manifest, input.coverage);
      return recordReview(current.checkpoint, { manifestDigest: input.manifest_digest, coverage: input.coverage, findingsSummary: input.findings_summary, result: input.result }, toShanghaiTimestamp(new Date()));
    } });
    return { command: "record-review", status: result.checkpoint.review.status, checkpoint: result.checkpoint };
  }
  if (options.command === "review-decision") {
    const input = await stdinJson();
    const result = await stateStore.transition({ repository, featureSlug, checkExecutionWorktree: false, apply: ({ checkpoint }) => decideReview(checkpoint, input.decision, input.finding_ids, toShanghaiTimestamp(new Date())) });
    return { command: "review-decision", status: result.checkpoint.status, checkpoint: result.checkpoint };
  }
  if (options.command === "complete-review-fix") {
    const executionWorktree = requireOption(options, "worktree");
    const input = await stdinJson();
    if (!Array.isArray(input.checks) || input.checks.length === 0 || input.checks.some((check) => typeof check !== "string" || !check)) {
      throw new Error("At least one review fix check is required.");
    }
    const result = await stateStore.transition({ repository, featureSlug, executionWorktree, async apply({ checkpoint }) {
      if (await git(executionWorktree, ["status", "--short"])) throw new Error("Execution worktree must be clean after review fixes");
      const fixCommit = await currentHead(executionWorktree);
      const reviewCommit = checkpoint.review.review_commit;
      if (fixCommit === reviewCommit || !await isAncestor(executionWorktree, reviewCommit, fixCommit)) {
        throw new Error("Review fix commit must be after the reviewed commit");
      }
      return completeReviewFix(checkpoint, { fixCommit, checks: input.checks }, toShanghaiTimestamp(new Date()));
    } });
    return { command: "complete-review-fix", status: result.checkpoint.status, checkpoint: result.checkpoint };
  }
  if (options.command === "sync-main") {
    const executionWorktree = requireOption(options, "worktree");
    return withFeatureLock(repository, featureSlug, async () => {
      if (await git(executionWorktree, ["status", "--short"])) throw new Error("Execution worktree must be clean before synchronization");
      const mainWorktree = await findMainWorktree(repository);
      if (!mainWorktree) throw new Error("Main worktree is unavailable");
      const mainCommit = await currentHead(mainWorktree);
      const started = await stateStore.transition({ repository, featureSlug, executionWorktree, apply: ({ checkpoint }) => beginSync(checkpoint, mainCommit, toShanghaiTimestamp(new Date())) });
      if (!await gitSucceeds(executionWorktree, ["merge", "--no-edit", mainCommit])) {
        const paths = await unmergedPaths(executionWorktree);
        if (paths.length === 0) throw new Error("Main synchronization failed without merge conflicts");
        const conflicted = await stateStore.transition({ repository, featureSlug, executionWorktree, apply: ({ checkpoint }) => completeSync(checkpoint, { conflicted: true, unmergedPaths: paths }, toShanghaiTimestamp(new Date())) });
        return { command: "sync-main", status: "conflicted", unmerged_paths: paths, checkpoint: conflicted.checkpoint };
      }
      const completed = await stateStore.transition({ repository, featureSlug, executionWorktree, apply: ({ checkpoint }) => completeSync(checkpoint, {}, toShanghaiTimestamp(new Date())) });
      return { command: "sync-main", status: "complete", main_commit: started.checkpoint.sync.main_commit, checkpoint: completed.checkpoint };
    });
  }
  if (options.command === "complete-sync") {
    const executionWorktree = requireOption(options, "worktree");
    return withFeatureLock(repository, featureSlug, async () => {
      if (await git(executionWorktree, ["status", "--short"])) throw new Error("Execution worktree must be clean after resolving synchronization conflicts");
      const mainWorktree = await findMainWorktree(repository);
      if (!mainWorktree) throw new Error("Main worktree is unavailable");
      const result = await stateStore.transition({ repository, featureSlug, executionWorktree, async apply({ checkpoint }) {
        if (checkpoint.sync?.main_commit !== await currentHead(mainWorktree)) throw new Error("Main advanced while synchronization conflicts were being resolved");
        if (!await isAncestor(executionWorktree, checkpoint.sync.main_commit)) throw new Error("Resolved feature worktree does not contain the synchronized main commit");
        return completeSync(checkpoint, {}, toShanghaiTimestamp(new Date()));
      } });
      return { command: "complete-sync", status: "complete", checkpoint: result.checkpoint };
    });
  }
  if (options.command === "integrate") {
    return withFeatureLock(repository, featureSlug, async () => {
      const integrity = await stateStore.integrity({ repository, featureSlug, executionWorktree: requireOption(options, "worktree") });
      const integrated = await createExecutionCoding().integrate({ repository, worktree, featureSlug, executionPlan: integrity.executionPlan, checkpoint: integrity.checkpoint, allowStash: options.allow_stash === "true" });
      return { command: "integrate", status: integrated.status, checkpoint: integrated.checkpoint };
    });
  }
  if (options.command === "cleanup") {
    return withFeatureLock(repository, featureSlug, async () => {
      const mainWorktree = await findMainWorktree(repository);
      if (!mainWorktree) throw new Error("Main worktree is unavailable");
      const integrity = await stateStore.integrity({ repository: mainWorktree, featureSlug, checkExecutionWorktree: false });
      const cleaned = await createExecutionCoding().completeMergedCleanup({ repository, mainWorktree, featureSlug, executionPlan: integrity.executionPlan, checkpoint: integrity.checkpoint });
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
