import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { assertHandoffResult } from '../lib/validation.mjs';

const execFileAsync = promisify(execFile);
const cli = resolve(import.meta.dirname, '../../../execution-runtime/execution-cli.mjs');

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'execution-cli-'));
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'user.name', 'Test User');
  const specDirectory = join(root, '.scratch', 'cli-flow');
  await mkdir(join(specDirectory, 'issues'), { recursive: true });
  await writeFile(join(specDirectory, 'spec.md'), '# CLI flow\n');
  await writeFile(join(specDirectory, 'issues', '01-work.md'), '# 01 - Work\n\n- [ ] Do work\n');
  await writeFile(join(root, '.gitignore'), '.worktrees/\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'fixture');
  return { root, spec: '.scratch/cli-flow/spec.md', worktree: join(root, '.worktrees', 'cli-flow') };
}

async function invoke({ root, worktree }, command, args = [], input) {
  const stdout = execFileSync(process.execPath, [cli, command, '--repository', root, ...args], {
    encoding: 'utf8',
    input
  });
  assert.equal(stdout.trim().split('\n').length, 1);
  return JSON.parse(stdout);
}

function invokeAsync({ root, worktree }, command, args = [], input) {
  const child = execFileAsync(process.execPath, [cli, command, '--repository', root, ...args], {
    encoding: 'utf8',
  });
  if (input !== undefined) child.child.stdin.end(input);
  return child;
}

test('execution CLI prepares, claims, records a blocked result, and reports JSON state', async () => {
  const paths = await fixture();
  const prepared = await invoke(paths, 'prepare', ['--branch', 'feat/cli-flow', '--spec', paths.spec, '--worktree', paths.worktree]);
  assert.equal(prepared.command, 'prepare');
  assert.equal(prepared.feature_slug, 'cli-flow');

  const claimed = await invoke(paths, 'claim', ['--feature', 'cli-flow', '--worktree', paths.worktree]);
  assert.equal(claimed.ticket.id, '01');
  const recorded = await invoke(paths, 'record-ticket', ['--feature', 'cli-flow', '--worktree', paths.worktree], JSON.stringify({
    role_id: 'full-stack-coder', status: 'blocked', summary: 'cannot continue', artifacts: [], checks: ['node --test'], error: 'fixture blocked',
    payload: { ticket_id: '01', status: 'blocked', commits: [], tests: ['node --test'], summary: 'cannot continue', error: 'fixture blocked' }
  }));
  assert.equal(recorded.status, 'blocked');
  const status = await invoke(paths, 'status', ['--feature', 'cli-flow', '--worktree', paths.worktree]);
  assert.equal(status.checkpoint.tickets[0].status, 'blocked');
});

test('execution CLI record-ticket rejects non-canonical Handoff inputs', async () => {
  const paths = await fixture();
  await invoke(paths, 'prepare', ['--branch', 'feat/cli-flow', '--spec', paths.spec, '--worktree', paths.worktree]);
  await invoke(paths, 'claim', ['--feature', 'cli-flow', '--worktree', paths.worktree]);

  const completion = { ticket_id: '01', status: 'blocked', commits: [], tests: [], summary: 'cannot continue', error: 'fixture blocked' };
  await assert.rejects(
    invokeAsync(paths, 'record-ticket', ['--feature', 'cli-flow', '--worktree', paths.worktree], JSON.stringify(completion)),
    /Handoff Result violates schema/,
  );
  await assert.rejects(
    invokeAsync(paths, 'record-ticket', ['--feature', 'cli-flow', '--worktree', paths.worktree], JSON.stringify({
      role_id: 'full-stack-coder', status: 'blocked', summary: 'cannot continue', artifacts: [], checks: [], error: 'fixture blocked',
    })),
    /Handoff Result violates schema/,
  );
  await assert.rejects(
    invokeAsync(paths, 'record-ticket', ['--feature', 'cli-flow', '--worktree', paths.worktree], JSON.stringify({
      role_id: 'full-stack-coder', status: 'blocked', summary: 'cannot continue', artifacts: [], checks: [], error: 'fixture blocked', payload: 'invalid',
    })),
    /Handoff Result violates schema/,
  );
});

test('execution CLI atomically allows only one concurrent claim', async () => {
  const paths = await fixture();
  await invoke(paths, 'prepare', ['--branch', 'feat/cli-flow', '--spec', paths.spec, '--worktree', paths.worktree]);

  const claims = await Promise.allSettled(Array.from({ length: 8 }, () => invokeAsync(
    paths,
    'claim',
    ['--feature', 'cli-flow', '--worktree', paths.worktree]
  )));
  const successful = claims.filter(({ status }) => status === 'fulfilled');
  const rejected = claims.filter(({ status }) => status === 'rejected');

  assert.equal(successful.length, 1);
  assert.equal(rejected.length, 7);
  assert.equal(JSON.parse(successful[0].value.stdout).ticket.id, '01');
  for (const result of rejected) {
    assert.match(result.reason.stderr, /claim is already in progress|ticket is still in progress/);
  }
});

test('execution CLI reclaims a stale claim lock without weakening concurrent claims', async () => {
  const paths = await fixture();
  await invoke(paths, 'prepare', ['--branch', 'feat/cli-flow', '--spec', paths.spec, '--worktree', paths.worktree]);
  await writeFile(join(paths.root, '.scratch', 'cli-flow', 'checkpoint.json.claim.lock'), JSON.stringify({ pid: 99999999, owner_id: 'crashed' }));

  const claimed = await invoke(paths, 'claim', ['--feature', 'cli-flow', '--worktree', paths.worktree]);
  assert.equal(claimed.ticket.id, '01');
});

test('execution CLI supports legacy orchestrator plans through claim and record', async () => {
  const paths = await fixture();
  await invoke(paths, 'prepare', ['--branch', 'feat/cli-flow', '--spec', paths.spec, '--worktree', paths.worktree]);
  const planPath = join(paths.root, '.scratch', 'cli-flow', 'execution-plan.json');
  const checkpointPath = join(paths.root, '.scratch', 'cli-flow', 'checkpoint.json');
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  plan.execution_mode = 'orchestrator';
  const { revision, ...facts } = plan;
  plan.revision = createHash('sha256').update(JSON.stringify(facts)).digest('hex');
  const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
  checkpoint.spec.revision = plan.revision;
  checkpoint.worktree = relative(paths.root, paths.worktree);
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);

  const resumed = await invoke(paths, 'prepare', ['--branch', 'feat/cli-flow', '--spec', paths.spec, '--worktree', paths.worktree]);
  assert.equal(resumed.checkpoint.worktree, relative(paths.root, paths.worktree));
  const resumedAgain = await invoke(paths, 'prepare', ['--branch', 'feat/cli-flow', '--spec', paths.spec, '--worktree', paths.worktree]);
  assert.deepEqual(resumedAgain.checkpoint.history, resumed.checkpoint.history);
  const claimed = await invoke(paths, 'claim', ['--feature', 'cli-flow', '--worktree', paths.worktree]);
  const recorded = await invoke(paths, 'record-ticket', ['--feature', 'cli-flow', '--worktree', paths.worktree], JSON.stringify({
    role_id: 'execution-orchestrator', status: 'blocked', summary: 'legacy blocked', artifacts: [], checks: [], error: 'fixture blocked',
    payload: { ticket_id: claimed.ticket.id, status: 'blocked', commits: [], tests: [], summary: 'legacy blocked', error: 'fixture blocked' }
  }));
  assert.equal(recorded.status, 'blocked');
});

test('execution CLI rejects a legacy absolute checkpoint worktree without migrating it', async () => {
  const paths = await fixture();
  await invoke(paths, 'prepare', ['--branch', 'feat/cli-flow', '--spec', paths.spec, '--worktree', paths.worktree]);
  const checkpointPath = join(paths.root, '.scratch', 'cli-flow', 'checkpoint.json');
  const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
  checkpoint.worktree = paths.worktree;
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);

  await assert.rejects(
    invokeAsync(paths, 'status', ['--feature', 'cli-flow', '--worktree', paths.worktree]),
    /Checkpoint violates schema|repository-relative path/,
  );
  assert.equal(JSON.parse(await readFile(checkpointPath, 'utf8')).worktree, paths.worktree);
});

test('execution CLI moves a user-approved review fix to integration without a second review', async () => {
  const paths = await fixture();
  await invoke(paths, 'prepare', ['--branch', 'feat/cli-flow', '--spec', paths.spec, '--worktree', paths.worktree]);
  await invoke(paths, 'claim', ['--feature', 'cli-flow', '--worktree', paths.worktree]);
  await writeFile(join(paths.worktree, 'completed.txt'), 'done\n');
  await git(paths.worktree, 'add', 'completed.txt');
  await git(paths.worktree, 'commit', '-m', 'complete ticket');
  const commit = await git(paths.worktree, 'rev-parse', 'HEAD');
  const handoff = {
    role_id: 'full-stack-coder',
    status: 'done',
    summary: 'Ticket completed.',
    artifacts: ['completed.txt'],
    checks: ['node --test'],
    payload: {
      ticket_id: '01', status: 'done', commits: [commit], tests: ['node --test'], summary: 'Ticket completed.'
    }
  };
  assert.doesNotThrow(() => assertHandoffResult(handoff));
  assert.throws(() => assertHandoffResult({ ...handoff, role_id: '' }), /Handoff Result violates schema/);

  const recorded = await invoke(paths, 'record-ticket', ['--feature', 'cli-flow', '--worktree', paths.worktree], JSON.stringify(handoff));
  assert.equal(recorded.status, 'done');
  await invoke(paths, 'record-review', ['--feature', 'cli-flow'], JSON.stringify({ findings_summary: 'fix the reviewed issue' }));
  const fixing = await invoke(paths, 'review-decision', ['--feature', 'cli-flow'], JSON.stringify({ decision: 'fix' }));
  assert.equal(fixing.status, 'fixing');
  const readyToIntegrate = await invoke(paths, 'complete-review-fix', ['--feature', 'cli-flow']);
  assert.equal(readyToIntegrate.status, 'integrating');
  const integrated = await invoke(paths, 'integrate', ['--feature', 'cli-flow', '--worktree', paths.worktree]);
  assert.equal(integrated.status, 'complete');
});
