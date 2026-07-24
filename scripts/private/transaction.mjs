import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { fail } from './shared.mjs';

function writeAtomic(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = resolve(dirname(path), `.${randomUUID()}.tmp`);
  writeFileSync(temporary, contents);
  renameSync(temporary, path);
}

function backupPath(path, id, index) {
  return resolve(dirname(path), `.${id}.${index}.ai-work-flow-backup`);
}

export function recoverTransaction(transactionPath) {
  if (!existsSync(transactionPath)) return false;
  const transaction = JSON.parse(readFileSync(transactionPath, 'utf8'));
  if (transaction.phase === 'committed') {
    for (const step of transaction.steps) rmSync(step.backup, { force: true });
    rmSync(transactionPath, { force: true });
    return true;
  }
  for (const step of [...transaction.steps].reverse()) {
    if (existsSync(step.backup)) {
      rmSync(step.path, { force: true });
      renameSync(step.backup, step.path);
    } else if (!step.existed) {
      rmSync(step.path, { force: true });
    }
  }
  rmSync(transactionPath, { force: true });
  return true;
}

export function applyTransaction(steps, { transactionPath, dryRun = false, failAfterStep, interruptAfterRecord, interruptAfterBackup, interruptAfterStep, interruptAfterCommit } = {}) {
  if (dryRun) return steps.map((step) => step.path);
  if (!transactionPath) fail('Transaction path is required.');
  recoverTransaction(transactionPath);
  const id = randomUUID();
  const transaction = { version: 1, id, phase: 'applying', steps: [] };
  mkdirSync(dirname(transactionPath), { recursive: true });
  writeAtomic(transactionPath, `${JSON.stringify(transaction)}\n`);
  try {
    for (const [index, step] of steps.entries()) {
      const existed = existsSync(step.path);
      const backup = backupPath(step.path, id, index);
      const record = { path: step.path, backup, existed };
      transaction.steps.push(record);
      writeAtomic(transactionPath, `${JSON.stringify(transaction)}\n`);
      if (interruptAfterRecord === index + 1) {
        const error = new Error(`Injected transaction interruption after record ${index + 1}`);
        error.transactionInterrupted = true;
        throw error;
      }
      if (existed) renameSync(step.path, backup);
      if (interruptAfterBackup === index + 1) {
        const error = new Error(`Injected transaction interruption after backup ${index + 1}`);
        error.transactionInterrupted = true;
        throw error;
      }
      if (step.type === 'write') writeAtomic(step.path, step.contents);
      if (step.type !== 'write' && step.type !== 'delete') fail(`Unknown transaction step type: ${step.type}`);
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
    for (const step of transaction.steps) rmSync(step.backup, { force: true });
    rmSync(transactionPath, { force: true });
    return steps.map((step) => step.path);
  } catch (error) {
    if (error.transactionInterrupted) throw error;
    recoverTransaction(transactionPath);
    throw error;
  }
}
