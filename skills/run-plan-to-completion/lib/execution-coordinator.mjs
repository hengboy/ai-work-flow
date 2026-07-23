import { randomUUID } from "node:crypto";
import { checkpointPath, derivePlanLocation, executionPlanPath } from "./paths.mjs";
import { beginReview, beginStashOperation, beginStashRestoration, blockTask, clearRestoredStashReference, completeIntegration, completeReview, completeTask, createCheckpoint, markMerged, markRestoredStashDropped, markStashRestored, readCheckpoint, recordStashReference, relocateCheckpoint, startTasks, writeCheckpoint as writeCheckpointToDisk } from "./checkpoint.mjs";
import { verifyCheckpointIntegrity } from "./checkpoint-integrity.mjs";
import { currentHead, git, gitOutput, gitSucceeds, gitSucceedsWithInput, isAncestor } from "./git.mjs";
import { assertPlanArtifactsInMainWorktree, createTaskReader, localTaskPaths, materializeLocalPlan, markLocalTaskComplete, readExecutionPlan, verifyExecutionPlan, writeExecutionPlan } from "./execution-plan.mjs";
import { assertCompletionResult } from "./validation.mjs";
import { toShanghaiTimestamp } from "./time.mjs";
import { createExecutionWorktree, ensureExecutionWorktree, findExecutionWorktree, findMainWorktree, removeExecutionWorktree, worktreeIsClean } from "./worktree-lifecycle.mjs";

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

async function executionRecordFiles({ mainWorktree, planId, executionPlan }) {
  return [executionPlanPath(planId), checkpointPath(planId), ...await localTaskPaths({ mainWorktree, executionPlan })];
}

async function unexpectedMainWorktreeChanges({ mainWorktree, planId, executionPlan }) {
  const allowed = new Set(await executionRecordFiles({ mainWorktree, planId, executionPlan }));
  return (await changedPaths(mainWorktree)).filter((path) => !allowed.has(path));
}

function stashMessage(planId, operationId) {
  return `run-plan-to-completion:${planId}:${operationId}`;
}

async function stashChanges(worktree, paths, planId, operationId) {
  if (paths.length === 0) return null;
  const previous = await gitSucceeds(worktree, ["rev-parse", "--verify", "refs/stash"])
    ? await git(worktree, ["rev-parse", "refs/stash"])
    : null;
  await git(worktree, ["stash", "push", "--include-untracked", "--message", stashMessage(planId, operationId), "--", ...paths]);
  const reference = await gitSucceeds(worktree, ["rev-parse", "--verify", "refs/stash"])
    ? await git(worktree, ["rev-parse", "refs/stash"])
    : null;
  if (!reference || reference === previous) return null;
  return reference;
}

async function findStashForOperation(worktree, planId, operationId) {
  const message = stashMessage(planId, operationId);
  const references = (await git(worktree, ["stash", "list", "--format=%H"])).split("\n").filter(Boolean);
  for (const reference of references) {
    if ((await git(worktree, ["log", "-1", "--format=%B", reference])).includes(message)) return reference;
  }
  return null;
}

async function restoreStashedChanges(worktree, reference) {
  if (!reference) throw new Error("Checkpoint does not identify a stash to restore");
  if (!await gitSucceeds(worktree, ["rev-parse", "--verify", `${reference}^{commit}`])) {
    throw new Error(`Checkpoint requires stash ${reference}, but that stash is unavailable`);
  }
  try {
    await git(worktree, ["stash", "apply", "--index", reference]);
  } catch (error) {
    throw new Error(`Could not restore unrelated main worktree changes from stash ${reference}; resolve them manually`, { cause: error });
  }
}

async function dropRestoredStash(worktree, reference) {
  if (await git(worktree, ["rev-parse", "refs/stash"]) !== reference) {
    throw new Error(`Could not remove restored stash ${reference}; it is no longer the top stash`);
  }
  await git(worktree, ["stash", "drop", "stash@{0}"]);
}

async function stashIsListed(worktree, reference) {
  return (await git(worktree, ["stash", "list", "--format=%H"])).split("\n").includes(reference);
}

async function stashPatchIsApplied(worktree, reference) {
  const patch = await gitOutput(worktree, ["stash", "show", "--include-untracked", "--patch", reference]);
  return patch !== "" && gitSucceedsWithInput(worktree, ["apply", "--reverse", "--check"], patch);
}

async function commitExecutionRecords({ mainWorktree, planId, executionPlan, generateCommitMessage }) {
  if (!generateCommitMessage) throw new Error("A git-commit message generator is required");
  const files = await executionRecordFiles({ mainWorktree, planId, executionPlan });
  const message = await generateCommitMessage({ mainWorktree, planId, executionPlan, files });
  if (typeof message !== "string" || message.trim() === "") throw new Error("A non-empty execution record commit message is required");
  await commitFiles(mainWorktree, files, message);
}

async function executionRecordsHaveChanges({ mainWorktree, planId, executionPlan }) {
  const files = new Set(await executionRecordFiles({ mainWorktree, planId, executionPlan }));
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

export function createExecutionCoordinator({ adapter, directExecutor, materialize = materializeLocalPlan, now = toShanghaiTimestamp, generateCommitMessage, checkpointWriter = writeCheckpointToDisk } = {}) {
  const requireIntegrity = async ({ mainWorktree, planId, executionWorktree, checkExecutionWorktree = true, allowWorktreeRelocation = false }) => {
    const integrity = await verifyCheckpointIntegrity({ worktree: mainWorktree, executionWorktree, planId, checkExecutionWorktree, allowWorktreeRelocation });
    if (integrity.status !== "valid") throw new Error(`Checkpoint integrity failed: ${JSON.stringify(integrity.diagnostics)}`);
    return integrity;
  };

  const persist = async (worktree, planId, checkpoint, { verify = true } = {}) => {
    if (verify) await requireIntegrity({ mainWorktree: worktree, planId, checkExecutionWorktree: false });
    await checkpointWriter(worktree, planId, checkpoint);
    return checkpoint;
  };

  const reconcileRestoredStash = async ({ mainWorktree, planId, checkpoint }) => {
    if (checkpoint.integration.stash_restore_state !== "restored" || checkpoint.integration.stash_cleanup_state === "dropped") return checkpoint;
    const reference = checkpoint.integration.stash_ref;
    if (!reference) throw new Error("Checkpoint does not identify a restored stash to clean up");
    if (await stashIsListed(mainWorktree, reference)) {
      await requireIntegrity({ mainWorktree, planId, checkExecutionWorktree: false });
      await dropRestoredStash(mainWorktree, reference);
    } else if (!await stashPatchIsApplied(mainWorktree, reference)) {
      throw new Error(`Could not reconcile restored stash ${reference}; it is unavailable and its patch is not present`);
    }
    checkpoint = markRestoredStashDropped(checkpoint, now());
    await persist(mainWorktree, planId, checkpoint);
    return checkpoint;
  };

  const restoreRecordedStash = async ({ mainWorktree, planId, executionPlan, checkpoint }) => {
    if (!checkpoint.integration.stash_ref) throw new Error("Checkpoint does not identify a stash to restore");
    if (checkpoint.integration.stash_restore_state === "restored") return checkpoint;
    if (checkpoint.integration.stash_restore_state === "applying") {
      if ((await unexpectedMainWorktreeChanges({ mainWorktree, planId, executionPlan })).length === 0) {
        const { stash_restore_state, ...integration } = checkpoint.integration;
        checkpoint = beginStashRestoration({
          ...checkpoint,
          integration,
        }, now());
      } else if (await stashPatchIsApplied(mainWorktree, checkpoint.integration.stash_ref)) {
        checkpoint = markStashRestored(checkpoint, now());
        await persist(mainWorktree, planId, checkpoint);
        return checkpoint;
      } else {
        throw new Error(`Stash ${checkpoint.integration.stash_ref} restoration is ambiguous; resolve the worktree manually without dropping the stash`);
      }
    } else {
      checkpoint = beginStashRestoration(checkpoint, now());
    }
    await persist(mainWorktree, planId, checkpoint);
    await restoreStashedChanges(mainWorktree, checkpoint.integration.stash_ref);
    checkpoint = markStashRestored(checkpoint, now());
    await persist(mainWorktree, planId, checkpoint);
    return checkpoint;
  };

  return {
    async initialize({ repository, branch, baseline, worktreePath, planPath }) {
      baseline ??= await currentHead(repository);
      const mainWorktree = await findMainWorktree(repository);
      if (!mainWorktree) throw new Error("Main worktree is unavailable");
      derivePlanLocation(mainWorktree, planPath);
      const executionPlan = await materialize({ mainWorktree, planPath });
      verifyExecutionPlan(executionPlan);
      await assertPlanArtifactsInMainWorktree({ mainWorktree, executionPlan });
      const worktree = await createExecutionWorktree({ repository, branch, baseline, path: worktreePath });
      await writeExecutionPlan(mainWorktree, executionPlan);
      const checkpoint = createCheckpoint({ executionPlan, baseline, branch, worktree, now: now() });
      await persist(mainWorktree, executionPlan.plan.plan_id, checkpoint, { verify: false });
      return { worktree, mainWorktree, executionPlan, checkpoint };
    },

    async resume({ repository, branch, planPath, worktreePath }) {
      const mainWorktree = await findMainWorktree(repository);
      if (!mainWorktree) throw new Error("Main worktree is unavailable");
      const { planId } = derivePlanLocation(mainWorktree, planPath);
      try {
        const mainCheckpoint = await readCheckpoint(mainWorktree, planId);
        const preflight = await verifyCheckpointIntegrity({ worktree: mainWorktree, planId, checkExecutionWorktree: false });
        if (preflight.status !== "valid") throw new Error(`Checkpoint integrity failed: ${JSON.stringify(preflight.diagnostics)}`);
        if (mainCheckpoint.integration.status === "done") {
          const executionPlan = await readExecutionPlan(mainWorktree, planId);
          const integrity = await verifyCheckpointIntegrity({ worktree: mainWorktree, planId });
          if (integrity.status !== "valid") throw new Error(JSON.stringify(integrity.diagnostics));
          if (await executionRecordsHaveChanges({ mainWorktree, planId, executionPlan })) {
            await requireIntegrity({ mainWorktree, planId });
            await commitExecutionRecords({ mainWorktree, planId, executionPlan, generateCommitMessage });
          }
          return { ...integrity, status: "complete", worktree: mainWorktree };
        }
        if (mainCheckpoint.integration.status === "merged") {
          return this.completeMergedCleanup({ repository, mainWorktree, planId, executionPlan: await readExecutionPlan(mainWorktree, planId), checkpoint: mainCheckpoint });
        }
        if (mainCheckpoint.status === "integrating" && await isAncestor(mainWorktree, branch)) {
          let checkpointForMerge = mainCheckpoint;
          if (checkpointForMerge.integration.stash_operation_id && !checkpointForMerge.integration.stash_ref) {
            const stash = await findStashForOperation(mainWorktree, planId, checkpointForMerge.integration.stash_operation_id);
            if (!stash) throw new Error("Recorded pre-merge stash operation has no recoverable stash reference");
            checkpointForMerge = recordStashReference(checkpointForMerge, stash, now());
            await persist(mainWorktree, planId, checkpointForMerge);
          }
          const merged = markMerged(checkpointForMerge, { executionHead: await git(mainWorktree, ["rev-parse", branch]), mainWorktree, mergedCommit: await currentHead(mainWorktree), stashRef: checkpointForMerge.integration.stash_ref }, now());
          await persist(mainWorktree, planId, merged);
          return this.completeMergedCleanup({ repository, mainWorktree, planId, executionPlan: await readExecutionPlan(mainWorktree, planId), checkpoint: merged });
        }
      } catch (error) {
        if (!String(error.message).includes("ENOENT")) throw error;
      }
      const executionPlan = await readExecutionPlan(mainWorktree, planId);
      await assertPlanArtifactsInMainWorktree({ mainWorktree, executionPlan });
      const ensured = await ensureExecutionWorktree({ repository, branch, path: worktreePath });
      let checkpoint = await readCheckpoint(mainWorktree, planId);
      const integrity = await verifyCheckpointIntegrity({ worktree: mainWorktree, executionWorktree: ensured.worktree, planId, allowWorktreeRelocation: true });
      if (integrity.status !== "valid") throw new Error(`Checkpoint integrity failed: ${JSON.stringify(integrity.diagnostics)}`);
      if (checkpoint.worktree !== ensured.worktree) {
        checkpoint = relocateCheckpoint(checkpoint, ensured.worktree, now());
        await persist(mainWorktree, planId, checkpoint);
      }
      return { ...integrity, status: "resumed", worktree: ensured.worktree, mainWorktree, executionPlan, checkpoint };
    },

    async executeFrontier({ worktree, mainWorktree, planId, executionPlan, checkpoint, readTask = createTaskReader({ mainWorktree, executionPlan }) }) {
      checkpoint = (await requireIntegrity({ mainWorktree, planId, executionWorktree: worktree })).checkpoint;
      if (checkpoint.tasks.some((task) => task.status === "blocked")) return { status: "blocked", checkpoint, results: [] };
      if (checkpoint.tasks.some((task) => task.status === "in_progress")) {
        return { status: "blocked", checkpoint, results: [], reason: "A task is still in progress; confirm its worker has stopped before recovery" };
      }
      const unfinished = executionPlan.tasks.filter((task) => checkpoint.tasks.find((state) => state.id === task.id)?.status !== "done");
      if (unfinished.length === 0) throw new Error("No unfinished task remains");
      const activeLevel = Math.min(...unfinished.map((task) => task.level));
      const frontier = executionPlan.tasks.filter((task) => task.level === activeLevel && checkpoint.tasks.find((state) => state.id === task.id)?.status === "pending").sort((left, right) => left.id.localeCompare(right.id)).slice(0, 1);
      if (executionPlan.execution_mode === "coordinator") {
        if (!directExecutor) throw new Error("A direct executor is required for coordinator execution");
        if (frontier.length !== 1) throw new Error("Single-task execution requires exactly one active task");
      }
      const pending = frontier;
      if (pending.length > 0) {
        checkpoint = startTasks(checkpoint, pending.map((task) => task.id), await currentHead(worktree), now());
        await persist(mainWorktree, planId, checkpoint);
      }
      let rawResults;
      if (executionPlan.execution_mode === "coordinator") {
        try {
          rawResults = [await directExecutor({ task: frontier[0], worktree, executionPlan, readTask })];
        } catch (error) {
          rawResults = [{ task_id: frontier[0].id, status: "blocked", commits: [], tests: [], summary: "Coordinator execution failed", error: error instanceof Error ? error.message : String(error) }];
        }
      } else {
        if (!adapter) throw new Error("Completion adapter is required to execute a frontier");
        rawResults = await adapter.executeFrontier({ tasks: frontier, worktree });
      }
      if (!Array.isArray(rawResults)) throw new Error("Completion adapter must return an array of completion results");
      const results = rawResults.map(assertCompletionResult);
      const byTask = new Map(results.map((result) => [result.task_id, result]));
      for (const task of frontier) {
        const result = byTask.get(task.id);
        if (!result) checkpoint = blockTask(checkpoint, task.id, "Completion adapter omitted this task", now());
        else if (result.status === "done") {
          await assertResultCommits(worktree, result);
          checkpoint = completeTask(checkpoint, task.id, result.commits.at(-1), now());
        } else checkpoint = blockTask(checkpoint, task.id, result.error, now());
        await persist(mainWorktree, planId, checkpoint);
        if (result?.status === "done") {
          await requireIntegrity({ mainWorktree, planId, executionWorktree: worktree });
          await markLocalTaskComplete({ mainWorktree, executionPlan, taskId: task.id });
        }
      }
      return { checkpoint, results };
    },

    async startReview({ mainWorktree, planId, checkpoint }) {
      checkpoint = (await requireIntegrity({ mainWorktree, planId, checkExecutionWorktree: false })).checkpoint;
      return persist(mainWorktree, planId, beginReview(checkpoint, now()));
    },

    async finishReview({ mainWorktree, planId, checkpoint, findingsSummary }) {
      checkpoint = (await requireIntegrity({ mainWorktree, planId, checkExecutionWorktree: false })).checkpoint;
      return persist(mainWorktree, planId, completeReview(checkpoint, findingsSummary, now()));
    },

    async run({ repository, branch, planPath, worktreePath, review }) {
      if (!planPath) throw new Error("A canonical planPath is required to initialize or resume an execution");
      let execution;
      if (await gitSucceeds(repository, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) {
        execution = await this.resume({ repository, branch, planPath, worktreePath });
      } else {
        execution = await this.initialize({ repository, branch, worktreePath, planPath });
        execution.status = "initialized";
      }
      if (execution.status === "complete") return execution;
      let { worktree, mainWorktree, executionPlan, checkpoint } = execution;
      const planId = executionPlan.plan.plan_id;
      const readTask = createTaskReader({ mainWorktree, executionPlan });
      while (checkpoint.status === "executing") {
        const result = await this.executeFrontier({ worktree, mainWorktree, planId, executionPlan, checkpoint, readTask });
        if (result.status === "blocked") return result;
        checkpoint = result.checkpoint;
        if (checkpoint.tasks.every((task) => task.status === "done")) checkpoint = await this.startReview({ mainWorktree, planId, checkpoint });
      }
      if (checkpoint.status === "reviewing") {
        if (!review) return { status: "reviewing", worktree, executionPlan, checkpoint };
        const reviewResult = await review({ worktree, executionPlan, checkpoint, readTask });
        if (reviewResult?.approved !== true || !reviewResult.findingsSummary) return { status: "reviewing", worktree, executionPlan, checkpoint };
        checkpoint = await this.finishReview({ mainWorktree, planId, checkpoint, findingsSummary: reviewResult.findingsSummary });
      }
      if (checkpoint.status === "integrating") return this.integrate({ repository, worktree, planId, executionPlan, checkpoint });
      return { status: checkpoint.status, worktree, executionPlan, checkpoint };
    },

    async integrate({ repository, worktree, planId, executionPlan, checkpoint }) {
      const mainWorktree = await findMainWorktree(repository);
      if (!mainWorktree) throw new Error("Main worktree is unavailable");
      let integrationCheckpoint = (await requireIntegrity({ mainWorktree, planId, executionWorktree: worktree })).checkpoint;
      if (integrationCheckpoint.status !== "integrating") throw new Error("Checkpoint is not ready for integration");
      if (!await worktreeIsClean(worktree)) throw new Error("Execution worktree is not clean");
      if (integrationCheckpoint.integration.stash_restore_state === "applying") {
        integrationCheckpoint = await restoreRecordedStash({ mainWorktree, planId, executionPlan, checkpoint: integrationCheckpoint });
      }
      if (integrationCheckpoint.integration.stash_restore_state === "restored" && integrationCheckpoint.integration.status === "pending") {
        integrationCheckpoint = await reconcileRestoredStash({ mainWorktree, planId, checkpoint: integrationCheckpoint });
        integrationCheckpoint = clearRestoredStashReference(integrationCheckpoint, now());
        await persist(mainWorktree, planId, integrationCheckpoint);
      }
      let stash = integrationCheckpoint.integration.stash_ref;
      if (!stash && integrationCheckpoint.integration.stash_operation_id) {
        stash = await findStashForOperation(mainWorktree, planId, integrationCheckpoint.integration.stash_operation_id);
        if (!stash) throw new Error("Recorded pre-merge stash operation has no recoverable stash reference");
        integrationCheckpoint = recordStashReference(integrationCheckpoint, stash, now());
        await persist(mainWorktree, planId, integrationCheckpoint);
      }
      if (stash) {
        if (!await gitSucceeds(mainWorktree, ["rev-parse", "--verify", `${stash}^{commit}`])) {
          throw new Error(`Checkpoint requires stash ${stash}, but that stash is unavailable`);
        }
      } else {
        const paths = await unexpectedMainWorktreeChanges({ mainWorktree, planId, executionPlan });
        if (paths.length > 0) {
          if (!integrationCheckpoint.integration.stash_operation_id) {
            integrationCheckpoint = beginStashOperation(integrationCheckpoint, randomUUID(), now());
            await persist(mainWorktree, planId, integrationCheckpoint);
          }
          stash = await findStashForOperation(mainWorktree, planId, integrationCheckpoint.integration.stash_operation_id);
          if (!stash) {
            await requireIntegrity({ mainWorktree, planId, executionWorktree: worktree });
            stash = await stashChanges(mainWorktree, paths, planId, integrationCheckpoint.integration.stash_operation_id);
          }
          if (!stash) throw new Error("Could not create the pre-merge stash; resume will retry the recorded stash operation");
          integrationCheckpoint = recordStashReference(integrationCheckpoint, stash, now());
          await persist(mainWorktree, planId, integrationCheckpoint);
        }
      }
      let mergeApplied = false;
      try {
        const executionHead = await currentHead(worktree);
        await requireIntegrity({ mainWorktree, planId, executionWorktree: worktree });
        await git(mainWorktree, ["merge", "--no-edit", integrationCheckpoint.branch]);
        mergeApplied = true;
        if (!await isAncestor(mainWorktree, executionHead)) throw new Error("Merged main does not contain execution HEAD");
        const mainCheckpoint = await readCheckpoint(mainWorktree, planId);
        const merged = markMerged(mainCheckpoint, { executionHead, mainWorktree, mergedCommit: await currentHead(mainWorktree), stashRef: stash }, now());
        await persist(mainWorktree, planId, merged);
        return this.completeMergedCleanup({ repository, mainWorktree, planId, executionPlan, checkpoint: merged });
      } catch (error) {
        if (mergeApplied) throw error;
        await gitSucceeds(mainWorktree, ["merge", "--abort"]);
        if (stash) {
          try {
            const restored = await restoreRecordedStash({ mainWorktree, planId, executionPlan, checkpoint: integrationCheckpoint });
            const reconciled = await reconcileRestoredStash({ mainWorktree, planId, checkpoint: restored });
            await persist(mainWorktree, planId, clearRestoredStashReference(reconciled, now()));
          } catch (restoreError) {
            throw new Error(`${error.message}; ${restoreError.message}`, { cause: restoreError });
          }
        }
        throw error;
      }
    },

    async completeMergedCleanup({ repository, mainWorktree, planId, executionPlan, checkpoint }) {
      if (checkpoint.integration.status === "done") {
        const integrity = await verifyCheckpointIntegrity({ worktree: mainWorktree, planId });
        if (integrity.status !== "valid") throw new Error(`Checkpoint integrity failed: ${JSON.stringify(integrity.diagnostics)}`);
        if (await executionRecordsHaveChanges({ mainWorktree, planId, executionPlan })) {
          await requireIntegrity({ mainWorktree, planId });
          await commitExecutionRecords({ mainWorktree, planId, executionPlan, generateCommitMessage });
        }
        return { status: "complete", worktree: mainWorktree, checkpoint };
      }
      if (checkpoint.integration.status !== "merged") throw new Error("Checkpoint is not ready for merged cleanup");
      checkpoint = (await requireIntegrity({ mainWorktree, planId })).checkpoint;
      if (checkpoint.integration.status !== "merged") throw new Error("Checkpoint is not ready for merged cleanup");
      if (checkpoint.integration.stash_operation_id && !checkpoint.integration.stash_ref) {
        throw new Error("Recorded pre-merge stash operation has no recoverable stash reference");
      }
      if (checkpoint.integration.stash_ref && checkpoint.integration.stash_restore_state !== "restored" && !await gitSucceeds(mainWorktree, ["rev-parse", "--verify", `${checkpoint.integration.stash_ref}^{commit}`])) {
        throw new Error(`Checkpoint requires stash ${checkpoint.integration.stash_ref}, but that stash is unavailable`);
      }
      const executionWorktree = await findExecutionWorktree(repository, checkpoint.branch);
      if (executionWorktree) {
        await requireIntegrity({ mainWorktree, planId });
        await removeExecutionWorktree({ repository, worktree: executionWorktree });
      }
      if (checkpoint.integration.stash_ref && checkpoint.integration.stash_restore_state !== "restored") {
        await requireIntegrity({ mainWorktree, planId });
        await git(mainWorktree, ["reset"]);
        checkpoint = await restoreRecordedStash({ mainWorktree, planId, executionPlan, checkpoint });
      }
      checkpoint = await reconcileRestoredStash({ mainWorktree, planId, checkpoint });
      await requireIntegrity({ mainWorktree, planId });
      const complete = completeIntegration(checkpoint, now());
      await persist(mainWorktree, planId, complete);
      try {
        await requireIntegrity({ mainWorktree, planId });
        await commitExecutionRecords({ mainWorktree, planId, executionPlan, generateCommitMessage });
      } catch (error) {
        await persist(mainWorktree, planId, checkpoint);
        throw error;
      }
      return { status: "complete", worktree: mainWorktree, checkpoint: complete };
    },
  };
}
