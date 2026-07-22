#!/usr/bin/env node
import { cpSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const ROOT = resolve(import.meta.dirname, '..');
const skillsRoot = resolve(ROOT, 'skills');
const home = homedir();
const configHome = process.env.XDG_CONFIG_HOME ? resolve(process.env.XDG_CONFIG_HOME) : resolve(home, '.config');
const destinations = [
  resolve(home, '.codex/skills'),
  resolve(home, '.claude/skills'),
  resolve(configHome, 'opencode/skills')
];

for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const source = resolve(skillsRoot, entry.name);
  for (const destination of destinations) {
    cpSync(source, resolve(destination, entry.name), { recursive: true, force: true });
  }
}

const workflow = resolve(skillsRoot, 'setup-ai-work-flow/scripts/agent-workflow.mjs');
const result = spawnSync(process.execPath, [workflow, 'setup'], { encoding: 'utf8' });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) process.exitCode = result.status ?? 1;
