import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import process from 'node:process';

import { loadAgentAssets } from './asset-catalog.mjs';
import { assertEnvironmentName, assertSafeEnvironmentPaths, environmentPath, loadResolvedConfiguration, validateConfiguration } from './config.mjs';
import { globalPaths } from './paths.mjs';
import { fail, readJson, write } from './shared.mjs';
import { applyGenerationPlan, capabilityMatrix, planGeneration } from './platform-adapter.mjs';
import { applyTransaction, recoverTransaction } from './transaction.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SKILLS_ROOT = resolve(ROOT, 'skills');
const PLATFORMS = new Set(['codex', 'claude', 'opencode']);
const OBSOLETE_PRIMARY_AGENT_ID = ['coord', 'inator'].join('');

function usage() {
  return `Usage:
  node scripts/install.mjs [--platform codex,claude,opencode] [--dry-run]
  node scripts/install.mjs init [--dry-run]
  node scripts/install.mjs generate [--platform codex,claude,opencode] [--dry-run]
  node scripts/install.mjs validate
  node scripts/install.mjs env
  node scripts/install.mjs env use <name> [--dry-run]
  node scripts/install.mjs env status
  node scripts/install.mjs env create <name> [--minimal]
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
    for (const arg of rest.slice(2)) {
      if (arg === '--dry-run') options.dryRun = true;
      else if (arg === '--minimal' && options.envAction === 'create') options.minimal = true;
      else fail(`Unknown argument: ${arg}`);
    }
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
  cpSync(SKILLS_ROOT, resolve(dir, 'skills'), { recursive: true, force: true });
  cpSync(resolve(ROOT, 'execution-runtime'), resolve(dir, 'execution-runtime'), { recursive: true, force: true });
  const obsoleteBody = resolve(dir, 'agent-assets', 'bodies', `${OBSOLETE_PRIMARY_AGENT_ID}.md`);
  if (existsSync(obsoleteBody)) unlinkSync(obsoleteBody);
}

function loadConfig(assets, allowDefaults = false) {
  const paths = globalPaths();
  assertSafeEnvironmentPaths(paths);
  if (!existsSync(paths.defaultEnvironment)) {
    if (allowDefaults) return { config: assets.defaults, paths };
    fail(`Missing ${paths.defaultEnvironment}. Run init first.`);
  }
  return { config: loadResolvedConfiguration({ paths, roles: assets.roles }).config, paths };
}

function listEnvironments() {
  const paths = globalPaths();
  assertSafeEnvironmentPaths(paths);
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

function managedPlatforms(paths) {
  if (!existsSync(paths.managedPlatforms)) return [...PLATFORMS];
  const value = readJson(paths.managedPlatforms);
  return Array.isArray(value.platforms) && value.platforms.every((platform) => PLATFORMS.has(platform)) ? value.platforms : [...PLATFORMS];
}

function writeManagedPlatforms(paths, platforms, dryRun) {
  const contents = `${JSON.stringify({ version: 1, platforms: [...new Set(platforms)].sort() }, null, 2)}\n`;
  applyTransaction([{ type: 'write', path: paths.managedPlatforms, contents }], { transactionPath: paths.generationTransaction, dryRun });
}

function useEnvironment(name, assets, dryRun) {
  const paths = globalPaths();
  assertSafeEnvironmentPaths(paths);
  if (!existsSync(paths.defaultEnvironment)) fail(`Missing ${paths.defaultEnvironment}. Run init first.`);
  if (name !== 'default') assertEnvironmentName(name);
  const resolved = loadResolvedConfiguration({ paths, roles: assets.roles, environmentName: name });
  const platforms = managedPlatforms(paths);
  const generation = planGenerationFor(platforms, assets, resolved.config);
  const marker = name === 'default'
    ? { type: 'delete', path: paths.environmentMarker }
    : { type: 'write', path: paths.environmentMarker, contents: name };
  const plan = [...generation.plan, marker];
  for (const step of plan) console.log(`${dryRun ? 'WRITE' : 'APPLY'} ${step.path}`);
  applyGenerationPlan(plan, dryRun, paths.generationTransaction);
  for (const message of generation.warnings) console.warn(`WARNING ${message}`);
  console.log(`${dryRun ? 'Would activate' : 'Activated'} environment: ${name}`);
}

function createEnvironment(name, minimal) {
  const paths = globalPaths();
  assertEnvironmentName(name);
  assertSafeEnvironmentPaths(paths);
  if (!existsSync(paths.defaultEnvironment)) {
    fail(`Missing ${paths.defaultEnvironment}. Run init first.`);
  }
  
  const envPath = environmentPath(paths, name);
  try {
    const entry = lstatSync(envPath);
    if (entry.isSymbolicLink()) fail(`Environment file must not be a symbolic link: ${envPath}`);
    fail(`Environment already exists: ${name}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  
  const assets = loadAgentAssets();
  const resolvedConfig = loadResolvedConfiguration({ paths, roles: assets.roles }).config;
  
  mkdirSync(paths.environments, { recursive: true });
  assertSafeEnvironmentPaths(paths);
  try {
    writeFileSync(envPath, `${JSON.stringify(minimal ? { version: 1, roles: {} } : resolvedConfig, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') fail(`Environment file must not be replaced or followed: ${envPath}`);
    throw error;
  }
  console.log(`Created environment: ${name}`);
  console.log(`WRITE ${envPath}`);
}

function deleteEnvironment(name) {
  const paths = globalPaths();
  if (name === 'default') {
    fail('The default environment cannot be deleted.');
  }
  assertEnvironmentName(name);
  assertSafeEnvironmentPaths(paths);
  const envPath = environmentPath(paths, name);
  let entry;
  try {
    entry = lstatSync(envPath);
  } catch (error) {
    if (error.code === 'ENOENT') fail(`Environment not found: ${name}`);
    throw error;
  }
  if (entry.isSymbolicLink()) fail(`Environment file must not be a symbolic link: ${envPath}`);
  if (!entry.isFile()) fail(`Environment path must be a regular file: ${envPath}`);
  
  const currentEnv = existsSync(paths.environmentMarker) 
    ? readFileSync(paths.environmentMarker, 'utf8').trim() 
    : null;
  
  if (name === currentEnv) {
    applyTransaction([
      { type: 'delete', path: paths.environmentMarker },
      { type: 'delete', path: envPath },
    ], { transactionPath: paths.generationTransaction });
    console.log(`Deleted environment: ${name} (was active, switched to default)`);
  } else {
    applyTransaction([{ type: 'delete', path: envPath }], { transactionPath: paths.generationTransaction });
    console.log(`Deleted environment: ${name}`);
  }
}

function init(assets, dryRun) {
  const paths = globalPaths();
  assertSafeEnvironmentPaths(paths);
  const changed = [];
  if (!existsSync(paths.defaultEnvironment)) write(paths.defaultEnvironment, `${JSON.stringify(assets.defaults, null, 2)}\n`, dryRun, changed);
  write(paths.routing, assets.routing, dryRun, changed);
  return changed;
}

function generate(platforms, dryRun, assets, config = loadConfig(assets, dryRun).config) {
  const result = planGenerationFor(platforms, assets, config);
  return { ...result, changed: applyGenerationPlan(result.plan, dryRun, result.paths.generationTransaction) };
}

function planGenerationFor(platforms, assets, config) {
  const paths = globalPaths();
  const validation = validateConfiguration({ base: config, roles: assets.roles, platforms });
  if (validation.errors.length) fail(validation.errors.join('\n'));
  const plan = platforms.flatMap((platform) => planGeneration({ platform, paths, roles: assets.roles, policies: assets.policies, config, bodies: assets.bodies }));
  return { plan, warnings: validation.warnings, paths };
}

function generationDigest(platform, assets, config) {
  const inputs = assets.roles.map((role) => ({
    id: role.id,
    policy: assets.policies[role.policy],
    settings: config.roles[role.id][platform],
    body: assets.bodies.get(role.id)
  }));
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}

function reportCapabilities(platforms, assets, config) {
  for (const platform of platforms) {
    console.log(`Generation digest ${platform}: ${generationDigest(platform, assets, config)}`);
    for (const role of assets.roles) {
      const matrix = capabilityMatrix(platform, assets.policies[role.policy]);
      const report = Object.entries(matrix).map(([capability, level]) => `${capability}=${level}`).join(', ');
      console.log(`CAPABILITY ${platform}/${role.id}: ${report}`);
      const warnings = Object.entries(matrix).filter(([, level]) => level !== 'enforced').map(([capability, level]) => `${capability}=${level}`);
      if (warnings.length) console.warn(`WARNING ${platform}/${role.id}: ${warnings.join(', ')}`);
    }
  }
}

export function runCli(argv) {
  const options = parseArgs(argv);
  if (options.help) return console.log(usage());
  const paths = globalPaths();
  if (recoverTransaction(paths.generationTransaction)) console.warn('Recovered an interrupted generation transaction.');
  
  if (options.command === 'env') {
    if (!options.envAction || options.envAction === 'list') {
      listEnvironments();
      return;
    }
    if (options.envAction === 'use') {
      if (!options.envName) fail('env use requires an environment name.');
      useEnvironment(options.envName, loadAgentAssets(), options.dryRun);
      return;
    }
    if (options.envAction === 'status') {
      const assets = loadAgentAssets();
      const resolved = loadResolvedConfiguration({ paths, roles: assets.roles });
      const digest = createHash('sha256').update(JSON.stringify(resolved.config)).digest('hex');
      console.log(`Environment: ${resolved.name}`);
      console.log(`Resolved config digest: ${digest}`);
      for (const platform of managedPlatforms(paths)) {
        const generated = planGenerationFor([platform], assets, resolved.config).plan.length === 0;
        console.log(`${platform}: ${generated ? 'in sync' : 'drifted'}`);
      }
      reportCapabilities(managedPlatforms(paths), assets, resolved.config);
      return;
    }
    if (options.envAction === 'create') {
      if (!options.envName) fail('env create requires an environment name.');
      createEnvironment(options.envName, options.minimal);
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
    const generated = applyGenerationPlan(generation.plan, options.dryRun, generation.paths.generationTransaction);
    writeManagedPlatforms(generation.paths, options.platforms, options.dryRun);
    for (const message of generation.warnings) console.warn(`WARNING ${message}`);
    reportCapabilities(options.platforms, assets, config);
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
  const validation = validateConfiguration({ base: config, roles: assets.roles, platforms: options.command === 'generate' ? options.platforms : [...PLATFORMS] });
  if (options.command === 'validate') {
    for (const message of validation.errors) console.error(`ERROR ${message}`);
    for (const message of validation.warnings) console.warn(`WARNING ${message}`);
    if (validation.errors.length) process.exitCode = 1;
    else console.log('Configuration is valid.');
    return;
  }
  if (validation.errors.length) fail(validation.errors.join('\n'));
  const result = generate(options.platforms, options.dryRun, assets, config);
  writeManagedPlatforms(result.paths, [...managedPlatforms(result.paths), ...options.platforms], options.dryRun);
  for (const message of result.warnings) console.warn(`WARNING ${message}`);
  reportCapabilities(options.platforms, assets, config);
  console.log(`${options.dryRun ? 'Would write' : 'Generated'} ${result.changed.length} file(s).`);
  for (const path of result.changed) console.log(`${options.dryRun ? 'WRITE' : 'WROTE'} ${path}`);
}
