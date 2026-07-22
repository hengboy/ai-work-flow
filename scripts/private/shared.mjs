import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function fail(message) {
  throw new Error(message);
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`Cannot safely parse JSON at ${path}: ${error.message}`);
  }
}

export function write(path, contents, dryRun, changed) {
  const before = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  if (before === contents) return;
  changed.push(path);
  if (!dryRun) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
}
