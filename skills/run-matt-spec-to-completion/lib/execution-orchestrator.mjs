import { randomUUID } from "node:crypto";
import { checkpointPath, deriveSpecLocation, executionPlanPath } from "./paths.mjs";
import { beginReview, blockTicket, completeReview, completeTicket, createCheckpoint, markMerged, readCheckpoint, recordStashReference, relocateCheckpoint, startTickets, writeCheckpoint as writeCheckpointToDisk } from "./checkpoint.mjs";
import { requireCheckpointIntegrity } from "./checkpoint-integrity.mjs";
import { currentHead, git, gitOutput, gitSucceeds, gitSucceedsWithInput, isAncestor } from "./git.mjs";
import { assertSpecArtifactsInMainWorktree, materializeSpec, verifyExecutionPlan, writeExecutionPlan } from "./spec-intake.mjs";
import { createIssueTracker } from "./issue-tracker.mjs";
import { assertCompletionResult } from "./validation.mjs";
import { toShanghaiTimestamp } from "./time.mjs";
import { createExecutionWorktree, ensureExecutionWorktree, findExecutionWorktree, findMainWorktree, removeExecutionWorktree, worktreeIsClean } from "./worktree-lifecycle.mjs";
import { createPreMergeStash } from "./pre-merge-stash.mjs";
import { createIntegrationLifecycle } from "./integration-lifecycle.mjs";
import { selectTicketFrontier } from "./ticket-frontier.mjs";

async function commitFiles(worktree, files, message) {
  const changed = new Set(await changedPaths(worktree));
  const filesToCommit = [...new Set(files)].filter((file) => changed.has(file));
  if (filesToCommit.length === 0) return;
  await git(worktree, ["add", "--", ...filesToCommit]);
  await git(worktree, ["commit", "--only", "-m", message, "--", ...filesToCommit]);
}

async function changedPaths(worktree) {
  const outputs = await Promise.all([
    git(worktree, ["diff", "--name-only"]),
    git(worktree, ["diff", "--cached", "--name-only"]),
    git(worktree, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  return [...new Set(outputs.flatMap((output) => output ? output.split("\n") : []))];
}

async function executionRecordFiles({ mainWorktree, featureSlug, executionPlan }) {
  const issueTracker = createIssueTracker({ mainWorktree, executionPlan });
  return [executionPlanPath(featureSlug), checkpointPath(featureSlug), ...await issueTracker.paths()];
}

async function unexpectedMainWorktreeChanges({ mainWorktree, featureSlug, executionPlan }) {
  const allowed = new Set(await executionRecordFiles({ mainWorktree, featureSlug, executionPlan }));
  return (await changedPaths(mainWorktree)).filter((path) => !allowed.has(path));
}

async function commitExecutionRecords({ mainWorktree, featureSlug, executionPlan, generateCommitMessage }) {
  if (!generateCommitMessage) throw new Error("A git-commit message generator is required");
  const files = await executionRecordFiles({ mainWorktree, featureSlug, executionPlan });
  const message = await generateCommitMessage({ mainWorktree, featureSlug, executionPlan, files });
  if (typeof message !== "string" || message.trim() === "") throw new Error("A non-empty execution record commit message is required");
  await commitFiles(mainWorktree, files, message);
}

async function executionRecordsHaveChanges({ mainWorktree, featureSlug, executionPlan }) {
  const files = new Set(await executionRecordFiles({ mainWorktree, featureSlug, executionPlan }));
  return (await changedPaths(mainWorktree)).some((path) => files.has(path));
}

async function assertResultCommits(worktree, result, ticket) {
  for (const commit of result.commits) {
    if (!await gitSucceeds(worktree, ["rev-parse", "--verify", `${commit}^{commit}`])) {
      throw new Error(`Completion result commit does not exist: ${commit}`);
    }
    if (!await isAncestor(worktree, commit)) {
      throw new Error(`Completion result commit is not on the execution branch: ${commit}`);
    }
    if (commit === ticket.start_commit || !await isAncestor(worktree, ticket.start_commit, commit)) {
      throw new Error(`Completion result commit must be after ticket ${ticket.id} start commit: ${commit}`);
    }
  }
}

function verifiedExecutionPlan(executionPlan, integrity) {
  if (executionPlan && executionPlan.revision !== integrity.executionPlan.revision) {
    throw new Error("Provided execution plan does not match the verified persisted execution plan");
  }
  return integrity.executionPlan;
}

export function createExecutionOrchestrator({ adapter, directExecutor, materialize = materializeSpec, now = toShanghaiTimestamp, generateCommitMessage, checkpointWriter = writeCheckpointToDisk } = {}) {
  const stash = createPreMergeStash({ git, gitSucceeds, gitOutput, gitSucceedsWithInput });

  const requireIntegrity = async ({ mainWorktree, featureSlug, executionWorktree, checkExecutionWorktree = true, allowWorktreeRelocation = false }) => {
    return requireCheckpointIntegrity({ worktree: mainWorktree, executionWorktree, featureSlug, checkExecutionWorktree, allowWorktreeRelocation });
  };

  const persist = async (worktree, featureSlug, checkpoint, { verify = true } = {}) => {
    if (verify) await requireIntegrity({ mainWorktree: worktree, featureSlug, checkExecutionWorktree: false });
    await checkpointWriter(worktree, featureSlug, checkpoint);
    return checkpoint;
  };

  const integrationLifecycle = createIntegrationLifecycle({
    now,
    newStashOperationId: randomUUID,
    requireIntegrity,
    persist,
    stash,
    executionRecordsHaveChanges,
    commitExecutionRecords: ({ mainWorktree, featureSlug, executionPlan }) => commitExecutionRecords({ mainWorktree, featureSlug, executionPlan, generateCommitMessage }),
    findMainWorktree,
    worktreeIsClean,
    currentHead,
    isAncestor,
    findExecutionWorktree,
    removeExecutionWorktree,
    readCheckpoint,
    git,
    gitSucceeds,
    unexpectedMainWorktreeChanges,
  });

  return {
    async initialize({ repository, branch, baseline, worktreePath, specPath }) {
      baseline ??= await currentHead(repository);
      const mainWorktree = await findMainWorktree(repository);
      if (!mainWorktree) throw new Error("Main worktree is unavailable");
      deriveSpecLocation(mainWorktree, specPath);
      const executionPlan = await materialize({ mainWorktree, specPath });
      verifyExecutionPlan(executionPlan);
      await assertSpecArtifactsInMainWorktree({ mainWorktree, executionPlan });
      const worktree = await createExecutionWorktree({ repository, branch, baseline, path: worktreePath });
      await writeExecutionPlan(mainWorktree, executionPlan);
      const checkpoint = createCheckpoint({ executionPlan, baseline, branch, worktree, now: now() });
      await persist(mainWorktree, executionPlan.spec.feature_slug, checkpoint, { verify: false });
      return { worktree, mainWorktree, executionPlan, checkpoint };
    },

    async resume({ repository, branch, specPath, worktreePath }) {
      const mainWorktree = await findMainWorktree(repository);
      if (!mainWorktree) throw new Error("Main worktree is unavailable");
      const { featureSlug } = deriveSpecLocation(mainWorktree, specPath);
      const preflight = await requireIntegrity({ mainWorktree, featureSlug, checkExecutionWorktree: false });
      const mainCheckpoint = preflight.checkpoint;
      if (mainCheckpoint.integration.status === "done") {
        const executionPlan = preflight.executionPlan;
        if (await executionRecordsHaveChanges({ mainWorktree, featureSlug, executionPlan })) {
          await requireIntegrity({ mainWorktree, featureSlug });
          await commitExecutionRecords({ mainWorktree, featureSlug, executionPlan, generateCommitMessage });
        }
        return { ...preflight, status: "complete", worktree: mainWorktree };
      }
      if (mainCheckpoint.integration.status === "merged") {
        return this.completeMergedCleanup({ repository, mainWorktree, featureSlug, executionPlan: preflight.executionPlan, checkpoint: mainCheckpoint });
      }
      if (mainCheckpoint.status === "integrating" && await isAncestor(mainWorktree, branch)) {
        let checkpointForMerge = mainCheckpoint;
        if (checkpointForMerge.integration.stash_operation_id && !checkpointForMerge.integration.stash_ref) {
          const stashRef = await stash.locate(mainWorktree, featureSlug, checkpointForMerge.integration.stash_operation_id);
          if (!stashRef) throw new Error("Recorded pre-merge stash operation has no recoverable stash reference");
          checkpointForMerge = recordStashReference(checkpointForMerge, stashRef, now());
          await persist(mainWorktree, featureSlug, checkpointForMerge);
        }
        const merged = markMerged(checkpointForMerge, { executionHead: await git(mainWorktree, ["rev-parse", branch]), mainWorktree, mergedCommit: await currentHead(mainWorktree), stashRef: checkpointForMerge.integration.stash_ref }, now());
        await persist(mainWorktree, featureSlug, merged);
        return this.completeMergedCleanup({ repository, mainWorktree, featureSlug, executionPlan: preflight.executionPlan, checkpoint: merged });
      }
      const executionPlan = preflight.executionPlan;
      await assertSpecArtifactsInMainWorktree({ mainWorktree, executionPlan });
      const ensured = await ensureExecutionWorktree({ repository, branch, path: worktreePath });
      let checkpoint = mainCheckpoint;
      const integrity = await requireIntegrity({ mainWorktree, executionWorktree: ensured.worktree, featureSlug, allowWorktreeRelocation: true });
      if (checkpoint.worktree !== ensured.worktree) {
        checkpoint = relocateCheckpoint(checkpoint, ensured.worktree, now());
        await persist(mainWorktree, featureSlug, checkpoint);
      }
      return { ...integrity, status: "resumed", worktree: ensured.worktree, mainWorktree, executionPlan, checkpoint };
    },

    async executeFrontier({ worktree, mainWorktree, featureSlug, executionPlan, checkpoint, readTicket }) {
      const integrity = await requireIntegrity({ mainWorktree, featureSlug, executionWorktree: worktree });
      checkpoint = integrity.checkpoint;
      executionPlan = verifiedExecutionPlan(executionPlan, integrity);
      readTicket ??= createIssueTracker({ mainWorktree, executionPlan }).read.bind(null);
      const selection = selectTicketFrontier({ executionPlan, checkpoint });
      if (selection.status === "blocked") return { status: "blocked", checkpoint, results: [], ...(selection.reason ? { reason: selection.reason } : {}) };
      const [ticket] = selection.tickets;
      if (executionPlan.execution_mode === "orchestrator") {
        if (!directExecutor) throw new Error("A direct executor is required for orchestrator execution");
      }
      checkpoint = startTickets(checkpoint, [ticket.id], await currentHead(worktree), now());
      await persist(mainWorktree, featureSlug, checkpoint);
      let rawResult;
      if (executionPlan.execution_mode === "orchestrator") {
        try {
          rawResult = await directExecutor({ task: ticket, worktree, executionPlan, readTicket });
        } catch (error) {
          rawResult = { ticket_id: ticket.id, status: "blocked", commits: [], tests: [], summary: "Orchestrator execution failed", error: error instanceof Error ? error.message : String(error) };
        }
      } else {
        if (!adapter) throw new Error("Completion adapter is required to execute a ticket");
        rawResult = await adapter.executeTicket({ ticket, worktree });
      }
      const result = assertCompletionResult(rawResult);
      if (result.ticket_id !== ticket.id) throw new Error(`Completion result belongs to ${result.ticket_id}, expected ${ticket.id}`);
      if (result.status === "done") {
        const ticketState = checkpoint.tickets.find((state) => state.id === ticket.id);
        await assertResultCommits(worktree, result, ticketState);
        checkpoint = completeTicket(checkpoint, ticket.id, result.commits.at(-1), now());
      } else {
        checkpoint = blockTicket(checkpoint, ticket.id, result.error, now());
      }
      await persist(mainWorktree, featureSlug, checkpoint);
      if (result.status === "done") {
        await requireIntegrity({ mainWorktree, featureSlug, executionWorktree: worktree });
        const issueTracker = createIssueTracker({ mainWorktree, executionPlan });
        await issueTracker.markComplete(ticket.id);
      }
      return { checkpoint, results: [result] };
    },

    async startReview({ mainWorktree, featureSlug, checkpoint }) {
      checkpoint = (await requireIntegrity({ mainWorktree, featureSlug, checkExecutionWorktree: false })).checkpoint;
      return persist(mainWorktree, featureSlug, beginReview(checkpoint, now()));
    },

    async finishReview({ mainWorktree, featureSlug, checkpoint, findingsSummary }) {
      checkpoint = (await requireIntegrity({ mainWorktree, featureSlug, checkExecutionWorktree: false })).checkpoint;
      return persist(mainWorktree, featureSlug, completeReview(checkpoint, findingsSummary, now()));
    },

    async run({ repository, branch, specPath, worktreePath, review }) {
      if (!specPath) throw new Error("A canonical specPath is required to initialize or resume an execution");
      let execution;
      if (await gitSucceeds(repository, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) {
        execution = await this.resume({ repository, branch, specPath, worktreePath });
      } else {
        execution = await this.initialize({ repository, branch, worktreePath, specPath });
        execution.status = "initialized";
      }
      if (execution.status === "complete") return execution;
      let { worktree, mainWorktree, executionPlan, checkpoint } = execution;
      const featureSlug = executionPlan.spec.feature_slug;
      const issueTracker = createIssueTracker({ mainWorktree, executionPlan });
      const readTicket = issueTracker.read.bind(issueTracker);
      if (checkpoint.status === "executing" && checkpoint.tickets.every((ticket) => ticket.status === "done")) {
        for (const ticket of checkpoint.tickets) await issueTracker.markComplete(ticket.id);
        checkpoint = await this.startReview({ mainWorktree, featureSlug, checkpoint });
      }
      while (checkpoint.status === "executing") {
        const result = await this.executeFrontier({ worktree, mainWorktree, featureSlug, executionPlan, checkpoint, readTicket });
        if (result.status === "blocked") return result;
        checkpoint = result.checkpoint;
        if (checkpoint.tickets.every((ticket) => ticket.status === "done")) checkpoint = await this.startReview({ mainWorktree, featureSlug, checkpoint });
      }
      if (checkpoint.status === "reviewing") {
        if (!review) return { status: "reviewing", worktree, executionPlan, checkpoint };
        const reviewResult = await review({ worktree, executionPlan, checkpoint, readTicket });
        if (reviewResult?.approved !== true || !reviewResult.findingsSummary) return { status: "reviewing", worktree, executionPlan, checkpoint };
        checkpoint = await this.finishReview({ mainWorktree, featureSlug, checkpoint, findingsSummary: reviewResult.findingsSummary });
      }
      if (checkpoint.status === "integrating") return this.integrate({ repository, worktree, featureSlug, executionPlan, checkpoint });
      return { status: checkpoint.status, worktree, executionPlan, checkpoint };
    },

    async integrate(args) {
      return integrationLifecycle.integrate(args);
    },

    async completeMergedCleanup(args) {
      return integrationLifecycle.completeMergedCleanup(args);
    },
  };
}
