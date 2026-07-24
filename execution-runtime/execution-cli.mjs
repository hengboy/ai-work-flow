#!/usr/bin/env node
import process from 'node:process';
import { open, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { beginReview, blockTicket, completeReviewFix, completeTicket, decideReview, recordReview, startTickets, writeCheckpoint } from '../skills/run-matt-spec-to-completion/lib/checkpoint.mjs';
import { requireCheckpointIntegrity } from '../skills/run-matt-spec-to-completion/lib/checkpoint-integrity.mjs';
import { currentHead, gitSucceeds, isAncestor } from '../skills/run-matt-spec-to-completion/lib/git.mjs';
import { createExecutionOrchestrator } from '../skills/run-matt-spec-to-completion/lib/execution-orchestrator.mjs';
import { checkpointPath } from '../skills/run-matt-spec-to-completion/lib/paths.mjs';
import { selectTicketFrontier } from '../skills/run-matt-spec-to-completion/lib/ticket-frontier.mjs';
import { assertCompletionResult, assertHandoffResult } from '../skills/run-matt-spec-to-completion/lib/validation.mjs';
import { toShanghaiTimestamp } from '../skills/run-matt-spec-to-completion/lib/time.mjs';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`Invalid argument: ${key ?? ''}`);
    options[key.slice(2).replaceAll('-', '_')] = value;
  }
  return options;
}

async function stdinJson() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) throw new Error('Expected JSON on stdin.');
  return JSON.parse(raw);
}

function requireOption(options, name) {
  if (!options[name]) throw new Error(`--${name.replaceAll('_', '-')} is required.`);
  return options[name];
}

async function integrity(options, { checkExecutionWorktree = true } = {}) {
  const repository = requireOption(options, 'repository');
  const featureSlug = requireOption(options, 'feature');
  const worktree = options.worktree;
  return requireCheckpointIntegrity({ worktree: repository, executionWorktree: worktree, featureSlug, checkExecutionWorktree });
}

async function assertTicketCommits(worktree, ticket, commits) {
  for (const commit of commits) {
    if (!await gitSucceeds(worktree, ['rev-parse', '--verify', `${commit}^{commit}`])) {
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

const CLAIM_LOCK_GRACE_MS = 60_000;

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function claimLockIsStale(lockPath) {
  let contents;
  let metadata;
  try {
    [contents, metadata] = await Promise.all([readFile(lockPath, 'utf8'), stat(lockPath)]);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return !processIsAlive(JSON.parse(contents).pid);
  } catch {
    return Date.now() - metadata.mtimeMs > CLAIM_LOCK_GRACE_MS;
  }
}

async function claimAtomically(repository, featureSlug, claim) {
  const lockPath = join(repository, `${checkpointPath(featureSlug)}.claim.lock`);
  const recoveryPath = `${lockPath}.recovery`;
  let lock;
  while (!lock) {
    try {
      lock = await open(lockPath, 'wx');
      await lock.writeFile(`${JSON.stringify({ pid: process.pid, owner_id: randomUUID(), created_at: new Date().toISOString() })}\n`);
      await lock.sync();
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stale = await claimLockIsStale(lockPath);
      if (stale === null) continue;
      if (!stale) throw new Error('A claim is already in progress.');
      let recovery;
      try {
        recovery = await open(recoveryPath, 'wx');
      } catch (recoveryError) {
        if (recoveryError.code === 'EEXIST') throw new Error('A claim is already in progress.');
        throw recoveryError;
      }
      try {
        const rechecked = await claimLockIsStale(lockPath);
        if (rechecked === null) continue;
        if (!rechecked) throw new Error('A claim is already in progress.');
        await rm(lockPath, { force: true });
      } finally {
        await recovery.close();
        await rm(recoveryPath, { force: true });
      }
    }
  }
  try {
    return await claim();
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

function completionResultFromInput(input) {
  const handoff = assertHandoffResult(input);
  const completion = assertCompletionResult(handoff.payload);
  if (handoff.status !== completion.status) throw new Error('Handoff envelope status must match its Ticket Completion Result status.');
  return completion;
}

async function run(options) {
  const repository = requireOption(options, 'repository');
  if (options.command === 'prepare') {
    const orchestrator = createExecutionOrchestrator();
    const branch = requireOption(options, 'branch');
    const args = { repository, branch, specPath: requireOption(options, 'spec'), worktreePath: requireOption(options, 'worktree') };
    const result = await gitSucceeds(repository, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
      ? await orchestrator.resume(args)
      : await orchestrator.initialize(args);
    return { command: 'prepare', status: result.status ?? 'initialized', feature_slug: result.executionPlan?.spec.feature_slug, checkpoint: result.checkpoint };
  }
  if (options.command === 'status') {
    const result = await integrity(options, { checkExecutionWorktree: Boolean(options.worktree) });
    return { command: 'status', status: result.checkpoint.status, checkpoint: result.checkpoint, execution_plan: result.executionPlan };
  }
  if (options.command === 'claim') {
    const featureSlug = requireOption(options, 'feature');
    return claimAtomically(repository, featureSlug, async () => {
      const result = await integrity(options);
      const frontier = selectTicketFrontier({ executionPlan: result.executionPlan, checkpoint: result.checkpoint });
      if (frontier.status !== 'ready') throw new Error(frontier.reason ?? 'No ticket is ready to claim.');
      const ticket = frontier.tickets[0];
      const checkpoint = startTickets(result.checkpoint, [ticket.id], await currentHead(options.worktree), toShanghaiTimestamp(new Date()));
      await writeCheckpoint(repository, featureSlug, checkpoint);
      return { command: 'claim', status: 'in_progress', ticket, checkpoint };
    });
  }
  if (options.command === 'record-ticket') {
    const result = await integrity(options);
    const input = completionResultFromInput(await stdinJson());
    const ticket = result.checkpoint.tickets.find((candidate) => candidate.id === input.ticket_id);
    if (!ticket || ticket.status !== 'in_progress') throw new Error(`Ticket ${input.ticket_id} is not claimed.`);
    if (input.status === 'done') await assertTicketCommits(options.worktree, ticket, input.commits);
    const checkpoint = input.status === 'done'
      ? completeTicket(result.checkpoint, input.ticket_id, input.commits.at(-1), toShanghaiTimestamp(new Date()))
      : blockTicket(result.checkpoint, input.ticket_id, input.error, toShanghaiTimestamp(new Date()));
    await writeCheckpoint(repository, requireOption(options, 'feature'), checkpoint);
    return { command: 'record-ticket', status: input.status, ticket_id: input.ticket_id, checkpoint };
  }
  if (options.command === 'record-review') {
    const result = await integrity(options, { checkExecutionWorktree: false });
    const input = await stdinJson();
    if (typeof input.findings_summary !== 'string' || !input.findings_summary) throw new Error('findings_summary is required.');
    const started = result.checkpoint.status === 'executing' && result.checkpoint.tickets.every((ticket) => ticket.status === 'done')
      ? beginReview(result.checkpoint, toShanghaiTimestamp(new Date()))
      : result.checkpoint;
    const checkpoint = recordReview(started, input.findings_summary, toShanghaiTimestamp(new Date()));
    await writeCheckpoint(repository, requireOption(options, 'feature'), checkpoint);
    return { command: 'record-review', status: checkpoint.review.status, checkpoint };
  }
  if (options.command === 'review-decision') {
    const result = await integrity(options, { checkExecutionWorktree: false });
    const input = await stdinJson();
    const checkpoint = decideReview(result.checkpoint, input.decision, toShanghaiTimestamp(new Date()));
    await writeCheckpoint(repository, requireOption(options, 'feature'), checkpoint);
    return { command: 'review-decision', status: checkpoint.status, checkpoint };
  }
  if (options.command === 'complete-review-fix') {
    const result = await integrity(options, { checkExecutionWorktree: false });
    const checkpoint = completeReviewFix(result.checkpoint, toShanghaiTimestamp(new Date()));
    await writeCheckpoint(repository, requireOption(options, 'feature'), checkpoint);
    return { command: 'complete-review-fix', status: checkpoint.status, checkpoint };
  }
  if (options.command === 'integrate') {
    const result = await integrity(options);
    const orchestrator = createExecutionOrchestrator({ generateCommitMessage: async () => 'chore: record execution' });
    const integrated = await orchestrator.integrate({ repository, worktree: requireOption(options, 'worktree'), featureSlug: requireOption(options, 'feature'), executionPlan: result.executionPlan, checkpoint: result.checkpoint });
    return { command: 'integrate', status: integrated.status, checkpoint: integrated.checkpoint };
  }
  throw new Error(`Unknown command: ${options.command ?? ''}`);
}

try {
  const result = await run(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`execution-cli: ${error.message}\n`);
  process.exitCode = 1;
}
