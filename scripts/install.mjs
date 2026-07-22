#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const ROOT = resolve(import.meta.dirname, '..');
const SKILLS_ROOT = resolve(ROOT, 'skills');
const AGENT_ASSETS = resolve(import.meta.dirname, 'agent-assets');
const ROLE_CATALOG = readJson(resolve(AGENT_ASSETS, 'roles.json'));
const DEFAULT_CONFIG = readJson(resolve(AGENT_ASSETS, 'default-config.json'));
const MARKER_START = '<!-- ai-work-flow:agents:begin -->';
const MARKER_END = '<!-- ai-work-flow:agents:end -->';
const REASONING_VALUES = new Set(['low', 'medium', 'high']);
const PLATFORMS = new Set(['codex', 'claude', 'opencode']);

function usage() {
  return `Usage:
  node scripts/install.mjs [--platform codex,claude,opencode] [--dry-run]
  node scripts/install.mjs init [--dry-run]
  node scripts/install.mjs generate [--platform codex,claude,opencode] [--dry-run]
  node scripts/install.mjs validate`;
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
  if (argv[0] === '--help' || argv[0] === '-h') return { help: true };
  const hasCommand = argv[0] && !argv[0].startsWith('--');
  const command = hasCommand ? argv[0] : 'install';
  const rest = hasCommand ? argv.slice(1) : argv;
  const options = { command, dryRun: false, platforms: [...PLATFORMS] };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--platform') {
      const value = rest[index + 1];
      if (!value || value.startsWith('--')) fail(`${arg} requires a value.`);
      index += 1;
      options.platforms = value.split(',').map((item) => item.trim()).filter(Boolean);
    } else fail(`Unknown argument: ${arg}`);
  }
  if (!['install', 'init', 'generate', 'validate'].includes(command)) fail(`Unknown command: ${command}`);
  for (const platform of options.platforms) {
    if (!PLATFORMS.has(platform)) fail(`Unknown platform: ${platform}`);
  }
  return options;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function globalPaths() {
  const home = homedir();
  const configHome = process.env.XDG_CONFIG_HOME ? resolve(process.env.XDG_CONFIG_HOME) : resolve(home, '.config');
  const dir = resolve(configHome, 'ai-work-flow');
  return {
    dir,
    config: resolve(dir, 'config.json'),
    routing: resolve(dir, 'routing.md'),
    codexDir: resolve(home, '.codex'),
    claudeDir: resolve(home, '.claude'),
    openCodeDir: resolve(configHome, 'opencode')
  };
}

function installSkills(dryRun) {
  if (dryRun) return;
  const paths = globalPaths();
  const destinations = [
    resolve(paths.codexDir, 'skills'),
    resolve(paths.claudeDir, 'skills'),
    resolve(paths.openCodeDir, 'skills')
  ];
  for (const entry of readdirSync(SKILLS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = resolve(SKILLS_ROOT, entry.name);
    for (const destination of destinations) {
      cpSync(source, resolve(destination, entry.name), { recursive: true, force: true });
    }
  }
}

function installRuntime(dryRun) {
  if (dryRun) return;
  const { dir } = globalPaths();
  mkdirSync(dir, { recursive: true });
  cpSync(import.meta.filename, resolve(dir, 'agent-workflow.mjs'), { force: true });
  cpSync(AGENT_ASSETS, resolve(dir, 'agent-assets'), { recursive: true, force: true });
}

function loadConfig(allowDefaults = false) {
  const paths = globalPaths();
  if (!existsSync(paths.config)) {
    if (allowDefaults) return { config: DEFAULT_CONFIG, paths };
    fail(`Missing ${paths.config}. Run init first.`);
  }
  return { config: readJson(paths.config), paths };
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

function loadAgentBodyTemplate(role) {
  const path = resolve(AGENT_ASSETS, 'bodies', `${role.id}.md`);
  try {
    return readFileSync(path, 'utf8').trimEnd();
  } catch (error) {
    fail(`Cannot read agent body template at ${path}: ${error.message}`);
  }
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function codexSandbox(role) {
  if (role.workspace === 'none') return 'read-only';
  if (role.workspace === 'read') return 'read-only';
  return 'workspace-write';
}

function renderCodex(role, settings, body) {
  return [
    `name = ${tomlString(role.id)}`,
    `description = ${tomlString(role.description)}`,
    `model = ${tomlString(settings.model)}`,
    `model_reasoning_effort = ${tomlString(settings.reasoning)}`,
    `sandbox_mode = ${tomlString(codexSandbox(role))}`,
    `developer_instructions = ${tomlString(body.replaceAll('\n', '\\n'))}`,
    ''
  ].join('\n');
}

function claudePermission(role) {
  if (role.workspace === 'none' || role.workspace === 'read') return 'plan';
  return 'acceptEdits';
}

function renderClaude(role, settings, body) {
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
    body,
    ''
  ].join('\n');
}

function openCodePermission(role) {
  if (role.workspace === 'none') return { read: 'deny', edit: 'deny', bash: 'deny' };
  if (role.workspace === 'read') return { edit: 'deny' };
  return { edit: 'allow' };
}

function renderOpenCode(role, settings, body) {
  const frontmatter = [
    '---',
    `description: ${JSON.stringify(role.description)}`,
    `mode: ${role.kind === 'primary' ? 'primary' : 'subagent'}`,
    `permission: ${JSON.stringify(openCodePermission(role))}`
  ];
  if (settings.model) frontmatter.splice(3, 0, `model: ${settings.model}`);
  if (settings.variant) frontmatter.push(`variant: ${JSON.stringify(settings.variant)}`);
  if (isPlainObject(settings.options) && Object.keys(settings.options).length) frontmatter.push(`options: ${JSON.stringify(settings.options)}`);
  frontmatter.push('---', '', body, '');
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
  }
  if (quote || square !== 0 || curly !== 0) fail(`Cannot safely parse existing TOML at ${path}. Add agents.max_depth = 2 manually.`);
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
    ? '@~/.config/ai-work-flow/routing.md\n\n使用协调者作为唯一面向用户的角色，并按照上述角色规则委派所有工作。'
    : '使用 `~/.config/ai-work-flow/routing.md`。协调者只负责调度：不得检查、编辑或实施。所有工作区操作都必须委派给专职角色。';
  return `${MARKER_START}\n## AI Work Flow 代理\n\n${content}\n${MARKER_END}\n`;
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

function init(dryRun) {
  const paths = globalPaths();
  const changed = [];
  if (!existsSync(paths.config)) write(paths.config, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, dryRun, changed);
  write(paths.routing, readFileSync(resolve(AGENT_ASSETS, 'routing.md'), 'utf8'), dryRun, changed);
  return changed;
}

function generate(platforms, dryRun, config = loadConfig(dryRun).config) {
  const paths = globalPaths();
  const validation = validateConfig(config);
  if (validation.errors.length) fail(validation.errors.join('\n'));
  const roleBodies = new Map(ROLE_CATALOG.roles.map((role) => [role.id, loadAgentBodyTemplate(role)]));
  const changed = [];
  const codexConfigPath = resolve(paths.codexDir, 'config.toml');
  const openCodeConfigPath = resolve(paths.openCodeDir, 'opencode.json');
  const agentsPath = resolve(paths.codexDir, 'AGENTS.md');
  const claudePath = resolve(paths.claudeDir, 'CLAUDE.md');
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
      fail(`Cannot safely merge ${openCodeConfigPath}: agent must be an object.`);
    }
    const agent = { ...(current.agent ?? {}) };
    // OpenCode expects agent.explore to be an object when present; older output used false.
    if (agent.explore === false) delete agent.explore;
    openCodeConfig = `${JSON.stringify({ ...current, agent, default_agent: 'coordinator' }, null, 2)}\n`;
  }
  if (platforms.includes('codex')) {
    for (const role of ROLE_CATALOG.roles) {
      write(resolve(paths.codexDir, `agents/${role.id}.toml`), renderCodex(role, config.roles[role.id].codex, roleBodies.get(role.id)), dryRun, changed);
    }
    write(codexConfigPath, codexConfig, dryRun, changed);
    write(agentsPath, agentsMarker, dryRun, changed);
  }
  if (platforms.includes('claude')) {
    for (const role of ROLE_CATALOG.roles) {
      write(resolve(paths.claudeDir, `agents/${role.id}.md`), renderClaude(role, config.roles[role.id].claude, roleBodies.get(role.id)), dryRun, changed);
    }
    write(claudePath, claudeMarker, dryRun, changed);
  }
  if (platforms.includes('opencode')) {
    for (const role of ROLE_CATALOG.roles) {
      write(resolve(paths.openCodeDir, `agents/${role.id}.md`), renderOpenCode(role, config.roles[role.id].opencode, roleBodies.get(role.id)), dryRun, changed);
    }
    write(openCodeConfigPath, openCodeConfig, dryRun, changed);
  }
  return { changed, warnings: validation.warnings, paths };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return console.log(usage());
  if (options.command === 'install') installSkills(options.dryRun);
  if (options.command === 'init' || options.command === 'install') {
    const changed = init(options.dryRun);
    console.log(`Initialized ${globalPaths().dir}`);
    for (const path of changed) console.log(`WRITE ${path}`);
    if (options.command === 'init') return;
    installRuntime(options.dryRun);
  }
  const { config } = loadConfig(options.command === 'install' && options.dryRun);
  const validation = validateConfig(config);
  if (options.command === 'validate') {
    for (const message of validation.errors) console.error(`ERROR ${message}`);
    for (const message of validation.warnings) console.warn(`WARNING ${message}`);
    if (validation.errors.length) process.exitCode = 1;
    else console.log('Configuration is valid.');
    return;
  }
  if (validation.errors.length) fail(validation.errors.join('\n'));
  const result = generate(options.platforms, options.dryRun, config);
  for (const message of result.warnings) console.warn(`WARNING ${message}`);
  console.log(`${options.dryRun ? 'Would write' : 'Generated'} ${result.changed.length} file(s).`);
  for (const path of result.changed) console.log(`${options.dryRun ? 'WRITE' : 'WROTE'} ${path}`);
}

try {
  main();
} catch (error) {
  console.error(`ai-work-flow: ${error.message}`);
  process.exitCode = 1;
}
