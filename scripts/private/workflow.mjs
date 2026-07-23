import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { loadAgentAssets } from './asset-catalog.mjs';
import { globalPaths } from './paths.mjs';
import { fail, isPlainObject, mergeRoles, readJson, write } from './shared.mjs';
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
  node scripts/install.mjs validate
  node scripts/install.mjs env
  node scripts/install.mjs env use <name>
  node scripts/install.mjs env create <name>
  node scripts/install.mjs env delete <name>`;
}

function parseArgs(argv) {
  if (argv[0] === '--help' || argv[0] === '-h') return { help: true };
  const hasCommand = argv[0] && !argv[0].startsWith('--');
  const command = hasCommand ? argv[0] : 'install';
  const rest = hasCommand ? argv.slice(1) : argv;
  const options = { command, dryRun: false, platforms: [...PLATFORMS] };
  
  if (command === 'env') {
    options.envAction = rest[0];
    options.envName = rest[1];
    return options;
  }
  
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
  const baseConfig = readJson(paths.config);
  return { config: resolveConfig(baseConfig, paths), paths };
}

function resolveConfig(baseConfig, paths) {
  if (!existsSync(paths.environmentMarker)) {
    return baseConfig;
  }
  const envName = readFileSync(paths.environmentMarker, 'utf8').trim();
  const envPath = resolve(paths.environments, `${envName}.json`);
  if (!existsSync(envPath)) {
    fail(`Environment file not found: ${envPath}`);
  }
  const envConfig = readJson(envPath);
  return {
    version: baseConfig.version,
    roles: mergeRoles(baseConfig.roles, envConfig.roles || {})
  };
}

function listEnvironments() {
  const paths = globalPaths();
  const currentEnv = existsSync(paths.environmentMarker) 
    ? readFileSync(paths.environmentMarker, 'utf8').trim() 
    : null;
  
  console.log('Available environments:');
  console.log('  * default (no environment selected)');
  
  if (!existsSync(paths.environments)) {
    return;
  }
  
  const files = readdirSync(paths.environments).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const name = file.replace(/\.json$/, '');
    const marker = name === currentEnv ? '*' : ' ';
    console.log(`  ${marker} ${name}`);
  }
}

function useEnvironment(name) {
  const paths = globalPaths();
  
  if (name === 'default') {
    if (existsSync(paths.environmentMarker)) {
      unlinkSync(paths.environmentMarker);
      console.log('Switched to default environment (no environment selected).');
    } else {
      console.log('Already using default environment.');
    }
    return;
  }
  
  const envPath = resolve(paths.environments, `${name}.json`);
  if (!existsSync(envPath)) {
    fail(`Environment not found: ${name}`);
  }
  
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.environmentMarker, name);
  console.log(`Switched to environment: ${name}`);
}

function createEnvironment(name) {
  const paths = globalPaths();
  
  if (!existsSync(paths.config)) {
    fail(`Missing ${paths.config}. Run init first.`);
  }
  
  const envPath = resolve(paths.environments, `${name}.json`);
  if (existsSync(envPath)) {
    fail(`Environment already exists: ${name}`);
  }
  
  const baseConfig = readJson(paths.config);
  const resolvedConfig = resolveConfig(baseConfig, paths);
  
  mkdirSync(paths.environments, { recursive: true });
  writeFileSync(envPath, `${JSON.stringify(resolvedConfig, null, 2)}\n`);
  console.log(`Created environment: ${name}`);
  console.log(`WRITE ${envPath}`);
}

function deleteEnvironment(name) {
  const paths = globalPaths();
  const envPath = resolve(paths.environments, `${name}.json`);
  
  if (!existsSync(envPath)) {
    fail(`Environment not found: ${name}`);
  }
  
  const currentEnv = existsSync(paths.environmentMarker) 
    ? readFileSync(paths.environmentMarker, 'utf8').trim() 
    : null;
  
  if (name === currentEnv) {
    unlinkSync(paths.environmentMarker);
    console.log(`Deleted environment: ${name} (was active, switched to default)`);
  } else {
    console.log(`Deleted environment: ${name}`);
  }
  
  unlinkSync(envPath);
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
  
  if (options.command === 'env') {
    if (!options.envAction || options.envAction === 'list') {
      listEnvironments();
      return;
    }
    if (options.envAction === 'use') {
      if (!options.envName) fail('env use requires an environment name.');
      useEnvironment(options.envName);
      return;
    }
    if (options.envAction === 'create') {
      if (!options.envName) fail('env create requires an environment name.');
      createEnvironment(options.envName);
      return;
    }
    if (options.envAction === 'delete') {
      if (!options.envName) fail('env delete requires an environment name.');
      deleteEnvironment(options.envName);
      return;
    }
    fail(`Unknown env action: ${options.envAction}`);
  }
  
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
