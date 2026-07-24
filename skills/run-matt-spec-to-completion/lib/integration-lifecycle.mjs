import { beginStashOperation, beginStashRestoration, clearRestoredStashReference, completeIntegration, markMerged, markRestoredStashDropped, markStashRestored, recordStashReference } from "./checkpoint.mjs";

export function createIntegrationLifecycle({ now, newStashOperationId, requireIntegrity, persist, stash, executionRecordsHaveChanges, commitExecutionRecords, findMainWorktree, worktreeIsClean, currentHead, isAncestor, findExecutionWorktree, removeExecutionWorktree, readCheckpoint, git, gitSucceeds, unexpectedMainWorktreeChanges }) {
  const verifiedExecutionPlan = (executionPlan, integrity) => {
    if (!integrity.executionPlan) return executionPlan;
    if (executionPlan && executionPlan.revision !== integrity.executionPlan.revision) {
      throw new Error("Provided execution plan does not match the verified persisted execution plan");
    }
    return integrity.executionPlan;
  };

  const reconcileRestoredStash = async ({ mainWorktree, featureSlug, checkpoint }) => {
    if (checkpoint.integration.stash_restore_state !== "restored" || checkpoint.integration.stash_cleanup_state === "dropped") return checkpoint;
    const reference = checkpoint.integration.stash_ref;
    if (!reference) throw new Error("Checkpoint does not identify a restored stash to clean up");
    const { listed, applied } = await stash.reconcile(mainWorktree, reference);
    if (!applied) {
      throw new Error(`Could not reconcile restored stash ${reference}; it is unavailable and its patch is not present`);
    }
    if (listed) {
      await requireIntegrity({ mainWorktree, featureSlug, checkExecutionWorktree: false });
      await stash.drop(mainWorktree, reference);
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
        checkpoint = beginStashRestoration({ ...checkpoint, integration }, now());
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

  const completeMergedCleanup = async ({ repository, mainWorktree, featureSlug, executionPlan, checkpoint }) => {
    if (checkpoint.integration.status === "done") {
      const integrity = await requireIntegrity({ mainWorktree, featureSlug });
      checkpoint = integrity.checkpoint;
      executionPlan = verifiedExecutionPlan(executionPlan, integrity);
      if (await executionRecordsHaveChanges({ mainWorktree, featureSlug, executionPlan })) {
        await requireIntegrity({ mainWorktree, featureSlug });
        await commitExecutionRecords({ mainWorktree, featureSlug, executionPlan });
      }
      return { status: "complete", worktree: mainWorktree, checkpoint };
    }
    if (checkpoint.integration.status !== "merged") throw new Error("Checkpoint is not ready for merged cleanup");
    const integrity = await requireIntegrity({ mainWorktree, featureSlug });
    checkpoint = integrity.checkpoint;
    executionPlan = verifiedExecutionPlan(executionPlan, integrity);
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
      await commitExecutionRecords({ mainWorktree, featureSlug, executionPlan });
    } catch (error) {
      await persist(mainWorktree, featureSlug, checkpoint);
      throw error;
    }
    return { status: "complete", worktree: mainWorktree, checkpoint: complete };
  };

  const integrate = async ({ repository, worktree, featureSlug, executionPlan }) => {
    const mainWorktree = await findMainWorktree(repository);
    if (!mainWorktree) throw new Error("Main worktree is unavailable");
    const integrity = await requireIntegrity({ mainWorktree, featureSlug, executionWorktree: worktree });
    let checkpoint = integrity.checkpoint;
    executionPlan = verifiedExecutionPlan(executionPlan, integrity);
    if (checkpoint.status !== "integrating") throw new Error("Checkpoint is not ready for integration");
    if (!await worktreeIsClean(worktree)) throw new Error("Execution worktree is not clean");
    if (checkpoint.integration.stash_restore_state === "applying") {
      checkpoint = await restoreRecordedStash({ mainWorktree, featureSlug, executionPlan, checkpoint });
    }
    if (checkpoint.integration.stash_restore_state === "restored" && checkpoint.integration.status === "pending") {
      checkpoint = await reconcileRestoredStash({ mainWorktree, featureSlug, checkpoint });
      checkpoint = clearRestoredStashReference(checkpoint, now());
      await persist(mainWorktree, featureSlug, checkpoint);
    }
    let stashRef = checkpoint.integration.stash_ref;
    if (!stashRef && checkpoint.integration.stash_operation_id) {
      stashRef = await stash.locate(mainWorktree, featureSlug, checkpoint.integration.stash_operation_id);
      if (!stashRef) throw new Error("Recorded pre-merge stash operation has no recoverable stash reference");
      checkpoint = recordStashReference(checkpoint, stashRef, now());
      await persist(mainWorktree, featureSlug, checkpoint);
    }
    if (stashRef && !await gitSucceeds(mainWorktree, ["rev-parse", "--verify", `${stashRef}^{commit}`])) {
      throw new Error(`Checkpoint requires stash ${stashRef}, but that stash is unavailable`);
    }
    if (!stashRef) {
      const paths = await unexpectedMainWorktreeChanges({ mainWorktree, featureSlug, executionPlan });
      if (paths.length > 0) {
        if (!checkpoint.integration.stash_operation_id) {
          checkpoint = beginStashOperation(checkpoint, newStashOperationId(), now());
          await persist(mainWorktree, featureSlug, checkpoint);
        }
        stashRef = await stash.locate(mainWorktree, featureSlug, checkpoint.integration.stash_operation_id);
        if (!stashRef) {
          await requireIntegrity({ mainWorktree, featureSlug, executionWorktree: worktree });
          stashRef = await stash.save(mainWorktree, paths, featureSlug, checkpoint.integration.stash_operation_id);
        }
        if (!stashRef) throw new Error("Could not create the pre-merge stash; resume will retry the recorded stash operation");
        checkpoint = recordStashReference(checkpoint, stashRef, now());
        await persist(mainWorktree, featureSlug, checkpoint);
      }
    }
    let mergeApplied = false;
    try {
      const executionHead = await currentHead(worktree);
      await requireIntegrity({ mainWorktree, featureSlug, executionWorktree: worktree });
      await git(mainWorktree, ["merge", "--no-edit", checkpoint.branch]);
      mergeApplied = true;
      if (!await isAncestor(mainWorktree, executionHead)) throw new Error("Merged main does not contain execution HEAD");
      const merged = markMerged(await readCheckpoint(mainWorktree, featureSlug), {
        executionHead,
        mainWorktree,
        mergedCommit: await currentHead(mainWorktree),
        stashRef,
      }, now());
      await persist(mainWorktree, featureSlug, merged);
      return completeMergedCleanup({ repository, mainWorktree, featureSlug, executionPlan, checkpoint: merged });
    } catch (error) {
      if (mergeApplied) throw error;
      await gitSucceeds(mainWorktree, ["merge", "--abort"]);
      if (stashRef) {
        try {
          const restored = await restoreRecordedStash({ mainWorktree, featureSlug, executionPlan, checkpoint });
          const reconciled = await reconcileRestoredStash({ mainWorktree, featureSlug, checkpoint: restored });
          await persist(mainWorktree, featureSlug, clearRestoredStashReference(reconciled, now()));
        } catch (restoreError) {
          throw new Error(`${error.message}; ${restoreError.message}`, { cause: restoreError });
        }
      }
      throw error;
    }
  };

  return { integrate, completeMergedCleanup };
}
