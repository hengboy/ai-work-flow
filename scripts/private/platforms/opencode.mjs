import { existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

import { fail, isPlainObject, readJson, write } from '../shared.mjs';

function agentDescription(role) {
  return `**${role.name}**: ${role.description}`;
}

function permission(role) {
  if (role.workspace === 'none') return { read: 'deny', edit: 'deny', bash: 'deny' };
  if (role.workspace === 'read') return { read: 'allow', edit: 'deny', bash: 'deny' };
  return { edit: 'allow' };
}

function render(role, settings, body) {
  const frontmatter = [
    '---',
    `description: ${JSON.stringify(agentDescription(role))}`,
    `mode: ${role.kind === 'primary' ? 'primary' : 'subagent'}`,
    `permission: ${JSON.stringify(permission(role))}`
  ];
  if (settings.model) frontmatter.splice(3, 0, `model: ${settings.model}`);
  if (settings.variant) frontmatter.push(`variant: ${JSON.stringify(settings.variant)}`);
  if (isPlainObject(settings.options) && Object.keys(settings.options).length) frontmatter.push(`options: ${JSON.stringify(settings.options)}`);
  frontmatter.push('---', '', body, '');
  return frontmatter.join('\n');
}

function removeModelGuard(path, dryRun, changed) {
  if (!existsSync(path)) return;
  changed.push(path);
  if (!dryRun) unlinkSync(path);
}

function updateConfig(path) {
  const current = existsSync(path) ? readJson(path) : {};
  if (!isPlainObject(current)) fail(`Cannot safely merge ${path}: root must be an object.`);
  if (current.agent !== undefined && !isPlainObject(current.agent)) {
    fail(`Cannot safely merge ${path}: agent must be an object.`);
  }
  const agent = { ...(current.agent ?? {}) };
  // OpenCode expects agent.explore to be an object when present; older output used false.
  if (agent.explore === false) delete agent.explore;
  return `${JSON.stringify({ ...current, agent, default_agent: 'coordinator' }, null, 2)}\n`;
}

export function generateOpenCode({ paths, roles, config, bodies, dryRun }) {
  const changed = [];
  const configPath = resolve(paths.openCodeDir, 'opencode.json');
  const modelGuardPath = resolve(paths.openCodeDir, 'plugins/ai-work-flow-subagent-model-guard.js');
  const configContents = updateConfig(configPath);
  for (const role of roles) {
    write(resolve(paths.openCodeDir, `agents/${role.id}.md`), render(role, config.roles[role.id].opencode, bodies.get(role.id)), dryRun, changed);
  }
  // OpenCode applies the model and variant declared in each subagent's frontmatter.
  // A post-start guard cannot safely replace an in-flight native task.
  removeModelGuard(modelGuardPath, dryRun, changed);
  write(configPath, configContents, dryRun, changed);
  return changed;
}
