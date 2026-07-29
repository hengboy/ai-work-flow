import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkpointPath, deriveSpecLocation, executionPlanPath } from "./paths.mjs";
import { createCheckpoint, markMerged, readCheckpoint, recordStashReference, relocateCheckpoint, resolveRepositoryPath, requiresReviewGateMigration, restartForReviewGateMigration } from "./checkpoint.mjs";
import { requireCheckpointIntegrity } from "./checkpoint-integrity.mjs";
import { currentHead, git, gitOutput, gitPathChanges, gitSucceeds, gitSucceedsWithInput, isAncestor } from "./git.mjs";
import { assertSpecArtifactsInMainWorktree, materializeSpec, verifyExecutionPlan, writeExecutionPlan } from "./spec-intake.mjs";
import { createIssueTracker } from "./issue-tracker.mjs";
import { assertCompletionResult } from "./validation.mjs";
import { toShanghaiTimestamp } from "./time.mjs";
import { createExecutionWorktree, ensureExecutionWorktree, findExecutionWorktree, findMainWorktree, removeExecutionWorktree, worktreeIsClean } from "./worktree-lifecycle.mjs";
import { createPreMergeStash } from "./pre-merge-stash.mjs";
import { createIntegrationLifecycle } from "./integration-lifecycle.mjs";
import { selectTicketFrontier } from "./ticket-frontier.mjs";
import { createRuntimeStateStore, withFeatureLock } from "../../../execution-runtime/state-store.mjs";

const executionCli = fileURLToPath(new URL("../../../execution-runtime/execution-cli.mjs", import.meta.url));
const REVIEW_STANDARDS_PATH = "CONTEXT.md";

async function frozenStandardsSource(worktree) {
  const revision = await currentHead(worktree);
  if (!await gitSucceeds(worktree, ["cat-file", "-e", `${revision}:${REVIEW_STANDARDS_PATH}`])) {
    throw new Error(`Review standards source is unavailable at frozen commit: ${REVIEW_STANDARDS_PATH}`);
  }
  return [{ path: REVIEW_STANDARDS_PATH, revision }];
}

async function canonicalTransition(command, { mainWorktree, featureSlug, worktree, roleId, sessionId }, input) {
  const args = [executionCli, command, "--repository", mainWorktree, "--feature", featureSlug];
  if (worktree) args.push("--worktree", worktree);
  if (roleId) args.push("--role-id", roleId);
  if (sessionId) args.push("--session-id", sessionId);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(`Canonical ${command} transition failed: ${stderr.trim() || `exit ${code}`}`));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
    child.stdin.end(input ? `${JSON.stringify(input)}\n` : undefined);
  });
}

function handoff(result, ticket) {
  return {
    role_id: ticket.expected_role_id,
    session_id: ticket.session_id,
    claim_id: ticket.claim_id,
    status: result.status,
    summary: result.summary,
    artifacts: [],
    checks: result.checks,
    ...(result.status === "blocked" ? { error: result.error } : {}),
    payload: result,
  };
}

async function commitFiles(worktree, files, message) {
  const changed = await changedPaths(worktree);
  const filesToCommit = [...new Set(files)].filter((file) => changed.some((change) => change.path === file || change.source_path === file));
  if (filesToCommit.length === 0) return;
  await git(worktree, ["add", "--", ...filesToCommit]);
  await git(worktree, ["commit", "--only", "-m", message, "--", ...filesToCommit]);
}

async function changedPaths(worktree) {
  return gitPathChanges(worktree);
}

async function executionRecordFiles({ mainWorktree, featureSlug, executionPlan }) {
  const issueTracker = createIssueTracker({ mainWorktree, executionPlan });
  return [executionPlanPath(featureSlug), checkpointPath(featureSlug), ...await issueTracker.paths()];
}

async function unexpectedMainWorktreeChanges({ mainWorktree, featureSlug, executionPlan }) {
  const allowed = new Set(await executionRecordFiles({ mainWorktree, featureSlug, executionPlan }));
  const runtimeLock = `${checkpointPath(featureSlug)}.runtime.lock`;
  return (await changedPaths(mainWorktree)).filter((change) => change.path !== runtimeLock && !allowed.has(change.path) && !allowed.has(change.source_path));
}

async function commitExecutionRecords({ mainWorktree, featureSlug, executionPlan }) {
  const files = await executionRecordFiles({ mainWorktree, featureSlug, executionPlan });
  await commitFiles(mainWorktree, files, `chore(ai-work-flow): record ${featureSlug} execution`);
}

async function executionRecordsHaveChanges({ mainWorktree, featureSlug, executionPlan }) {
  const files = new Set(await executionRecordFiles({ mainWorktree, featureSlug, executionPlan }));
  return (await changedPaths(mainWorktree)).some((change) => files.has(change.path) || files.has(change.source_path));
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

export function createExecutionCoding({ adapter, directExecutor, materialize = materializeSpec, now = toShanghaiTimestamp } = {}) {
  const stash = createPreMergeStash({ git, gitSucceeds, gitOutput, gitSucceedsWithInput });
  const stateStore = createRuntimeStateStore();

  const requireIntegrity = async ({ mainWorktree, featureSlug, executionWorktree, checkExecutionWorktree = true, allowWorktreeRelocation = false, allowLegacyReviewMigration = false }) => {
    return requireCheckpointIntegrity({ worktree: mainWorktree, executionWorktree, featureSlug, checkExecutionWorktree, allowWorktreeRelocation, allowLegacyReviewMigration });
  };

  const persist = async (worktree, featureSlug, checkpoint, { verify = true } = {}) => {
    if (!verify) return stateStore.initialize({ repository: worktree, featureSlug, checkpoint });
    return (await stateStore.transition({
      repository: worktree,
      featureSlug,
      checkExecutionWorktree: false,
      apply: () => checkpoint,
    })).checkpoint;
  };

  const integrationLifecycle = createIntegrationLifecycle({
    now,
    newStashOperationId: randomUUID,
    requireIntegrity,
    persist,
    stash,
    executionRecordsHaveChanges,
    commitExecutionRecords,
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
    async initialize({ repository, branch, baseline, worktreePath, specPath, _locked = false }) {
      baseline ??= await currentHead(repository);
      const mainWorktree = await findMainWorktree(repository);
      if (!mainWorktree) throw new Error("Main worktree is unavailable");
      const { featureSlug } = deriveSpecLocation(mainWorktree, specPath);
      if (!_locked) {
        return withFeatureLock(mainWorktree, featureSlug, () => this.initialize({ repository, branch, baseline, worktreePath, specPath, _locked: true }));
      }
      const executionPlan = await materialize({ mainWorktree, specPath });
      verifyExecutionPlan(executionPlan);
      await assertSpecArtifactsInMainWorktree({ mainWorktree, executionPlan });
      const createdWorktree = await createExecutionWorktree({ repository, branch, baseline, path: worktreePath });
      const worktree = await git(createdWorktree, ["rev-parse", "--show-toplevel"]);
      await writeExecutionPlan(mainWorktree, executionPlan);
      const checkpoint = createCheckpoint({ executionPlan, baseline, branch, repository: mainWorktree, worktree, now: now() });
      await persist(mainWorktree, executionPlan.spec.feature_slug, checkpoint, { verify: false });
      return { worktree, mainWorktree, executionPlan, checkpoint };
    },

    async resume({ repository, branch, specPath, worktreePath, _locked = false }) {
      const mainWorktree = await findMainWorktree(repository);
      if (!mainWorktree) throw new Error("Main worktree is unavailable");
      const { featureSlug } = deriveSpecLocation(mainWorktree, specPath);
      if (!_locked) {
        return withFeatureLock(mainWorktree, featureSlug, () => this.resume({ repository, branch, specPath, worktreePath, _locked: true }));
      }
      let preflight = await requireIntegrity({ mainWorktree, featureSlug, checkExecutionWorktree: false, allowLegacyReviewMigration: true });
      let mainCheckpoint = preflight.checkpoint;
      if (requiresReviewGateMigration(mainCheckpoint)) {
        mainCheckpoint = restartForReviewGateMigration(mainCheckpoint, now());
        await persist(mainWorktree, featureSlug, mainCheckpoint, { verify: false });
        preflight = await requireIntegrity({ mainWorktree, featureSlug, checkExecutionWorktree: false });
        mainCheckpoint = preflight.checkpoint;
      }
      if (mainCheckpoint.integration.status === "done") {
        const executionPlan = preflight.executionPlan;
        if (await executionRecordsHaveChanges({ mainWorktree, featureSlug, executionPlan })) {
          await requireIntegrity({ mainWorktree, featureSlug });
          await commitExecutionRecords({ mainWorktree, featureSlug, executionPlan });
        }
        return { ...preflight, status: "complete", worktree: mainWorktree };
      }
      if (mainCheckpoint.integration.status === "merged") {
        return this.completeMergedCleanup({ repository, mainWorktree, featureSlug, executionPlan: preflight.executionPlan, checkpoint: mainCheckpoint });
      }
      const reviewGateHead = mainCheckpoint.review.fix_commit || mainCheckpoint.review.review_commit;
      if (mainCheckpoint.status === "integrating" && await isAncestor(mainWorktree, reviewGateHead)) {
        let checkpointForMerge = mainCheckpoint;
        if (checkpointForMerge.integration.stash_operation_id && !checkpointForMerge.integration.stash_ref) {
          const stashRef = await stash.locate(mainWorktree, featureSlug, checkpointForMerge.integration.stash_operation_id);
          if (!stashRef) throw new Error("Recorded pre-merge stash operation has no recoverable stash reference");
          checkpointForMerge = recordStashReference(checkpointForMerge, stashRef, now());
          await persist(mainWorktree, featureSlug, checkpointForMerge);
        }
        const merged = markMerged(checkpointForMerge, { executionHead: reviewGateHead, mainWorktree, repository: mainWorktree, mergedCommit: await currentHead(mainWorktree), stashRef: checkpointForMerge.integration.stash_ref }, now());
        await persist(mainWorktree, featureSlug, merged);
        return this.completeMergedCleanup({ repository, mainWorktree, featureSlug, executionPlan: preflight.executionPlan, checkpoint: merged });
      }
      const executionPlan = preflight.executionPlan;
      await assertSpecArtifactsInMainWorktree({ mainWorktree, executionPlan });
      const ensured = await ensureExecutionWorktree({ repository, branch, path: worktreePath });
      const ensuredWorktree = await git(ensured.worktree, ["rev-parse", "--show-toplevel"]);
      let checkpoint = mainCheckpoint;
      const integrity = await requireIntegrity({ mainWorktree, executionWorktree: ensuredWorktree, featureSlug, allowWorktreeRelocation: true });
      if (resolveRepositoryPath(mainWorktree, checkpoint.worktree) !== ensuredWorktree) {
        checkpoint = relocateCheckpoint(checkpoint, ensuredWorktree, now(), mainWorktree);
        await persist(mainWorktree, featureSlug, checkpoint);
      }
      return { ...integrity, status: "resumed", worktree: ensuredWorktree, mainWorktree, executionPlan, checkpoint };
    },

    async executeFrontier({ worktree, mainWorktree, featureSlug, executionPlan, checkpoint, readTicket }) {
      const integrity = await requireIntegrity({ mainWorktree, featureSlug, executionWorktree: worktree });
      checkpoint = integrity.checkpoint;
      executionPlan = verifiedExecutionPlan(executionPlan, integrity);
      readTicket ??= createIssueTracker({ mainWorktree, executionPlan }).read.bind(null);
      const selection = selectTicketFrontier({ executionPlan, checkpoint });
      if (selection.status === "blocked") return { status: "blocked", checkpoint, results: [], ...(selection.reason ? { reason: selection.reason } : {}) };
      const claimed = await canonicalTransition("claim", { mainWorktree, featureSlug, worktree, roleId: "full-stack-coder", sessionId: randomUUID() });
      const ticket = claimed.ticket;
      checkpoint = claimed.checkpoint;
      let rawResult;
      if (adapter) {
        rawResult = await adapter.executeTicket({ ticket, worktree });
      } else if (directExecutor) {
        try {
          rawResult = await directExecutor({ task: ticket, worktree, executionPlan, readTicket });
        } catch (error) {
          rawResult = { ticket_id: ticket.id, status: "blocked", commits: [], checks: [], changed_paths: [], summary: "Coding execution failed", error: error instanceof Error ? error.message : String(error) };
        }
      } else throw new Error("Completion adapter is required to execute a ticket");
      const result = assertCompletionResult(rawResult);
      if (result.ticket_id !== ticket.id) throw new Error(`Completion result belongs to ${result.ticket_id}, expected ${ticket.id}`);
      checkpoint = (await canonicalTransition("record-ticket", { mainWorktree, featureSlug, worktree }, handoff(result, ticket))).checkpoint;
      if (result.status === "done") {
        await requireIntegrity({ mainWorktree, featureSlug, executionWorktree: worktree });
        const issueTracker = createIssueTracker({ mainWorktree, executionPlan });
        await issueTracker.markComplete(ticket.id);
      }
      return { checkpoint, results: [result] };
    },

    async startReview({ mainWorktree, featureSlug, worktree, executionPlan, checkpoint }) {
      checkpoint ??= await readCheckpoint(mainWorktree, featureSlug);
      if (checkpoint.sync?.status === "pending") {
        checkpoint = (await canonicalTransition("sync-main", { mainWorktree, featureSlug, worktree })).checkpoint;
      }
      if (checkpoint.sync?.status === "conflicted") return checkpoint;
      if (checkpoint.sync?.status !== "complete") throw new Error("Main synchronization must complete before review");
      const standardsSource = await frozenStandardsSource(worktree);
      return (await canonicalTransition("begin-review", { mainWorktree, featureSlug, worktree }, {
        spec_status: "present",
        spec_source: { path: executionPlan.spec.ref, revision: executionPlan.revision },
        standards_source: standardsSource,
      })).checkpoint;
    },

    async finishReview({ mainWorktree, featureSlug, checkpoint, findingsSummary, result }) {
      const recorded = await canonicalTransition("record-review", { mainWorktree, featureSlug }, {
        findings_summary: findingsSummary,
        manifest_digest: result.manifest_digest,
        coverage: result.coverage,
        result,
      });
      return recorded.checkpoint;
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
        checkpoint = await this.startReview({ mainWorktree, featureSlug, worktree, executionPlan, checkpoint });
        if (checkpoint.sync?.status === "conflicted") return { status: "sync_conflicted", worktree, executionPlan, checkpoint, unmerged_paths: checkpoint.sync.unmerged_paths };
      }
      while (checkpoint.status === "executing") {
        const result = await this.executeFrontier({ worktree, mainWorktree, featureSlug, executionPlan, checkpoint, readTicket });
        if (result.status === "blocked") return result;
        checkpoint = result.checkpoint;
        if (checkpoint.tickets.every((ticket) => ticket.status === "done")) {
          checkpoint = await this.startReview({ mainWorktree, featureSlug, worktree, executionPlan, checkpoint });
          if (checkpoint.sync?.status === "conflicted") return { status: "sync_conflicted", worktree, executionPlan, checkpoint, unmerged_paths: checkpoint.sync.unmerged_paths };
        }
      }
      if (checkpoint.status === "reviewing") {
        if (!review) return { status: "reviewing", worktree, executionPlan, checkpoint };
        const reviewResult = await review({ worktree, executionPlan, checkpoint, readTicket });
        if (!reviewResult?.result || !reviewResult.findingsSummary) return { status: "reviewing", worktree, executionPlan, checkpoint };
        checkpoint = await this.finishReview({ mainWorktree, featureSlug, checkpoint, findingsSummary: reviewResult.findingsSummary, result: reviewResult.result });
      }
      if (checkpoint.status === "integrating") return this.integrate({ repository, worktree, featureSlug, executionPlan, checkpoint });
      return { status: checkpoint.status, worktree, executionPlan, checkpoint };
    },

    async integrate(args) {
      return withFeatureLock(args.repository, args.featureSlug, () => integrationLifecycle.integrate(args));
    },

    async completeMergedCleanup(args) {
      return withFeatureLock(args.repository, args.featureSlug, () => integrationLifecycle.completeMergedCleanup(args));
    },
  };
}
