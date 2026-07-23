import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

import { fail, isPlainObject, write } from './shared.mjs';

// --- Shared functions ---

function agentDescription(role) {
  return `**${role.name}**: ${role.description}`;
}

const MARKER_START = '<!-- ai-work-flow:agents:begin -->';
const MARKER_END = '<!-- ai-work-flow:agents:end -->';

function markerBlock() {
  return `${MARKER_START}\n## AI Work Flow 代理\n\n仅当使用 **Coordinator** 代理时，遵循 \`~/.config/ai-work-flow/routing.md\` 进行子代理委派。其他代理模式下保持原生行为，按需调用子代理。\n${MARKER_END}\n`;
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

// --- Codex strategy ---

function tomlString(value) {
  return JSON.stringify(String(value));
}

function codexSandbox(role) {
  return role.workspace === 'none' || role.workspace === 'read' ? 'read-only' : 'workspace-write';
}

function codexRender(role, settings, body) {
  return [
    `name = ${tomlString(role.id)}`,
    `description = ${tomlString(agentDescription(role))}`,
    `model = ${tomlString(settings.model)}`,
    `model_reasoning_effort = ${tomlString(settings.reasoning)}`,
    `sandbox_mode = ${tomlString(codexSandbox(role))}`,
    `developer_instructions = ${tomlString(body.replaceAll('\n', '\\n'))}`,
    ''
  ].join('\n');
}

function codexAssertSafeToml(source, path) {
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

function codexUpdateConfig(source, path) {
  codexAssertSafeToml(source, path);
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

// --- Claude strategy ---

function claudePermission(role) {
  return role.workspace === 'none' || role.workspace === 'read' ? 'plan' : 'acceptEdits';
}

function claudeRender(role, settings, body) {
  return [
    '---',
    `name: ${role.id}`,
    `description: ${JSON.stringify(agentDescription(role))}`,
    `model: ${settings.model}`,
    `effort: ${settings.effort}`,
    `tools: ${role.tools.join(', ') || 'Task'}`,
    `permissionMode: ${claudePermission(role)}`,
    '---',
    '',
    body,
    ''
  ].join('\n');
}

// --- OpenCode strategy ---

function opencodePermission(role) {
  if (role.workspace === 'none') return { read: 'deny', edit: 'deny', bash: 'deny' };
  if (role.workspace === 'read') return { read: 'allow', edit: 'deny', bash: 'deny' };
  return { edit: 'allow' };
}

function opencodeRender(role, settings, body) {
  const frontmatter = [
    '---',
    `description: ${JSON.stringify(agentDescription(role))}`,
    `mode: ${role.kind === 'primary' ? 'primary' : 'subagent'}`,
    `permission: ${JSON.stringify(opencodePermission(role))}`
  ];
  if (settings.model) frontmatter.splice(3, 0, `model: ${settings.model}`);
  if (settings.variant) frontmatter.push(`variant: ${JSON.stringify(settings.variant)}`);
  if (isPlainObject(settings.options) && Object.keys(settings.options).length) frontmatter.push(`options: ${JSON.stringify(settings.options)}`);
  frontmatter.push('---', '', body, '');
  return frontmatter.join('\n');
}

function opencodeUpdateConfig(source) {
  const current = source ? JSON.parse(source) : {};
  if (!isPlainObject(current)) fail(`Cannot safely merge opencode.json: root must be an object.`);
  if (current.agent !== undefined && !isPlainObject(current.agent)) {
    fail(`Cannot safely merge opencode.json: agent must be an object.`);
  }
  const agent = { ...(current.agent ?? {}) };
  if (agent.explore === false) delete agent.explore;
  return `${JSON.stringify({ ...current, agent, default_agent: 'coordinator' }, null, 2)}\n`;
}

// --- Strategy map ---

const strategies = {
  codex: {
    agentDir: 'codexDir',
    extension: 'toml',
    render: codexRender,
    globalConfig: {
      path: (paths) => resolve(paths.codexDir, 'config.toml'),
      update: codexUpdateConfig
    },
    marker: {
      path: (paths) => resolve(paths.codexDir, 'AGENTS.md'),
      update: updateMarker
    }
  },
  claude: {
    agentDir: 'claudeDir',
    extension: 'md',
    render: claudeRender,
    marker: {
      path: (paths) => resolve(paths.claudeDir, 'CLAUDE.md'),
      update: updateMarker
    }
  },
  opencode: {
    agentDir: 'openCodeDir',
    extension: 'md',
    render: opencodeRender,
    globalConfig: {
      path: (paths) => resolve(paths.openCodeDir, 'opencode.json'),
      update: opencodeUpdateConfig
    },
    cleanup: (paths, dryRun, changed) => {
      const guardPath = resolve(paths.openCodeDir, 'plugins/ai-work-flow-subagent-model-guard.js');
      if (!existsSync(guardPath)) return;
      changed.push(guardPath);
      if (!dryRun) unlinkSync(guardPath);
    }
  }
};

// --- Entry point ---

export function generate({ platform, paths, roles, config, bodies, dryRun }) {
  const strategy = strategies[platform];
  const changed = [];

  if (strategy.globalConfig) {
    const configPath = strategy.globalConfig.path(paths);
    const source = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
    const contents = strategy.globalConfig.update(source, configPath);
    write(configPath, contents, dryRun, changed);
  }

  if (strategy.marker) {
    const markerPath = strategy.marker.path(paths);
    const source = existsSync(markerPath) ? readFileSync(markerPath, 'utf8') : '';
    const contents = strategy.marker.update(source, markerPath);
    write(markerPath, contents, dryRun, changed);
  }

  const agentDir = resolve(paths[strategy.agentDir], 'agents');
  for (const role of roles) {
    write(
      resolve(agentDir, `${role.id}.${strategy.extension}`),
      strategy.render(role, config.roles[role.id][platform], bodies.get(role.id)),
      dryRun,
      changed
    );
  }

  if (strategy.cleanup) {
    strategy.cleanup(paths, dryRun, changed);
  }

  return changed;
}
