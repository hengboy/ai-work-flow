import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { loadAgentAssets } from './asset-catalog.mjs';
import { globalPaths } from './paths.mjs';
import { fail, isPlainObject, readJson, write } from './shared.mjs';
import { generate as generatePlatform } from './platform-adapter.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SKILLS_ROOT = resolve(ROOT, 'skills');
const PLATFORMS = new Set(['codex', 'claude', 'opencode']);
const REASONING_VALUES = new Set(['low', 'medium', 'high']);

function usage() {
  return `Usage:
  node scripts/install.mjs [--platform codex,claude,opencode] [--dry-run]
  node scripts/install.mjs init [--dry-run]
  node scripts/install.mjs generate [--platform codex,claude,opencode] [--dry-run]
  node scripts/install.mjs validate`;
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

function installRuntime(assets, dryRun) {
  if (dryRun) return;
  const { dir } = globalPaths();
  const sourceDir = resolve(import.meta.dirname, '..');
  const entry = existsSync(resolve(sourceDir, 'install.mjs')) ? 'install.mjs' : 'agent-workflow.mjs';
  mkdirSync(dir, { recursive: true });
  cpSync(resolve(sourceDir, entry), resolve(dir, 'agent-workflow.mjs'), { force: true });
  cpSync(resolve(import.meta.dirname), resolve(dir, 'private'), { recursive: true, force: true });
  cpSync(assets.root, resolve(dir, 'agent-assets'), { recursive: true, force: true });
}

function loadConfig(assets, allowDefaults = false) {
  const paths = globalPaths();
  if (!existsSync(paths.config)) {
    if (allowDefaults) return { config: assets.defaults, paths };
    fail(`Missing ${paths.config}. Run init first.`);
  }
  return { config: readJson(paths.config), paths };
}

function validateConfig(config, roles) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(config) || config.version !== 1 || !isPlainObject(config.roles)) {
    return { errors: ['Configuration must contain version: 1 and a roles object.'], warnings };
  }
  const expected = new Set(roles.map((role) => role.id));
  for (const id of Object.keys(config.roles)) {
    if (!expected.has(id)) errors.push(`Unknown role: ${id}.`);
  }
  for (const role of roles) {
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
      if (typeof codex.reasoning !== 'string' || !codex.reasoning) errors.push(`${role.id}.codex.reasoning must be a non-empty string.`);
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

function init(assets, dryRun) {
  const paths = globalPaths();
  const changed = [];
  if (!existsSync(paths.config)) write(paths.config, `${JSON.stringify(assets.defaults, null, 2)}\n`, dryRun, changed);
  write(paths.routing, assets.routing, dryRun, changed);
  return changed;
}

function generate(platforms, dryRun, assets, config = loadConfig(assets, dryRun).config) {
  const paths = globalPaths();
  const validation = validateConfig(config, assets.roles);
  if (validation.errors.length) fail(validation.errors.join('\n'));
  const changed = [];
  for (const platform of platforms) {
    changed.push(...generatePlatform({ platform, paths, roles: assets.roles, config, bodies: assets.bodies, dryRun }));
  }
  return { changed, warnings: validation.warnings, paths };
}

export function runCli(argv) {
  const options = parseArgs(argv);
  if (options.help) return console.log(usage());
  // The catalog is validated before any lifecycle step can write global files.
  const assets = loadAgentAssets();
  if (options.command === 'install') installSkills(options.dryRun);
  if (options.command === 'init' || options.command === 'install') {
    const changed = init(assets, options.dryRun);
    console.log(`Initialized ${globalPaths().dir}`);
    for (const path of changed) console.log(`WRITE ${path}`);
    if (options.command === 'init') return;
    installRuntime(assets, options.dryRun);
  }
  const { config } = loadConfig(assets, options.command === 'install' && options.dryRun);
  const validation = validateConfig(config, assets.roles);
  if (options.command === 'validate') {
    for (const message of validation.errors) console.error(`ERROR ${message}`);
    for (const message of validation.warnings) console.warn(`WARNING ${message}`);
    if (validation.errors.length) process.exitCode = 1;
    else console.log('Configuration is valid.');
    return;
  }
  if (validation.errors.length) fail(validation.errors.join('\n'));
  const result = generate(options.platforms, options.dryRun, assets, config);
  for (const message of result.warnings) console.warn(`WARNING ${message}`);
  console.log(`${options.dryRun ? 'Would write' : 'Generated'} ${result.changed.length} file(s).`);
  for (const path of result.changed) console.log(`${options.dryRun ? 'WRITE' : 'WROTE'} ${path}`);
}
