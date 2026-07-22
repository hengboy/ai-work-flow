import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { fail, write } from '../shared.mjs';

const MARKER_START = '<!-- ai-work-flow:agents:begin -->';
const MARKER_END = '<!-- ai-work-flow:agents:end -->';

function tomlString(value) {
  return JSON.stringify(String(value));
}

function agentDescription(role) {
  return `**${role.name}**: ${role.description}`;
}

function sandbox(role) {
  return role.workspace === 'none' || role.workspace === 'read' ? 'read-only' : 'workspace-write';
}

function render(role, settings, body) {
  return [
    `name = ${tomlString(role.id)}`,
    `description = ${tomlString(agentDescription(role))}`,
    `model = ${tomlString(settings.model)}`,
    `model_reasoning_effort = ${tomlString(settings.reasoning)}`,
    `sandbox_mode = ${tomlString(sandbox(role))}`,
    `developer_instructions = ${tomlString(body.replaceAll('\n', '\\n'))}`,
    ''
  ].join('\n');
}

function assertSafeToml(source, path) {
  let quote = false;
  let square = 0;
  let curly = 0;
  for (const rawLine of source.split('\n')) {
    for (let index = 0; index < rawLine.length; index += 1) {
      const char = rawLine[index];
      const escaped = index > 0 && rawLine[index - 1] === '\\';
      if (char === '"' && !escaped) quote = !quote;
      if (char === '#' && !quote) break;
      if (!quote) {
        if (char === '[') square += 1;
        if (char === ']') square -= 1;
        if (char === '{') curly += 1;
        if (char === '}') curly -= 1;
      }
    }
  }
  if (quote || square !== 0 || curly !== 0) fail(`Cannot safely parse existing TOML at ${path}. Add agents.max_depth = 2 manually.`);
  if ((source.match(/^\[agents\]\s*$/gm) || []).length > 1) {
    fail(`Cannot safely update duplicate [agents] tables in ${path}. Add max_depth = 2 manually.`);
  }
}

function updateConfig(source, path) {
  assertSafeToml(source, path);
  const direct = /^(agents\.max_depth\s*=\s*)(\d+)(\s*(?:#.*)?)$/m;
  if (direct.test(source)) return source.replace(direct, (_, prefix, value, suffix) => `${prefix}${Math.max(2, Number(value))}${suffix}`);
  const table = /^\[agents\]\s*$/m;
  if (!table.test(source)) return `${source.replace(/\s*$/, '')}${source.trim() ? '\n\n' : ''}[agents]\nmax_depth = 2\n`;
  const start = source.search(table);
  const bodyStart = source.indexOf('\n', start) + 1;
  const nextTable = source.slice(bodyStart).search(/^\[/m);
  const end = nextTable === -1 ? source.length : bodyStart + nextTable;
  const body = source.slice(bodyStart, end);
  const existing = /^(max_depth\s*=\s*)(\d+)(\s*(?:#.*)?)$/m;
  if (existing.test(body)) {
    const updated = body.replace(existing, (_, prefix, value, suffix) => `${prefix}${Math.max(2, Number(value))}${suffix}`);
    return `${source.slice(0, bodyStart)}${updated}${source.slice(end)}`;
  }
  return `${source.slice(0, end)}${body.endsWith('\n') || !body ? '' : '\n'}max_depth = 2\n${source.slice(end)}`;
}

function markerBlock() {
  return `${MARKER_START}\n## AI Work Flow 代理\n\n使用 \`~/.config/ai-work-flow/routing.md\`。**Coordinator** 只负责调度：不得检查、编辑或实施。所有工作区操作都必须委派给专职角色。\n${MARKER_END}\n`;
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

export function generateCodex({ paths, roles, config, bodies, dryRun }) {
  const changed = [];
  const configPath = resolve(paths.codexDir, 'config.toml');
  const agentsPath = resolve(paths.codexDir, 'AGENTS.md');
  const configContents = updateConfig(existsSync(configPath) ? readFileSync(configPath, 'utf8') : '', configPath);
  const markerContents = updateMarker(existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '', agentsPath);
  for (const role of roles) {
    write(resolve(paths.codexDir, `agents/${role.id}.toml`), render(role, config.roles[role.id].codex, bodies.get(role.id)), dryRun, changed);
  }
  write(configPath, configContents, dryRun, changed);
  write(agentsPath, markerContents, dryRun, changed);
  return changed;
}
