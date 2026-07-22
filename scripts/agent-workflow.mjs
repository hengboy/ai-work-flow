#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const ROLE_CATALOG = readJson(resolve(ROOT, 'agents/roles.json'));
const DEFAULT_CONFIG = readJson(resolve(ROOT, 'agents/default-config.json'));
const MARKER_START = '<!-- ai-work-flow:agents:begin -->';
const MARKER_END = '<!-- ai-work-flow:agents:end -->';
const REASONING_VALUES = new Set(['low', 'medium', 'high']);
const PLATFORMS = new Set(['codex', 'claude', 'opencode']);

function usage() {
  return `Usage:
  node scripts/agent-workflow.mjs init --target <dir>
  node scripts/agent-workflow.mjs generate --target <dir> [--platform codex,claude,opencode] [--dry-run]
  node scripts/agent-workflow.mjs validate --target <dir>`;
}

function fail(message) {
  throw new Error(message);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`Cannot safely parse JSON at ${path}: ${error.message}`);
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') return { help: true };
  const options = { command, dryRun: false, platforms: [...PLATFORMS] };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--target' || arg === '--platform') {
      const value = rest[index + 1];
      if (!value || value.startsWith('--')) fail(`${arg} requires a value.`);
      index += 1;
      if (arg === '--target') options.target = resolve(value);
      else options.platforms = value.split(',').map((item) => item.trim()).filter(Boolean);
    } else fail(`Unknown argument: ${arg}`);
  }
  if (!['init', 'generate', 'validate'].includes(command)) fail(`Unknown command: ${command}`);
  if (!options.target) fail('--target is required.');
  for (const platform of options.platforms) {
    if (!PLATFORMS.has(platform)) fail(`Unknown platform: ${platform}`);
  }
  return options;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function merge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = key in result ? merge(result[key], value) : value;
  }
  return result;
}

function configPaths(target) {
  const dir = resolve(target, '.ai-work-flow/agents');
  return {
    dir,
    config: resolve(dir, 'config.json'),
    local: resolve(dir, 'config.local.json'),
    localExample: resolve(dir, 'config.local.example.json'),
    ignore: resolve(dir, '.gitignore'),
    routing: resolve(dir, 'routing.md')
  };
}

function loadConfig(target) {
  const paths = configPaths(target);
  if (!existsSync(paths.config)) {
    fail(`Missing ${paths.config}. Run init first.`);
  }
  const project = readJson(paths.config);
  const local = existsSync(paths.local) ? readJson(paths.local) : {};
  return { config: merge(merge(DEFAULT_CONFIG, project), local), paths };
}

function validateConfig(config) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(config) || config.version !== 1 || !isPlainObject(config.roles)) {
    return { errors: ['Configuration must contain version: 1 and a roles object.'], warnings };
  }
  const expected = new Set(ROLE_CATALOG.roles.map((role) => role.id));
  for (const id of Object.keys(config.roles)) {
    if (!expected.has(id)) errors.push(`Unknown role: ${id}.`);
  }
  for (const role of ROLE_CATALOG.roles) {
    const entry = config.roles[role.id];
    if (!isPlainObject(entry)) {
      errors.push(`Missing configuration for role: ${role.id}.`);
      continue;
    }
    for (const platform of ['codex', 'claude', 'opencode']) {
      if (!isPlainObject(entry[platform])) errors.push(`${role.id}.${platform} must be an object.`);
    }
    const codex = entry.codex;
    const claude = entry.claude;
    const opencode = entry.opencode;
    if (isPlainObject(codex)) {
      if (typeof codex.model !== 'string' || !codex.model) errors.push(`${role.id}.codex.model must be a non-empty string.`);
      if (!REASONING_VALUES.has(codex.reasoning)) errors.push(`${role.id}.codex.reasoning must be low, medium, or high.`);
    }
    if (isPlainObject(claude)) {
      if (typeof claude.model !== 'string' || !claude.model) errors.push(`${role.id}.claude.model must be a non-empty string.`);
      if (!REASONING_VALUES.has(claude.effort)) errors.push(`${role.id}.claude.effort must be low, medium, or high.`);
    }
    if (isPlainObject(opencode)) {
      if (opencode.model !== null && typeof opencode.model !== 'string') errors.push(`${role.id}.opencode.model must be a provider/model string or null.`);
      if (opencode.variant !== null && typeof opencode.variant !== 'string') errors.push(`${role.id}.opencode.variant must be a string or null.`);
      if (!isPlainObject(opencode.options)) errors.push(`${role.id}.opencode.options must be an object.`);
      if (!opencode.model) warnings.push(`${role.id}: OpenCode inherits the primary-session model; configure roles.${role.id}.opencode.model locally for an explicit provider/model.`);
      if (!opencode.variant && (!isPlainObject(opencode.options) || Object.keys(opencode.options).length === 0)) {
        warnings.push(`${role.id}: OpenCode does not map generic reasoning effort. Set its native variant or options locally when needed.`);
      }
    }
  }
  return { errors, warnings };
}

function roleInstructions(role) {
  const shared = [
    `You are ${role.name}. ${role.description}`,
    'Follow .ai-work-flow/agents/routing.md.',
    'Report completed work and git diff --name-only before returning.'
  ];
  if (role.id === 'coordinator') return [...shared, 'Do not access workspace files, shell, editing, or implementation tools. Delegate and summarize only.'];
  if (role.id === 'file-explorer') return [...shared, 'You alone own repository-wide enumeration, glob, grep, and code maps. Do not edit files.'];
  if (role.id === 'researcher') return [...shared, 'Use only external official sources. Do not inspect or modify the local workspace.'];
  if (role.id === 'document-maintainer') return [...shared, 'Write only ordinary documentation such as README and docs. Do not write plans, source, tests, or configuration.'];
  if (role.id === 'planning-writer') return [...shared, 'Write only plans, tasks, ADRs, handoffs, and tracker artifacts. Do not write source, tests, or ordinary documentation.'];
  if (role.id === 'full-stack-coder') return [...shared, 'Write source, tests, and required configuration. Do not write planning or ordinary documentation.'];
  if (role.id === 'code-reviewer') return [...shared, 'On a stable diff, delegate only Review Standards and Review Spec in parallel. Keep their findings separate. Do not edit files.'];
  return [...shared, 'Review only. Do not edit files or delegate.'];
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function codexSandbox(role) {
  if (role.workspace === 'none') return 'read-only';
  if (role.workspace === 'read') return 'read-only';
  return 'workspace-write';
}

function renderCodex(role, settings) {
  return [
    `name = ${tomlString(role.id)}`,
    `description = ${tomlString(role.description)}`,
    `model = ${tomlString(settings.model)}`,
    `model_reasoning_effort = ${tomlString(settings.reasoning)}`,
    `sandbox_mode = ${tomlString(codexSandbox(role))}`,
    `developer_instructions = ${tomlString(roleInstructions(role).join('\\n'))}`,
    ''
  ].join('\n');
}

function claudePermission(role) {
  if (role.workspace === 'none' || role.workspace === 'read') return 'plan';
  return 'acceptEdits';
}

function renderClaude(role, settings) {
  return [
    '---',
    `name: ${role.id}`,
    `description: ${JSON.stringify(role.description)}`,
    `model: ${settings.model}`,
    `effort: ${settings.effort}`,
    `tools: ${role.tools.join(', ') || 'Task'}`,
    `permissionMode: ${claudePermission(role)}`,
    '---',
    '',
    ...roleInstructions(role),
    ''
  ].join('\n');
}

function openCodePermission(role) {
  if (role.workspace === 'none') return { read: 'deny', edit: 'deny', bash: 'deny' };
  if (role.workspace === 'read') return { edit: 'deny' };
  return { edit: 'allow' };
}

function renderOpenCode(role, settings) {
  const frontmatter = [
    '---',
    `description: ${JSON.stringify(role.description)}`,
    `mode: ${role.kind === 'primary' ? 'primary' : 'subagent'}`,
    `permission: ${JSON.stringify(openCodePermission(role))}`
  ];
  if (settings.model) frontmatter.splice(3, 0, `model: ${settings.model}`);
  if (settings.variant) frontmatter.push(`variant: ${JSON.stringify(settings.variant)}`);
  if (isPlainObject(settings.options) && Object.keys(settings.options).length) frontmatter.push(`options: ${JSON.stringify(settings.options)}`);
  frontmatter.push('---', '', ...roleInstructions(role), '');
  return frontmatter.join('\n');
}

function assertSafeToml(source, path) {
  let quote = false;
  let square = 0;
  let curly = 0;
  for (const rawLine of source.split('\n')) {
    let line = '';
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
      line += char;
    }
    const text = line.trim();
    if (!text || quote || square < 0 || curly < 0) {
      if (quote || square < 0 || curly < 0) break;
      continue;
    }
    if (square === 0 && curly === 0 && !/^\[\[?[A-Za-z0-9_.-]+\]?\]$/.test(text) && !/^[A-Za-z0-9_.-]+\s*=\s*\S/.test(text)) break;
  }
  if (quote || square !== 0 || curly !== 0) fail(`Cannot safely parse existing TOML at ${path}. Add agents.max_depth = 2 manually.`);
  for (const rawLine of source.split('\n')) {
    const text = rawLine.replace(/#.*/, '').trim();
    if (!text || /^\[\[?[A-Za-z0-9_.-]+\]?\]$/.test(text) || /^[A-Za-z0-9_.-]+\s*=\s*\S/.test(text)) continue;
    fail(`Cannot safely parse existing TOML at ${path}. Add agents.max_depth = 2 manually.`);
  }
  if ((source.match(/^\[agents\]\s*$/gm) || []).length > 1) {
    fail(`Cannot safely update duplicate [agents] tables in ${path}. Add max_depth = 2 manually.`);
  }
}

function updateCodexConfig(source, path) {
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

function markerBlock(kind) {
  const content = kind === 'claude'
    ? '@.ai-work-flow/agents/routing.md\n\nUse the Coordinator as the only user-facing agent and delegate all work by the role rules above.'
    : 'Use `.ai-work-flow/agents/routing.md`. The Coordinator is dispatch-only: it does not inspect, edit, or implement. Delegate every workspace operation to the specialized agents.';
  return `${MARKER_START}\n## AI Work Flow Agents\n\n${content}\n${MARKER_END}\n`;
}

function updateMarker(source, kind, path) {
  const starts = (source.match(new RegExp(MARKER_START, 'g')) || []).length;
  const ends = (source.match(new RegExp(MARKER_END, 'g')) || []).length;
  if (starts !== ends || starts > 1) fail(`Cannot safely update workflow marker in ${path}. Repair the marker block manually.`);
  const block = markerBlock(kind);
  if (starts === 1) {
    const pattern = new RegExp(`${escapeRegExp(MARKER_START)}[\\s\\S]*?${escapeRegExp(MARKER_END)}\\n?`);
    return source.replace(pattern, block);
  }
  return `${source.replace(/\s*$/, '')}${source.trim() ? '\n\n' : ''}${block}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function write(path, contents, dryRun, changed) {
  const before = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  if (before === contents) return;
  changed.push(path);
  if (!dryRun) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
}

function init(target) {
  const paths = configPaths(target);
  const changed = [];
  if (!existsSync(paths.config)) write(paths.config, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, false, changed);
  const example = {
    roles: {
      'full-stack-coder': {
        opencode: { model: 'provider/model', variant: 'native-reasoning-variant', options: {} }
      }
    }
  };
  if (!existsSync(paths.localExample)) write(paths.localExample, `${JSON.stringify(example, null, 2)}\n`, false, changed);
  const ignore = existsSync(paths.ignore) ? readFileSync(paths.ignore, 'utf8') : '';
  if (!ignore.split('\n').includes('config.local.json')) {
    write(paths.ignore, `${ignore}${ignore && !ignore.endsWith('\n') ? '\n' : ''}config.local.json\n`, false, changed);
  }
  write(paths.routing, readFileSync(resolve(ROOT, 'agents/routing.md'), 'utf8'), false, changed);
  return changed;
}

function generate(target, platforms, dryRun) {
  const { config, paths } = loadConfig(target);
  const validation = validateConfig(config);
  if (validation.errors.length) fail(validation.errors.join('\n'));
  const changed = [];
  const codexConfigPath = resolve(target, '.codex/config.toml');
  const openCodeConfigPath = resolve(target, 'opencode.json');
  const agentsPath = resolve(target, 'AGENTS.md');
  const claudePath = resolve(target, 'CLAUDE.md');
  let codexConfig;
  let openCodeConfig;
  let agentsMarker;
  let claudeMarker;

  // Validate every existing file before replacing a generated agent file.
  if (platforms.includes('codex')) {
    const current = existsSync(codexConfigPath) ? readFileSync(codexConfigPath, 'utf8') : '';
    codexConfig = updateCodexConfig(current, codexConfigPath);
    agentsMarker = updateMarker(existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '', 'codex', agentsPath);
  }
  if (platforms.includes('claude')) {
    claudeMarker = updateMarker(existsSync(claudePath) ? readFileSync(claudePath, 'utf8') : '', 'claude', claudePath);
  }
  if (platforms.includes('opencode')) {
    const current = existsSync(openCodeConfigPath) ? readJson(openCodeConfigPath) : {};
    if (!isPlainObject(current)) fail(`Cannot safely merge ${openCodeConfigPath}: root must be an object.`);
    if (current.agent !== undefined && !isPlainObject(current.agent)) {
      fail(`Cannot safely merge ${openCodeConfigPath}: agent must be an object. Disable explore manually.`);
    }
    openCodeConfig = `${JSON.stringify({ ...current, agent: { ...(current.agent ?? {}), explore: false } }, null, 2)}\n`;
    agentsMarker ??= updateMarker(existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '', 'codex', agentsPath);
  }
  if (platforms.includes('codex')) {
    for (const role of ROLE_CATALOG.roles) {
      write(resolve(target, `.codex/agents/${role.id}.toml`), renderCodex(role, config.roles[role.id].codex), dryRun, changed);
    }
    write(codexConfigPath, codexConfig, dryRun, changed);
    write(agentsPath, agentsMarker, dryRun, changed);
  }
  if (platforms.includes('claude')) {
    for (const role of ROLE_CATALOG.roles) {
      write(resolve(target, `.claude/agents/${role.id}.md`), renderClaude(role, config.roles[role.id].claude), dryRun, changed);
    }
    write(claudePath, claudeMarker, dryRun, changed);
  }
  if (platforms.includes('opencode')) {
    for (const role of ROLE_CATALOG.roles) {
      write(resolve(target, `.opencode/agents/${role.id}.md`), renderOpenCode(role, config.roles[role.id].opencode), dryRun, changed);
    }
    write(openCodeConfigPath, openCodeConfig, dryRun, changed);
    write(agentsPath, agentsMarker, dryRun, changed);
  }
  return { changed, warnings: validation.warnings, paths };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return console.log(usage());
  if (options.command === 'init') {
    const changed = init(options.target);
    console.log(`Initialized ${configPaths(options.target).dir}`);
    for (const path of changed) console.log(`WRITE ${path}`);
    return;
  }
  const { config } = loadConfig(options.target);
  const validation = validateConfig(config);
  if (options.command === 'validate') {
    for (const message of validation.errors) console.error(`ERROR ${message}`);
    for (const message of validation.warnings) console.warn(`WARNING ${message}`);
    if (validation.errors.length) process.exitCode = 1;
    else console.log('Configuration is valid.');
    return;
  }
  if (validation.errors.length) fail(validation.errors.join('\n'));
  const result = generate(options.target, options.platforms, options.dryRun);
  for (const message of result.warnings) console.warn(`WARNING ${message}`);
  console.log(`${options.dryRun ? 'Would write' : 'Generated'} ${result.changed.length} file(s).`);
  for (const path of result.changed) console.log(`${options.dryRun ? 'WRITE' : 'WROTE'} ${path}`);
}

try {
  main();
} catch (error) {
  console.error(`agent-workflow: ${error.message}`);
  process.exitCode = 1;
}
