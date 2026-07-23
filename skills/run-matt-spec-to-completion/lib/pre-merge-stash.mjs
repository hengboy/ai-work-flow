export function createPreMergeStash({ git, gitSucceeds, gitOutput, gitSucceedsWithInput }) {
  function stashMessage(featureSlug, operationId) {
    return `run-matt-spec-to-completion:${featureSlug}:${operationId}`;
  }

  async function previousStashRef(worktree) {
    return await gitSucceeds(worktree, ["rev-parse", "--verify", "refs/stash"])
      ? await git(worktree, ["rev-parse", "refs/stash"])
      : null;
  }

  return {
    async save(worktree, paths, featureSlug, operationId) {
      if (paths.length === 0) return null;
      const previous = await previousStashRef(worktree);
      await git(worktree, ["stash", "push", "--include-untracked", "--message", stashMessage(featureSlug, operationId), "--", ...paths]);
      const reference = await previousStashRef(worktree);
      if (!reference || reference === previous) return null;
      return reference;
    },

    async locate(worktree, featureSlug, operationId) {
      const message = stashMessage(featureSlug, operationId);
      const references = (await git(worktree, ["stash", "list", "--format=%H"])).split("\n").filter(Boolean);
      for (const reference of references) {
        if ((await git(worktree, ["log", "-1", "--format=%B", reference])).includes(message)) return reference;
      }
      return null;
    },

    async restore(worktree, reference) {
      if (!reference) throw new Error("Checkpoint does not identify a stash to restore");
      if (!await gitSucceeds(worktree, ["rev-parse", "--verify", `${reference}^{commit}`])) {
        throw new Error(`Checkpoint requires stash ${reference}, but that stash is unavailable`);
      }
      try {
        await git(worktree, ["stash", "apply", "--index", reference]);
      } catch (error) {
        throw new Error(`Could not restore unrelated main worktree changes from stash ${reference}; resolve them manually`, { cause: error });
      }
    },

    async reconcile(worktree, reference) {
      const listed = (await git(worktree, ["stash", "list", "--format=%H"])).split("\n").includes(reference);
      const patch = await gitOutput(worktree, ["stash", "show", "--include-untracked", "--patch", reference]);
      const applied = patch !== "" && gitSucceedsWithInput(worktree, ["apply", "--reverse", "--check"], patch);
      return { listed, applied };
    },

    async drop(worktree, reference) {
      if (await git(worktree, ["rev-parse", "refs/stash"]) !== reference) {
        throw new Error(`Could not remove restored stash ${reference}; it is no longer the top stash`);
      }
      await git(worktree, ["stash", "drop", "stash@{0}"]);
    }
  };
}
