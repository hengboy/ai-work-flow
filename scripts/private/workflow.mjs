import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { loadAgentAssets } from './asset-catalog.mjs';
import { globalPaths } from './paths.mjs';
import { fail, isPlainObject, mergeRoles, readJson, write } from './shared.mjs';
import { applyGenerationPlan, planGeneration } from './platform-adapter.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SKILLS_ROOT = resolve(ROOT, 'skills');
const PLATFORMS = new Set(['codex', 'claude', 'opencode']);
const REASONING_VALUES = new Set(['low', 'medium', 'high']);
const OBSOLETE_PRIMARY_AGENT_ID = ['coord', 'inator'].join('');

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

function planInstallLifecycle() {
  const skillDirectories = readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, source: resolve(SKILLS_ROOT, entry.name) }));
  const sourceDir = resolve(import.meta.dirname, '..');
  const entry = existsSync(resolve(sourceDir, 'install.mjs')) ? 'install.mjs' : 'agent-workflow.mjs';
  if (!existsSync(resolve(sourceDir, entry))) fail(`Missing workflow runtime entry: ${entry}`);
  return { skillDirectories, sourceDir, entry };
}

function installSkills(lifecycle, dryRun) {
  if (dryRun) return;
  const paths = globalPaths();
  const destinations = [
    resolve(paths.codexDir, 'skills'),
    resolve(paths.claudeDir, 'skills'),
    resolve(paths.openCodeDir, 'skills')
  ];
  for (const { name, source } of lifecycle.skillDirectories) {
    for (const destination of destinations) {
      cpSync(source, resolve(destination, name), { recursive: true, force: true });
    }
  }
  for (const destination of destinations) {
    for (const path of [
      resolve(destination, 'run-matt-spec-to-completion', 'lib', `execution-${OBSOLETE_PRIMARY_AGENT_ID}.mjs`),
      resolve(destination, 'run-matt-spec-to-completion', 'test', `execution-${OBSOLETE_PRIMARY_AGENT_ID}.test.mjs`)
    ]) {
      if (existsSync(path)) unlinkSync(path);
    }
  }
}

function installRuntime(assets, lifecycle, dryRun) {
  if (dryRun) return;
  const { dir } = globalPaths();
  mkdirSync(dir, { recursive: true });
  cpSync(resolve(lifecycle.sourceDir, lifecycle.entry), resolve(dir, 'agent-workflow.mjs'), { force: true });
  cpSync(resolve(import.meta.dirname), resolve(dir, 'private'), { recursive: true, force: true });
  cpSync(assets.root, resolve(dir, 'agent-assets'), { recursive: true, force: true });
  const obsoleteBody = resolve(dir, 'agent-assets', 'bodies', `${OBSOLETE_PRIMARY_AGENT_ID}.md`);
  if (existsSync(obsoleteBody)) unlinkSync(obsoleteBody);
}

function loadConfig(assets, allowDefaults = false) {
  const paths = globalPaths();
  if (!existsSync(paths.defaultEnvironment)) {
    if (allowDefaults) return { config: assets.defaults, paths };
    fail(`Missing ${paths.defaultEnvironment}. Run init first.`);
  }
  const baseConfig = readJson(paths.defaultEnvironment);
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
  console.log(`  ${currentEnv === null || currentEnv === 'default' ? '*' : ' '} default`);
  
  if (!existsSync(paths.environments)) {
    return;
  }
  
  const files = readdirSync(paths.environments).filter((file) => file.endsWith('.json') && file !== 'default.json');
  for (const file of files) {
    const name = file.replace(/\.json$/, '');
    const marker = name === currentEnv ? '*' : ' ';
    console.log(`  ${marker} ${name}`);
  }
}

function useEnvironment(name) {
  const paths = globalPaths();
  
  if (name === 'default') {
    if (!existsSync(paths.defaultEnvironment)) {
      fail(`Missing ${paths.defaultEnvironment}. Run init first.`);
    }
    if (existsSync(paths.environmentMarker)) {
      unlinkSync(paths.environmentMarker);
      console.log('Switched to default environment.');
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
  
  if (!existsSync(paths.defaultEnvironment)) {
    fail(`Missing ${paths.defaultEnvironment}. Run init first.`);
  }
  
  const envPath = resolve(paths.environments, `${name}.json`);
  if (existsSync(envPath)) {
    fail(`Environment already exists: ${name}`);
  }
  
  const baseConfig = readJson(paths.defaultEnvironment);
  const resolvedConfig = resolveConfig(baseConfig, paths);
  
  mkdirSync(paths.environments, { recursive: true });
  writeFileSync(envPath, `${JSON.stringify(resolvedConfig, null, 2)}\n`);
  console.log(`Created environment: ${name}`);
  console.log(`WRITE ${envPath}`);
}

function deleteEnvironment(name) {
  const paths = globalPaths();
  if (name === 'default') {
    fail('The default environment cannot be deleted.');
  }
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
  if (!existsSync(paths.defaultEnvironment)) write(paths.defaultEnvironment, `${JSON.stringify(assets.defaults, null, 2)}\n`, dryRun, changed);
  write(paths.routing, assets.routing, dryRun, changed);
  return changed;
}

function generate(platforms, dryRun, assets, config = loadConfig(assets, dryRun).config) {
  const result = planGenerationFor(platforms, assets, config);
  return { ...result, changed: applyGenerationPlan(result.plan, dryRun) };
}

function planGenerationFor(platforms, assets, config) {
  const paths = globalPaths();
  const validation = validateConfig(config, assets.roles);
  if (validation.errors.length) fail(validation.errors.join('\n'));
  const plan = platforms.flatMap((platform) => planGeneration({ platform, paths, roles: assets.roles, config, bodies: assets.bodies }));
  return { plan, warnings: validation.warnings, paths };
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
  if (options.command === 'install') {
    const lifecycle = planInstallLifecycle();
    const { config } = loadConfig(assets, true);
    const generation = planGenerationFor(options.platforms, assets, config);
    installSkills(lifecycle, options.dryRun);
    const changed = init(assets, options.dryRun);
    console.log(`Initialized ${globalPaths().dir}`);
    for (const path of changed) console.log(`WRITE ${path}`);
    installRuntime(assets, lifecycle, options.dryRun);
    const generated = applyGenerationPlan(generation.plan, options.dryRun);
    for (const message of generation.warnings) console.warn(`WARNING ${message}`);
    console.log(`${options.dryRun ? 'Would write' : 'Generated'} ${generated.length} file(s).`);
    for (const path of generated) console.log(`${options.dryRun ? 'WRITE' : 'WROTE'} ${path}`);
    return;
  }
  if (options.command === 'init') {
    const changed = init(assets, options.dryRun);
    console.log(`Initialized ${globalPaths().dir}`);
    for (const path of changed) console.log(`WRITE ${path}`);
    return;
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
