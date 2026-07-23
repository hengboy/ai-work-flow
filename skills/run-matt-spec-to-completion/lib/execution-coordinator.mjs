import { randomUUID } from "node:crypto";
import { checkpointPath, deriveSpecLocation, executionPlanPath } from "./paths.mjs";
import { beginReview, beginStashOperation, beginStashRestoration, blockTicket, clearRestoredStashReference, completeIntegration, completeReview, completeTicket, createCheckpoint, markMerged, markRestoredStashDropped, markStashRestored, readCheckpoint, recordStashReference, relocateCheckpoint, startTickets, writeCheckpoint as writeCheckpointToDisk } from "./checkpoint.mjs";
import { verifyCheckpointIntegrity } from "./checkpoint-integrity.mjs";
import { currentHead, git, gitOutput, gitSucceeds, gitSucceedsWithInput, isAncestor } from "./git.mjs";
import { assertSpecArtifactsInMainWorktree, materializeSpec, readExecutionPlan, verifyExecutionPlan, writeExecutionPlan } from "./spec-intake.mjs";
import { createIssueTracker } from "./issue-tracker.mjs";
import { assertCompletionResult } from "./validation.mjs";
import { toShanghaiTimestamp } from "./time.mjs";
import { createExecutionWorktree, ensureExecutionWorktree, findExecutionWorktree, findMainWorktree, removeExecutionWorktree, worktreeIsClean } from "./worktree-lifecycle.mjs";
import { createPreMergeStash } from "./pre-merge-stash.mjs";

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

async function assertResultCommits(worktree, result) {
  for (const commit of result.commits) {
    if (!await gitSucceeds(worktree, ["rev-parse", "--verify", `${commit}^{commit}`])) {
      throw new Error(`Completion result commit does not exist: ${commit}`);
    }
    if (!await isAncestor(worktree, commit)) {
      throw new Error(`Completion result commit is not on the execution branch: ${commit}`);
    }
  }
}

export function createExecutionCoordinator({ adapter, directExecutor, materialize = materializeSpec, now = toShanghaiTimestamp, generateCommitMessage, checkpointWriter = writeCheckpointToDisk } = {}) {
  const stash = createPreMergeStash({ git, gitSucceeds, gitOutput, gitSucceedsWithInput });

  const requireIntegrity = async ({ mainWorktree, featureSlug, executionWorktree, checkExecutionWorktree = true, allowWorktreeRelocation = false }) => {
    const integrity = await verifyCheckpointIntegrity({ worktree: mainWorktree, executionWorktree, featureSlug, checkExecutionWorktree, allowWorktreeRelocation });
    if (integrity.status !== "valid") throw new Error(`Checkpoint integrity failed: ${JSON.stringify(integrity.diagnostics)}`);
    return integrity;
  };

  const persist = async (worktree, featureSlug, checkpoint, { verify = true } = {}) => {
    if (verify) await requireIntegrity({ mainWorktree: worktree, featureSlug, checkExecutionWorktree: false });
    await checkpointWriter(worktree, featureSlug, checkpoint);
    return checkpoint;
  };

  const reconcileRestoredStash = async ({ mainWorktree, featureSlug, checkpoint }) => {
    if (checkpoint.integration.stash_restore_state !== "restored" || checkpoint.integration.stash_cleanup_state === "dropped") return checkpoint;
    const reference = checkpoint.integration.stash_ref;
    if (!reference) throw new Error("Checkpoint does not identify a restored stash to clean up");
    const { listed, applied } = await stash.reconcile(mainWorktree, reference);
    if (listed) {
      await requireIntegrity({ mainWorktree, featureSlug, checkExecutionWorktree: false });
      await stash.drop(mainWorktree, reference);
    } else if (!applied) {
      throw new Error(`Could not reconcile restored stash ${reference}; it is unavailable and its patch is not present`);
    }
    checkpoint = markRestoredStashDropped(checkpoint, now());
    await persist(mainWorktree, featureSlug, checkpoint);
    return checkpoint;
  };

  const restoreRecordedStash = async ({ mainWorktree, featureSlug, executionPlan, checkpoint }) => {
    if (!checkpoint.integration.stash_ref) throw new Error("Checkpoint does not identify a stash to restore");
    if (checkpoint.integration.stash_restore_state === "restored") return checkpoint;
    if (checkpoint.integration.stash_restore_state === "applying") {
      if ((await unexpectedMainWorktreeChanges({ mainWorktree, featureSlug, executionPlan })).length === 0) {
        const { stash_restore_state, ...integration } = checkpoint.integration;
        checkpoint = beginStashRestoration({
          ...checkpoint,
          integration,
        }, now());
      } else {
        const { applied } = await stash.reconcile(mainWorktree, checkpoint.integration.stash_ref);
        if (applied) {
          checkpoint = markStashRestored(checkpoint, now());
          await persist(mainWorktree, featureSlug, checkpoint);
          return checkpoint;
        }
        throw new Error(`Stash ${checkpoint.integration.stash_ref} restoration is ambiguous; resolve the worktree manually without dropping the stash`);
      }
    } else {
      checkpoint = beginStashRestoration(checkpoint, now());
    }
    await persist(mainWorktree, featureSlug, checkpoint);
    await stash.restore(mainWorktree, checkpoint.integration.stash_ref);
    checkpoint = markStashRestored(checkpoint, now());
    await persist(mainWorktree, featureSlug, checkpoint);
    return checkpoint;
  };

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
      try {
        const mainCheckpoint = await readCheckpoint(mainWorktree, featureSlug);
        const preflight = await verifyCheckpointIntegrity({ worktree: mainWorktree, featureSlug, checkExecutionWorktree: false });
        if (preflight.status !== "valid") throw new Error(`Checkpoint integrity failed: ${JSON.stringify(preflight.diagnostics)}`);
        if (mainCheckpoint.integration.status === "done") {
          const executionPlan = await readExecutionPlan(mainWorktree, featureSlug);
          const integrity = await verifyCheckpointIntegrity({ worktree: mainWorktree, featureSlug });
          if (integrity.status !== "valid") throw new Error(JSON.stringify(integrity.diagnostics));
          if (await executionRecordsHaveChanges({ mainWorktree, featureSlug, executionPlan })) {
            await requireIntegrity({ mainWorktree, featureSlug });
            await commitExecutionRecords({ mainWorktree, featureSlug, executionPlan, generateCommitMessage });
          }
          return { ...integrity, status: "complete", worktree: mainWorktree };
        }
        if (mainCheckpoint.integration.status === "merged") {
          return this.completeMergedCleanup({ repository, mainWorktree, featureSlug, executionPlan: await readExecutionPlan(mainWorktree, featureSlug), checkpoint: mainCheckpoint });
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
          return this.completeMergedCleanup({ repository, mainWorktree, featureSlug, executionPlan: await readExecutionPlan(mainWorktree, featureSlug), checkpoint: merged });
        }
      } catch (error) {
        if (!String(error.message).includes("ENOENT")) throw error;
      }
      const executionPlan = await readExecutionPlan(mainWorktree, featureSlug);
      await assertSpecArtifactsInMainWorktree({ mainWorktree, executionPlan });
      const ensured = await ensureExecutionWorktree({ repository, branch, path: worktreePath });
      let checkpoint = await readCheckpoint(mainWorktree, featureSlug);
      const integrity = await verifyCheckpointIntegrity({ worktree: mainWorktree, executionWorktree: ensured.worktree, featureSlug, allowWorktreeRelocation: true });
      if (integrity.status !== "valid") throw new Error(`Checkpoint integrity failed: ${JSON.stringify(integrity.diagnostics)}`);
      if (checkpoint.worktree !== ensured.worktree) {
        checkpoint = relocateCheckpoint(checkpoint, ensured.worktree, now());
        await persist(mainWorktree, featureSlug, checkpoint);
      }
      return { ...integrity, status: "resumed", worktree: ensured.worktree, mainWorktree, executionPlan, checkpoint };
    },

    async executeFrontier({ worktree, mainWorktree, featureSlug, executionPlan, checkpoint, readTicket = createIssueTracker({ mainWorktree, executionPlan }).read.bind(null) }) {
      checkpoint = (await requireIntegrity({ mainWorktree, featureSlug, executionWorktree: worktree })).checkpoint;
      if (checkpoint.tickets.some((task) => task.status === "blocked")) return { status: "blocked", checkpoint, results: [] };
      if (checkpoint.tickets.some((task) => task.status === "in_progress")) {
        return { status: "blocked", checkpoint, results: [], reason: "A ticket is still in progress; confirm its worker has stopped before recovery" };
      }
      const unfinished = executionPlan.tickets.filter((task) => checkpoint.tickets.find((state) => state.id === task.id)?.status !== "done");
      if (unfinished.length === 0) throw new Error("No unfinished ticket remains");
      const activeLevel = Math.min(...unfinished.map((task) => task.level));
      const frontier = executionPlan.tickets.filter((task) => task.level === activeLevel && checkpoint.tickets.find((state) => state.id === task.id)?.status === "pending").sort((left, right) => left.id.localeCompare(right.id)).slice(0, 1);
      if (executionPlan.execution_mode === "coordinator") {
        if (!directExecutor) throw new Error("A direct executor is required for coordinator execution");
        if (frontier.length !== 1) throw new Error("Single-ticket execution requires exactly one active ticket");
      }
      const pending = frontier;
      if (pending.length > 0) {
        checkpoint = startTickets(checkpoint, pending.map((task) => task.id), await currentHead(worktree), now());
        await persist(mainWorktree, featureSlug, checkpoint);
      }
      let rawResults;
      if (executionPlan.execution_mode === "coordinator") {
        try {
          rawResults = [await directExecutor({ task: frontier[0], worktree, executionPlan, readTicket })];
        } catch (error) {
          rawResults = [{ task_id: frontier[0].id, status: "blocked", commits: [], tests: [], summary: "Coordinator execution failed", error: error instanceof Error ? error.message : String(error) }];
        }
      } else {
        if (!adapter) throw new Error("Completion adapter is required to execute a frontier");
        rawResults = await adapter.executeFrontier({ tasks: frontier, worktree });
      }
      if (!Array.isArray(rawResults)) throw new Error("Completion adapter must return an array of completion results");
      const results = rawResults.map(assertCompletionResult);
      const byTask = new Map(results.map((result) => [result.ticket_id, result]));
      for (const task of frontier) {
        const result = byTask.get(task.id);
        if (!result) checkpoint = blockTicket(checkpoint, task.id, "Completion adapter omitted this task", now());
        else if (result.status === "done") {
          await assertResultCommits(worktree, result);
          checkpoint = completeTicket(checkpoint, task.id, result.commits.at(-1), now());
        } else checkpoint = blockTicket(checkpoint, task.id, result.error, now());
        await persist(mainWorktree, featureSlug, checkpoint);
        if (result?.status === "done") {
          await requireIntegrity({ mainWorktree, featureSlug, executionWorktree: worktree });
          const issueTracker = createIssueTracker({ mainWorktree, executionPlan });
          await issueTracker.markComplete(task.id);
        }
      }
      return { checkpoint, results };
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

    async integrate({ repository, worktree, featureSlug, executionPlan, checkpoint }) {
      const mainWorktree = await findMainWorktree(repository);
      if (!mainWorktree) throw new Error("Main worktree is unavailable");
      let integrationCheckpoint = (await requireIntegrity({ mainWorktree, featureSlug, executionWorktree: worktree })).checkpoint;
      if (integrationCheckpoint.status !== "integrating") throw new Error("Checkpoint is not ready for integration");
      if (!await worktreeIsClean(worktree)) throw new Error("Execution worktree is not clean");
      if (integrationCheckpoint.integration.stash_restore_state === "applying") {
        integrationCheckpoint = await restoreRecordedStash({ mainWorktree, featureSlug, executionPlan, checkpoint: integrationCheckpoint });
      }
      if (integrationCheckpoint.integration.stash_restore_state === "restored" && integrationCheckpoint.integration.status === "pending") {
        integrationCheckpoint = await reconcileRestoredStash({ mainWorktree, featureSlug, checkpoint: integrationCheckpoint });
        integrationCheckpoint = clearRestoredStashReference(integrationCheckpoint, now());
        await persist(mainWorktree, featureSlug, integrationCheckpoint);
      }
      let stashRef = integrationCheckpoint.integration.stash_ref;
      if (!stashRef && integrationCheckpoint.integration.stash_operation_id) {
        stashRef = await stash.locate(mainWorktree, featureSlug, integrationCheckpoint.integration.stash_operation_id);
        if (!stashRef) throw new Error("Recorded pre-merge stash operation has no recoverable stash reference");
        integrationCheckpoint = recordStashReference(integrationCheckpoint, stashRef, now());
        await persist(mainWorktree, featureSlug, integrationCheckpoint);
      }
      if (stashRef) {
        if (!await gitSucceeds(mainWorktree, ["rev-parse", "--verify", `${stashRef}^{commit}`])) {
          throw new Error(`Checkpoint requires stash ${stashRef}, but that stash is unavailable`);
        }
      } else {
        const paths = await unexpectedMainWorktreeChanges({ mainWorktree, featureSlug, executionPlan });
        if (paths.length > 0) {
          if (!integrationCheckpoint.integration.stash_operation_id) {
            integrationCheckpoint = beginStashOperation(integrationCheckpoint, randomUUID(), now());
            await persist(mainWorktree, featureSlug, integrationCheckpoint);
          }
          stashRef = await stash.locate(mainWorktree, featureSlug, integrationCheckpoint.integration.stash_operation_id);
          if (!stashRef) {
            await requireIntegrity({ mainWorktree, featureSlug, executionWorktree: worktree });
            stashRef = await stash.save(mainWorktree, paths, featureSlug, integrationCheckpoint.integration.stash_operation_id);
          }
          if (!stashRef) throw new Error("Could not create the pre-merge stash; resume will retry the recorded stash operation");
          integrationCheckpoint = recordStashReference(integrationCheckpoint, stashRef, now());
          await persist(mainWorktree, featureSlug, integrationCheckpoint);
        }
      }
      let mergeApplied = false;
      try {
        const executionHead = await currentHead(worktree);
        await requireIntegrity({ mainWorktree, featureSlug, executionWorktree: worktree });
        await git(mainWorktree, ["merge", "--no-edit", integrationCheckpoint.branch]);
        mergeApplied = true;
        if (!await isAncestor(mainWorktree, executionHead)) throw new Error("Merged main does not contain execution HEAD");
        const mainCheckpoint = await readCheckpoint(mainWorktree, featureSlug);
        const merged = markMerged(mainCheckpoint, { executionHead, mainWorktree, mergedCommit: await currentHead(mainWorktree), stashRef }, now());
        await persist(mainWorktree, featureSlug, merged);
        return this.completeMergedCleanup({ repository, mainWorktree, featureSlug, executionPlan, checkpoint: merged });
      } catch (error) {
        if (mergeApplied) throw error;
        await gitSucceeds(mainWorktree, ["merge", "--abort"]);
        if (stashRef) {
          try {
            const restored = await restoreRecordedStash({ mainWorktree, featureSlug, executionPlan, checkpoint: integrationCheckpoint });
            const reconciled = await reconcileRestoredStash({ mainWorktree, featureSlug, checkpoint: restored });
            await persist(mainWorktree, featureSlug, clearRestoredStashReference(reconciled, now()));
          } catch (restoreError) {
            throw new Error(`${error.message}; ${restoreError.message}`, { cause: restoreError });
          }
        }
        throw error;
      }
    },

    async completeMergedCleanup({ repository, mainWorktree, featureSlug, executionPlan, checkpoint }) {
      if (checkpoint.integration.status === "done") {
        const integrity = await verifyCheckpointIntegrity({ worktree: mainWorktree, featureSlug });
        if (integrity.status !== "valid") throw new Error(`Checkpoint integrity failed: ${JSON.stringify(integrity.diagnostics)}`);
        if (await executionRecordsHaveChanges({ mainWorktree, featureSlug, executionPlan })) {
          await requireIntegrity({ mainWorktree, featureSlug });
          await commitExecutionRecords({ mainWorktree, featureSlug, executionPlan, generateCommitMessage });
        }
        return { status: "complete", worktree: mainWorktree, checkpoint };
      }
      if (checkpoint.integration.status !== "merged") throw new Error("Checkpoint is not ready for merged cleanup");
      checkpoint = (await requireIntegrity({ mainWorktree, featureSlug })).checkpoint;
      if (checkpoint.integration.status !== "merged") throw new Error("Checkpoint is not ready for merged cleanup");
      if (checkpoint.integration.stash_operation_id && !checkpoint.integration.stash_ref) {
        throw new Error("Recorded pre-merge stash operation has no recoverable stash reference");
      }
      if (checkpoint.integration.stash_ref && checkpoint.integration.stash_restore_state !== "restored" && !await gitSucceeds(mainWorktree, ["rev-parse", "--verify", `${checkpoint.integration.stash_ref}^{commit}`])) {
        throw new Error(`Checkpoint requires stash ${checkpoint.integration.stash_ref}, but that stash is unavailable`);
      }
      const executionWorktree = await findExecutionWorktree(repository, checkpoint.branch);
      if (executionWorktree) {
        await requireIntegrity({ mainWorktree, featureSlug });
        await removeExecutionWorktree({ repository, worktree: executionWorktree });
      }
      if (checkpoint.integration.stash_ref && checkpoint.integration.stash_restore_state !== "restored") {
        await requireIntegrity({ mainWorktree, featureSlug });
        await git(mainWorktree, ["reset"]);
        checkpoint = await restoreRecordedStash({ mainWorktree, featureSlug, executionPlan, checkpoint });
      }
      checkpoint = await reconcileRestoredStash({ mainWorktree, featureSlug, checkpoint });
      await requireIntegrity({ mainWorktree, featureSlug });
      const complete = completeIntegration(checkpoint, now());
      await persist(mainWorktree, featureSlug, complete);
      try {
        await requireIntegrity({ mainWorktree, featureSlug });
        await commitExecutionRecords({ mainWorktree, featureSlug, executionPlan, generateCommitMessage });
      } catch (error) {
        await persist(mainWorktree, featureSlug, checkpoint);
        throw error;
      }
      return { status: "complete", worktree: mainWorktree, checkpoint: complete };
    },
  };
}
