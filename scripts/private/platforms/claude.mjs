import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { fail, write } from '../shared.mjs';

const MARKER_START = '<!-- ai-work-flow:agents:begin -->';
const MARKER_END = '<!-- ai-work-flow:agents:end -->';

function agentDescription(role) {
  return `**${role.name}**: ${role.description}`;
}

function permission(role) {
  return role.workspace === 'none' || role.workspace === 'read' ? 'plan' : 'acceptEdits';
}

function render(role, settings, body) {
  return [
    '---',
    `name: ${role.id}`,
    `description: ${JSON.stringify(agentDescription(role))}`,
    `model: ${settings.model}`,
    `effort: ${settings.effort}`,
    `tools: ${role.tools.join(', ') || 'Task'}`,
    `permissionMode: ${permission(role)}`,
    '---',
    '',
    body,
    ''
  ].join('\n');
}

function markerBlock() {
  return `${MARKER_START}\n## AI Work Flow 代理\n\n@~/.config/ai-work-flow/routing.md\n\n使用 **Coordinator** 作为唯一面向用户的角色，并按照上述角色规则委派所有工作。\n${MARKER_END}\n`;
}

function updateMarker(source, path) {
  const starts = (source.match(new RegExp(MARKER_START, 'g')) || []).length;
  const ends = (source.match(new RegExp(MARKER_END, 'g')) || []).length;
  if (starts !== ends || starts > 1) fail(`Cannot safely update workflow marker in ${path}. Repair the marker block manually.`);
  if (starts === 1) {
    const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return source.replace(new RegExp(`${escape(MARKER_START)}[\\s\\S]*?${escape(MARKER_END)}\\n?`), markerBlock());
  }
  return `${source.replace(/\s*$/, '')}${source.trim() ? '\n\n' : ''}${markerBlock()}`;
}

export function generateClaude({ paths, roles, config, bodies, dryRun }) {
  const changed = [];
  const claudePath = resolve(paths.claudeDir, 'CLAUDE.md');
  const markerContents = updateMarker(existsSync(claudePath) ? readFileSync(claudePath, 'utf8') : '', claudePath);
  for (const role of roles) {
    write(resolve(paths.claudeDir, `agents/${role.id}.md`), render(role, config.roles[role.id].claude, bodies.get(role.id)), dryRun, changed);
  }
  write(claudePath, markerContents, dryRun, changed);
  return changed;
}
