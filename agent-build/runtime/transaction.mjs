import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, relative, resolve, sep } from 'node:path';

import { fail } from './shared.mjs';

const TRANSACTION_VERSION = 1;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fsyncPath(path) {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeAtomic(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = resolve(dirname(path), `.${randomUUID()}.tmp`);
  writeFileSync(temporary, contents, { flag: 'wx' });
  fsyncPath(temporary);
  renameSync(temporary, path);
  fsyncPath(dirname(path));
}

function isWithin(root, path) {
  const relativePath = relative(root, path);
  return relativePath === '' || (!relativePath.startsWith('..') && !relativePath.includes(`..${sep}`));
}

function assertNoSymbolicLinks(root, path) {
  if (!isWithin(root, path)) fail(`Transaction path escapes trusted root: ${path}`);
  let current = root;
  for (const segment of ['.', ...relative(root, path).split(sep).filter(Boolean)]) {
    if (segment !== '.') current = resolve(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) fail(`Transaction path must not contain a symbolic link: ${current}`);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
  }
}

function trustedRoots(transactionPath, roots) {
  const values = roots?.length ? roots : [dirname(transactionPath)];
  return values.map((root) => resolve(root));
}

function assertTrustedPath(path, roots) {
  if (typeof path !== 'string' || !path || /[\u0000-\u001f\u007f]/.test(path)) fail('Transaction path must be a non-empty safe string.');
  const resolved = resolve(path);
  const root = roots.find((candidate) => isWithin(candidate, resolved));
  if (!root) fail(`Transaction path is outside trusted roots: ${path}`);
  assertNoSymbolicLinks(root, resolved);
  return resolved;
}

function assertRegularFileIfPresent(path, label) {
  try {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isFile()) fail(`${label} must be a regular file: ${path}`);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function assertStepPathIfPresent(path, type, label) {
  try {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) fail(`${label} must not be a symbolic link: ${path}`);
    if (type === 'tree' ? !entry.isDirectory() : !entry.isFile()) {
      fail(`${label} must be a ${type === 'tree' ? 'directory' : 'regular file'}: ${path}`);
    }
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function backupPath(path, id, index) {
  return resolve(dirname(path), `.${id}.${index}.ai-work-flow-backup`);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`Cannot safely parse ${label} at ${path}: ${error.message}`);
  }
}

function validateSteps(steps, roots) {
  if (!Array.isArray(steps) || !steps.length) fail('Transaction must contain at least one step.');
  const targets = new Set();
  return steps.map((step, index) => {
    if (!step || typeof step !== 'object' || !['write', 'delete', 'tree'].includes(step.type)) fail(`Invalid transaction step at index ${index}.`);
    if (step.type === 'write' && typeof step.contents !== 'string') fail(`Transaction write step ${index} must have string contents.`);
    const path = assertTrustedPath(step.path, roots);
    assertStepPathIfPresent(path, step.type, 'Transaction target');
    if (targets.has(path)) fail(`Transaction contains duplicate target: ${path}`);
    targets.add(path);
    if (step.type !== 'tree') return { type: step.type, path, contents: step.contents };
    if (!Array.isArray(step.entries)) fail(`Transaction tree step ${index} must contain entries.`);
    const entryPaths = new Set();
    const entries = step.entries.map((entry, entryIndex) => {
      if (!entry || typeof entry.path !== 'string' || !entry.path || typeof entry.contents !== 'string') fail(`Transaction tree step ${index} entry ${entryIndex} is invalid.`);
      const target = resolve(path, entry.path);
      if (!isWithin(path, target) || target === path) fail(`Transaction tree step ${index} entry escapes its target: ${entry.path}`);
      const relativePath = relative(path, target);
      if (entryPaths.has(relativePath)) fail(`Transaction tree step ${index} contains duplicate entry: ${entry.path}`);
      entryPaths.add(relativePath);
      return { path: relativePath, contents: entry.contents };
    });
    return { type: step.type, path, entries };
  });
}

function validateJournal(value, roots) {
  if (!value || typeof value !== 'object' || Object.keys(value).some((key) => !['version', 'id', 'phase', 'steps'].includes(key)) || value.version !== TRANSACTION_VERSION || !ID_PATTERN.test(value.id) || !['applying', 'committed'].includes(value.phase)) {
    fail('Transaction journal has an invalid identity or phase.');
  }
  if (!Array.isArray(value.steps) || !value.steps.length) fail('Transaction journal must contain a complete plan.');
  const targets = new Set();
  const steps = value.steps.map((step, index) => {
    if (!step || typeof step !== 'object' || Object.keys(step).some((key) => !['type', 'path', 'backup', 'existed'].includes(key)) || !['write', 'delete', 'tree'].includes(step.type) || typeof step.existed !== 'boolean') fail(`Transaction journal step ${index} is invalid.`);
    const path = assertTrustedPath(step.path, roots);
    assertStepPathIfPresent(path, step.type, 'Transaction target');
    if (targets.has(path)) fail(`Transaction journal contains duplicate target: ${path}`);
    targets.add(path);
    const backup = backupPath(path, value.id, index);
    if (step.backup !== backup) fail(`Transaction journal step ${index} has an invalid backup path.`);
    assertTrustedPath(backup, roots);
    assertStepPathIfPresent(backup, step.type, 'Transaction backup');
    return { ...step, path, backup };
  });
  return { ...value, steps };
}

function lockPath(transactionPath) {
  return `${transactionPath}.lock`;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function acquireLock(transactionPath, roots) {
  const path = lockPath(transactionPath);
  assertTrustedPath(path, roots);
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, `${JSON.stringify({ version: TRANSACTION_VERSION, pid: process.pid })}\n`, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    assertRegularFileIfPresent(path, 'Transaction lock');
    const owner = readJson(path, 'transaction lock');
    if (!Number.isInteger(owner?.pid) || processIsAlive(owner.pid)) fail(`Generation transaction is already owned by process ${owner?.pid ?? 'unknown'}.`);
    unlinkSync(path);
    return acquireLock(transactionPath, roots);
  }
  return path;
}

function releaseLock(path) {
  if (existsSync(path)) unlinkSync(path);
}

function removeStepPath(path, type) {
  rmSync(path, { recursive: type === 'tree', force: true });
}

function recoverJournal(transactionPath, roots) {
  if (!existsSync(transactionPath)) return false;
  assertTrustedPath(transactionPath, roots);
  assertRegularFileIfPresent(transactionPath, 'Transaction journal');
  const journal = validateJournal(readJson(transactionPath, 'transaction journal'), roots);
  if (journal.phase === 'committed') {
    for (const step of journal.steps) {
      assertTrustedPath(step.backup, roots);
      if (existsSync(step.backup)) removeStepPath(step.backup, step.type);
    }
  } else {
    for (const step of [...journal.steps].reverse()) {
      assertTrustedPath(step.path, roots);
      assertTrustedPath(step.backup, roots);
      if (existsSync(step.backup)) {
        if (existsSync(step.path)) removeStepPath(step.path, step.type);
        renameSync(step.backup, step.path);
      } else if (!step.existed && existsSync(step.path)) {
        removeStepPath(step.path, step.type);
      }
    }
  }
  rmSync(transactionPath, { force: true });
  return true;
}

export function recoverTransaction(transactionPath, { roots } = {}) {
  if (!transactionPath) fail('Transaction path is required.');
  const trusted = trustedRoots(transactionPath, roots);
  assertTrustedPath(transactionPath, trusted);
  assertRegularFileIfPresent(transactionPath, 'Transaction journal');
  const lock = acquireLock(transactionPath, trusted);
  try {
    return recoverJournal(transactionPath, trusted);
  } finally {
    releaseLock(lock);
  }
}

export function applyTransaction(steps, { transactionPath, roots, dryRun = false, failAfterStep, interruptAfterRecord, interruptAfterBackup, interruptAfterStep, interruptAfterCommit } = {}) {
  if (!transactionPath) fail('Transaction path is required.');
  const trusted = trustedRoots(transactionPath, roots);
  assertTrustedPath(transactionPath, trusted);
  assertRegularFileIfPresent(transactionPath, 'Transaction journal');
  const validatedSteps = validateSteps(steps, trusted);
  if (dryRun) return validatedSteps.map((step) => step.path);
  const lock = acquireLock(transactionPath, trusted);
  try {
    recoverJournal(transactionPath, trusted);
    const id = randomUUID();
    const transaction = {
      version: TRANSACTION_VERSION,
      id,
      phase: 'applying',
      steps: validatedSteps.map((step, index) => ({
        type: step.type,
        path: step.path,
        backup: backupPath(step.path, id, index),
        existed: existsSync(step.path)
      }))
    };
    writeAtomic(transactionPath, `${JSON.stringify(transaction)}\n`);
    for (const [index, step] of validatedSteps.entries()) {
      writeAtomic(transactionPath, `${JSON.stringify(transaction)}\n`);
      if (interruptAfterRecord === index + 1) {
        const error = new Error(`Injected transaction interruption after record ${index + 1}`);
        error.transactionInterrupted = true;
        throw error;
      }
      const backup = transaction.steps[index].backup;
      assertTrustedPath(backup, trusted);
      if (transaction.steps[index].existed) renameSync(step.path, backup);
      if (interruptAfterBackup === index + 1) {
        const error = new Error(`Injected transaction interruption after backup ${index + 1}`);
        error.transactionInterrupted = true;
        throw error;
      }
      if (step.type === 'write') writeAtomic(step.path, step.contents);
      if (step.type === 'tree') {
        mkdirSync(step.path, { recursive: true });
        for (const entry of step.entries) {
          const target = resolve(step.path, entry.path);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, entry.contents);
        }
        fsyncPath(step.path);
      }
      if (interruptAfterStep === index + 1) {
        const error = new Error(`Injected transaction interruption after step ${index + 1}`);
        error.transactionInterrupted = true;
        throw error;
      }
      if (failAfterStep === index + 1) throw new Error(`Injected transaction failure after step ${index + 1}`);
    }
    transaction.phase = 'committed';
    writeAtomic(transactionPath, `${JSON.stringify(transaction)}\n`);
    if (interruptAfterCommit) {
      const error = new Error('Injected transaction interruption after commit');
      error.transactionInterrupted = true;
      throw error;
    }
    recoverJournal(transactionPath, trusted);
    return validatedSteps.map((step) => step.path);
  } catch (error) {
    if (!error.transactionInterrupted) recoverJournal(transactionPath, trusted);
    throw error;
  } finally {
    releaseLock(lock);
  }
}
