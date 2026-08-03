import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import process from 'node:process';

import { loadAgentAssets } from './asset-catalog.mjs';
import { assertEnvironmentName, assertSafeEnvironmentPaths, environmentPath, loadResolvedConfiguration, validateConfiguration } from './config.mjs';
import { globalPaths } from './paths.mjs';
import { fail, isPlainObject, readJson, write } from './shared.mjs';
import { applyGenerationPlan, capabilityMatrix, controlMatrix, generationStatus, planGeneration } from './platform-adapter.mjs';
import { applyTransaction, recoverTransaction } from './transaction.mjs';

const runtimeProvenanceModulePath = [
  resolve(import.meta.dirname, '..', '..', 'execution-runtime', 'lib', 'runtime-provenance.mjs'),
  resolve(import.meta.dirname, '..', 'execution-runtime', 'lib', 'runtime-provenance.mjs')
].find((candidate) => existsSync(candidate));
if (!runtimeProvenanceModulePath) throw new Error('Missing execution runtime provenance module');
const { loadAndAssertRuntimeProvenance, RUNTIME_PROVENANCE_EXCLUDED_DIRECTORIES } = await import(runtimeProvenanceModulePath);

const ROOT = resolve(import.meta.dirname, '..', '..');
const SKILLS_ROOT = resolve(ROOT, 'skills');
const PLATFORMS = new Set(['codex', 'claude', 'opencode']);
const LEGACY_PRIMARY_AGENT_ID = 'orchestrator';
const LEGACY_GIT_OPERATOR_AGENT_ID = 'git-committer';
const INSTALL_MISSING_ROLE_DEFAULTS = ['planning', 'planning-writer', 'task-planner', 'bug-fixer'];
const OBSOLETE_SKILL = `run-${['m', 'att'].join('')}-spec-to-completion`;
const OBSOLETE_EXECUTION_RUNTIME_FILES = [
  `${['check', 'point-schema.json'].join('')}`,
  'completion-result-schema.json',
  `${['execution', '-cli.mjs'].join('')}`,
  `${['execution', '-plan-schema.json'].join('')}`,
  'handoff-result-schema.json',
  'package-lock.json',
  'package.json',
  `${['state', '-store.mjs'].join('')}`,
  `lib/${['check', 'point-integrity.mjs'].join('')}`,
  `lib/${['check', 'point.mjs'].join('')}`,
  'lib/completion-adapter.mjs',
  'lib/execution-coding.mjs',
  'lib/integration-lifecycle.mjs',
  'lib/issue-tracker.mjs',
  'lib/pre-merge-stash.mjs',
  'lib/review-result.mjs',
  'lib/spec-intake.mjs',
  `lib/${['tick', 'et-frontier.mjs'].join('')}`,
  'lib/time.mjs',
  'lib/validation.mjs',
  'lib/worktree-lifecycle.mjs'
];
const LEGACY_ROLE_RENAMES = new Map([
  [LEGACY_PRIMARY_AGENT_ID, 'coding'],
  [LEGACY_GIT_OPERATOR_AGENT_ID, 'git-operator']
]);

function compatibilityRoleDefaults(assets) {
  return { 'bug-fixer': assets.defaults.roles['bug-fixer'] };
}

function usage() {
  return `Usage:
  node agent-build/install.mjs [--platform codex,claude,opencode] [--dry-run]
  node agent-build/install.mjs init [--dry-run]
  node agent-build/install.mjs generate [--platform codex,claude,opencode] [--dry-run]
  node agent-build/install.mjs validate
  node agent-build/install.mjs env
  node agent-build/install.mjs env use <name> [--dry-run]
  node agent-build/install.mjs env status
  node agent-build/install.mjs env create <name>
  node agent-build/install.mjs env delete <name>`;
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
    for (const argument of rest.slice(2)) {
      if (argument === '--dry-run' && options.envAction === 'use') options.dryRun = true;
      else fail(`Unknown argument: ${argument}`);
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
  const skillsRoot = [SKILLS_ROOT, resolve(import.meta.dirname, '..', 'skills')].find((candidate) => existsSync(candidate));
  if (!skillsRoot) fail('Missing managed skills');
  const skillDirectories = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(resolve(skillsRoot, entry.name, 'SKILL.md')))
    .map((entry) => ({ name: entry.name, source: resolve(skillsRoot, entry.name) }));
  if (!skillDirectories.length) fail('Missing managed skills');
  const sourceDir = resolve(import.meta.dirname, '..');
  const entry = existsSync(resolve(sourceDir, 'install.mjs')) ? 'install.mjs' : 'agent-workflow.mjs';
  if (!existsSync(resolve(sourceDir, entry))) fail(`Missing workflow runtime entry: ${entry}`);
  return { skillDirectories, sourceDir, entry };
}

function addWriteStep(plan, path, contents) {
  if (existsSync(path)) {
    const entry = lstatSync(path);
    if (entry.isFile() && readFileSync(path, 'utf8') === contents) return;
  }
  plan.push({ type: 'write', path, contents });
}

function addSourceTree(plan, source, destination, excludedNames = new Set()) {
  for (const entry of readdirSync(source, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory() && excludedNames.has(entry.name)) continue;
    const sourcePath = resolve(source, entry.name);
    const destinationPath = resolve(destination, entry.name);
    if (entry.isDirectory()) addSourceTree(plan, sourcePath, destinationPath, excludedNames);
    else if (entry.isFile()) addWriteStep(plan, destinationPath, readFileSync(sourcePath, 'utf8'));
    else fail(`Install source must contain only regular files and directories: ${sourcePath}`);
  }
}

function sourceTreeEntries(source, prefix = '', excludedNames = new Set()) {
  const entries = [];
  for (const entry of readdirSync(source, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (excludedNames.has(entry.name)) continue;
    const sourcePath = resolve(source, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) entries.push(...sourceTreeEntries(sourcePath, relativePath, excludedNames));
    else if (entry.isFile()) entries.push({ path: relativePath, contents: readFileSync(sourcePath, 'utf8') });
    else fail(`Install source must contain only regular files and directories: ${sourcePath}`);
  }
  return entries;
}

function assertSourceRuntimeProvenance(source) {
  try {
    return loadAndAssertRuntimeProvenance(source).provenance;
  } catch (error) {
    fail(`Execution runtime source provenance is stale or invalid. Regenerate it before install/generate: ${error.message}`);
  }
}

function treeMatches(destination, entries, excludedNames = new Set()) {
  if (!existsSync(destination)) return false;
  const installed = [];
  const visit = (directory, prefix = '') => {
    const root = lstatSync(directory);
    if (root.isSymbolicLink() || !root.isDirectory()) return false;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (excludedNames.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!visit(path, relativePath)) return false;
      } else if (entry.isFile()) installed.push({ path: relativePath, contents: readFileSync(path, 'utf8') });
      else return false;
    }
    return true;
  };
  if (!visit(destination) || installed.length !== entries.length) return false;
  return entries.every((entry, index) => entry.path === installed[index].path && entry.contents === installed[index].contents);
}

function addTreeStep(plan, source, destination, excludedNames = new Set()) {
  const entries = sourceTreeEntries(source, '', excludedNames);
  if (!treeMatches(destination, entries, excludedNames)) plan.push({ type: 'tree', path: destination, entries });
}

function planCoreRuntime(assets, lifecycle, paths) {
  const plan = [];
  addWriteStep(plan, resolve(paths.dir, 'agent-workflow.mjs'), readFileSync(resolve(lifecycle.sourceDir, lifecycle.entry), 'utf8'));
  addSourceTree(plan, resolve(import.meta.dirname), resolve(paths.dir, 'runtime'));
  addSourceTree(plan, assets.configRoot, resolve(paths.dir, 'config'));
  addSourceTree(plan, assets.templatesRoot, resolve(paths.dir, 'templates'));
  for (const { name, source } of lifecycle.skillDirectories) {
    addTreeStep(plan, source, resolve(paths.dir, 'skills', name), new Set(['node_modules']));
  }
  for (const legacyRoleId of LEGACY_ROLE_RENAMES.keys()) {
    const legacyBody = resolve(paths.dir, 'templates', `${legacyRoleId}.md`);
    if (existsSync(legacyBody)) plan.push({ type: 'delete', path: legacyBody });
  }
  return plan;
}

function planManagedSkills(lifecycle, paths, platforms = [...PLATFORMS]) {
  const plan = [];
  const destinations = {
    codex: resolve(paths.codexDir, 'skills'),
    claude: resolve(paths.claudeDir, 'skills'),
    opencode: resolve(paths.openCodeDir, 'skills')
  };
  for (const { name, source } of lifecycle.skillDirectories) {
    for (const platform of platforms) addTreeStep(plan, source, resolve(destinations[platform], name), new Set(['node_modules']));
  }
  return plan;
}

function planExecutionRuntime(paths) {
  const plan = [];
  const source = [resolve(ROOT, 'execution-runtime'), resolve(import.meta.dirname, '..', 'execution-runtime')].find((candidate) => existsSync(candidate));
  if (!source) fail('Missing execution runtime');
  assertSourceRuntimeProvenance(source);
  addSourceTree(plan, source, resolve(paths.dir, 'execution-runtime'), new Set(RUNTIME_PROVENANCE_EXCLUDED_DIRECTORIES));
  return plan;
}

function hasPathEntry(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function planObsoleteManagedContent(paths) {
  const plan = [];
  for (const platformRoot of [paths.codexDir, paths.claudeDir, paths.openCodeDir, paths.dir]) {
    const skill = resolve(platformRoot, 'skills', OBSOLETE_SKILL);
    if (hasPathEntry(skill)) plan.push({ type: 'delete-tree', path: skill });
  }
  const installedRuntime = resolve(paths.dir, 'execution-runtime');
  for (const relativePath of OBSOLETE_EXECUTION_RUNTIME_FILES) {
    const target = resolve(installedRuntime, relativePath);
    if (hasPathEntry(target)) plan.push({ type: 'delete', path: target });
  }
  return plan;
}

function loadConfig(assets, allowDefaults = false, platforms = [...PLATFORMS]) {
  const paths = globalPaths();
  assertSafeEnvironmentPaths(paths);
  if (!existsSync(paths.defaultEnvironment)) {
    if (allowDefaults) {
      const validation = validateConfiguration({ base: assets.defaults, roles: assets.roles, platforms });
      if (validation.errors.length) fail(validation.errors.join('\n'));
      return { config: validation.config, warnings: validation.warnings, paths };
    }
    fail(`Missing ${paths.defaultEnvironment}. Run init first.`);
  }
  return {
    ...loadResolvedConfiguration({
      paths,
      roles: assets.roles,
      platforms,
      missingRoleDefaults: compatibilityRoleDefaults(assets)
    }),
    paths
  };
}

function planLegacyRoleMigrations(paths) {
  if (!existsSync(paths.environments)) return { configurations: new Map(), writes: new Map() };
  const files = readdirSync(paths.environments, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
  const configurations = new Map();
  const writes = new Map();
  for (const file of files) {
    const name = file.slice(0, -'.json'.length);
    const path = environmentPath(paths, name);
    assertSafeEnvironmentPaths({ ...paths, defaultEnvironment: path });
    const configuration = readJson(path);
    if (!isPlainObject(configuration?.roles)) continue;
    let roles = configuration.roles;
    let changed = false;
    for (const [legacyRoleId, currentRoleId] of LEGACY_ROLE_RENAMES) {
      if (!Object.hasOwn(roles, legacyRoleId)) continue;
      if (Object.hasOwn(roles, currentRoleId)) {
        fail(`Configuration contains both roles.${legacyRoleId} and roles.${currentRoleId}: ${path}`);
      }
      roles = Object.fromEntries(Object.entries(roles).map(([roleId, value]) => [
        roleId === legacyRoleId ? currentRoleId : roleId,
        value
      ]));
      changed = true;
    }
    if (!changed) continue;
    const migrated = { ...configuration, roles };
    configurations.set(path, migrated);
    writes.set(path, `${JSON.stringify(migrated, null, 2)}\n`);
  }
  return { configurations, writes };
}

function loadInstallConfig(assets, platforms) {
  const paths = globalPaths();
  assertSafeEnvironmentPaths(paths);
  const exists = existsSync(paths.defaultEnvironment);
  const migration = planLegacyRoleMigrations(paths);
  let base = exists
    ? migration.configurations.get(paths.defaultEnvironment) ?? readJson(paths.defaultEnvironment)
    : structuredClone(assets.defaults);
  for (const roleId of INSTALL_MISSING_ROLE_DEFAULTS) {
    if (exists && isPlainObject(base?.roles) && !Object.hasOwn(base.roles, roleId)) {
      base = structuredClone(base);
      base.roles[roleId] = structuredClone(assets.defaults.roles[roleId]);
    }
  }
  const resolved = loadResolvedConfiguration({
    paths,
    roles: assets.roles,
    platforms,
    defaultConfiguration: base,
    environmentConfigurations: migration.configurations
  });
  const environmentContents = new Map(migration.writes);
  environmentContents.set(paths.defaultEnvironment, `${JSON.stringify(base, null, 2)}\n`);
  return {
    ...resolved,
    paths,
    environmentContents
  };
}

function listEnvironments() {
  const paths = globalPaths();
  assertSafeEnvironmentPaths(paths);
  const currentEnv = existsSync(paths.environmentMarker)
    ? readFileSync(paths.environmentMarker, 'utf8').trim() 
    : null;
  if (currentEnv !== null) assertEnvironmentName(currentEnv);
  
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

function transactionOptions(paths) {
  return {
    transactionPath: paths.generationTransaction,
    roots: [paths.configHome, paths.codexDir, paths.claudeDir]
  };
}

function managedPlatforms(paths) {
  if (!existsSync(paths.managedPlatforms)) return [...PLATFORMS];
  const entry = lstatSync(paths.managedPlatforms);
  if (entry.isSymbolicLink() || !entry.isFile()) fail(`Managed platforms manifest must be a regular file: ${paths.managedPlatforms}`);
  const manifest = readJson(paths.managedPlatforms);
  if (manifest?.version !== 1 || !Array.isArray(manifest.platforms) || !manifest.platforms.every((platform) => PLATFORMS.has(platform))) {
    fail(`Managed platforms manifest is invalid: ${paths.managedPlatforms}`);
  }
  return [...new Set(manifest.platforms)].sort();
}

function managedPlatformsStep(paths, platforms) {
  const contents = `${JSON.stringify({ version: 1, platforms: [...new Set(platforms)].sort() }, null, 2)}\n`;
  if (existsSync(paths.managedPlatforms)) {
    const entry = lstatSync(paths.managedPlatforms);
    if (entry.isSymbolicLink() || !entry.isFile()) fail(`Managed platforms manifest must be a regular file: ${paths.managedPlatforms}`);
    if (readFileSync(paths.managedPlatforms, 'utf8') === contents) return null;
  }
  return {
    type: 'write',
    path: paths.managedPlatforms,
    contents
  };
}

function applyGenerationTransaction(plan, paths, dryRun) {
  if (!plan.length) {
    if (!dryRun) recoverTransaction(paths.generationTransaction, transactionOptions(paths));
    return [];
  }
  return applyGenerationPlan(plan, dryRun, transactionOptions(paths));
}

function useEnvironment(name, dryRun) {
  const paths = globalPaths();
  assertEnvironmentName(name);
  assertSafeEnvironmentPaths(paths);
  if (!existsSync(paths.defaultEnvironment)) fail(`Missing ${paths.defaultEnvironment}. Run init first.`);
  const assets = loadAgentAssets();
  const resolved = loadResolvedConfiguration({
    paths,
    roles: assets.roles,
    platforms: [...PLATFORMS],
    environmentName: name,
    missingRoleDefaults: compatibilityRoleDefaults(assets)
  });
  const platforms = managedPlatforms(paths);
  const generation = planGenerationFor(platforms, assets, resolved.config);
  const marker = name === 'default'
    ? { type: 'delete', path: paths.environmentMarker }
    : { type: 'write', path: paths.environmentMarker, contents: name };
  const plan = [...generation.plan, marker, managedPlatformsStep(paths, platforms)].filter(Boolean);
  applyGenerationTransaction(plan, paths, dryRun);
  for (const message of generation.warnings) console.warn(`WARNING ${message}`);
  console.log(`${dryRun ? 'Would activate' : 'Activated'} environment: ${name}`);
}

function createEnvironment(name) {
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
  const resolvedConfig = loadResolvedConfiguration({
    paths,
    roles: assets.roles,
    platforms: [...PLATFORMS],
    missingRoleDefaults: compatibilityRoleDefaults(assets)
  }).config;
  mkdirSync(paths.environments, { recursive: true });
  assertSafeEnvironmentPaths(paths);
  try {
    writeFileSync(envPath, `${JSON.stringify(resolvedConfig, null, 2)}\n`, { flag: 'wx' });
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
  if (currentEnv !== null) assertEnvironmentName(currentEnv);
  
  if (name === currentEnv) {
    applyTransaction([
      { type: 'delete', path: paths.environmentMarker },
      { type: 'delete', path: envPath }
    ], transactionOptions(paths));
    console.log(`Deleted environment: ${name} (was active, switched to default)`);
  } else {
    applyTransaction([{ type: 'delete', path: envPath }], transactionOptions(paths));
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

function generate(platforms, dryRun, assets, config = loadConfig(assets, dryRun, platforms).config, previousPlatforms = managedPlatforms(globalPaths())) {
  const result = planGenerationFor(platforms, assets, config);
  const lifecycle = planInstallLifecycle();
  const managed = [...new Set([...previousPlatforms, ...platforms])];
  const plan = [...planManagedSkills(lifecycle, result.paths, platforms), ...planExecutionRuntime(result.paths), ...planObsoleteManagedContent(result.paths), ...result.plan, managedPlatformsStep(result.paths, managed)].filter(Boolean);
  return { ...result, changed: applyGenerationTransaction(plan, result.paths, dryRun) };
}

function planGenerationFor(platforms, assets, config) {
  const paths = globalPaths();
  const validation = validateConfiguration({ base: config, roles: assets.roles, platforms });
  if (validation.errors.length) fail(validation.errors.join('\n'));
  const plan = platforms.flatMap((platform) => planGeneration({ platform, paths, roles: assets.roles, policies: assets.policies, config, bodies: assets.compiledBodies }));
  return { plan, warnings: validation.warnings, paths };
}

function reportCapabilities(platforms, assets, config) {
  for (const platform of platforms) {
    const digest = createHash('sha256').update(JSON.stringify(assets.roles.map((role) => ({
      role,
      policy: assets.policies[role.policy],
      settings: config.roles[role.id][platform],
      body: assets.compiledBodies.get(role.id)
    })))).digest('hex');
    console.log(`Generation digest ${platform}: ${digest}`);
    for (const role of assets.roles) {
      const matrix = capabilityMatrix(platform, role, assets.policies[role.policy]);
      const report = Object.entries(matrix).map(([capability, level]) => `${capability}=${level}`).join(', ');
      console.log(`CAPABILITY ${platform}/${role.id}: ${report}`);
      const warnings = Object.entries(matrix).filter(([, level]) => level !== 'enforced').map(([capability, level]) => `${capability}=${level}`);
      if (warnings.length) console.warn(`WARNING ${platform}/${role.id}: ${warnings.join(', ')}`);
      const controlLevels = controlMatrix(platform, role, assets.policies[role.policy], assets.controls);
      const controlReport = Object.entries(controlLevels).map(([controlId, level]) => `${controlId}=${level}`).join(', ');
      console.log(`CONTROL ${platform}/${role.id}: ${controlReport}`);
      const controlWarnings = Object.entries(controlLevels).filter(([, level]) => level !== 'enforced').map(([controlId, level]) => `${controlId}=${level}`);
      if (controlWarnings.length) console.warn(`WARNING CONTROL ${platform}/${role.id}: ${controlWarnings.join(', ')}`);
    }
  }
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
      useEnvironment(options.envName, options.dryRun);
      return;
    }
    if (options.envAction === 'status') {
      const paths = globalPaths();
      const assets = loadAgentAssets();
      const resolved = loadResolvedConfiguration({
        paths,
        roles: assets.roles,
        platforms: [...PLATFORMS],
        missingRoleDefaults: compatibilityRoleDefaults(assets)
      });
      console.log(`Environment: ${resolved.name}`);
      console.log(`Managed platforms: ${managedPlatforms(paths).join(', ')}`);
      const managed = managedPlatforms(paths);
      reportCapabilities(managed, assets, resolved.config);
      for (const status of generationStatus({
        platforms: [...PLATFORMS].sort(),
        paths,
        roles: assets.roles,
        policies: assets.policies,
        config: resolved.config,
        bodies: assets.compiledBodies,
        managedPlatforms: managed,
        managedManifestPresent: existsSync(paths.managedPlatforms)
      })) {
        console.log(`STATUS ${status.platform}/${status.role_id}: ${status.state} reasons=${status.reasons.join(',') || 'none'} planned_digest=${status.planned_digest}${status.installed_digest ? ` installed_digest=${status.installed_digest}` : ''}`);
      }
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
    const installation = loadInstallConfig(assets, options.platforms);
    const { config } = installation;
    const generation = planGenerationFor(options.platforms, assets, config);
    const paths = installation.paths;
    const plan = [
      ...planManagedSkills(lifecycle, paths),
      ...planExecutionRuntime(paths),
      ...planObsoleteManagedContent(paths),
      ...planCoreRuntime(assets, lifecycle, paths)
    ];
    for (const [path, contents] of installation.environmentContents) addWriteStep(plan, path, contents);
    addWriteStep(plan, paths.routing, assets.routing);
    plan.push(...generation.plan);
    const manifest = managedPlatformsStep(paths, options.platforms);
    if (manifest) plan.push(manifest);
    const changed = applyGenerationTransaction(plan, paths, options.dryRun);
    console.log(`Initialized ${paths.dir}`);
    for (const message of generation.warnings) console.warn(`WARNING ${message}`);
    reportCapabilities(options.platforms, assets, config);
    console.log(`${options.dryRun ? 'Would write' : 'Generated'} ${changed.length} file(s).`);
    for (const path of changed) console.log(`${options.dryRun ? 'WRITE' : 'WROTE'} ${path}`);
    return;
  }
  if (options.command === 'init') {
    const changed = init(assets, options.dryRun);
    console.log(`Initialized ${globalPaths().dir}`);
    for (const path of changed) console.log(`WRITE ${path}`);
    return;
  }
  const platforms = options.command === 'generate' ? options.platforms : [...PLATFORMS];
  const { config, warnings } = loadConfig(assets, options.command === 'install' && options.dryRun, platforms);
  const validation = validateConfiguration({ base: config, roles: assets.roles, platforms });
  if (options.command === 'validate') {
    for (const message of validation.errors) console.error(`ERROR ${message}`);
    for (const message of warnings ?? validation.warnings) console.warn(`WARNING ${message}`);
    if (validation.errors.length) process.exitCode = 1;
    else console.log('Configuration is valid.');
    return;
  }
  if (validation.errors.length) fail(validation.errors.join('\n'));
  const result = generate(options.platforms, options.dryRun, assets, config);
  for (const message of result.warnings) console.warn(`WARNING ${message}`);
  reportCapabilities(options.platforms, assets, config);
  console.log(`${options.dryRun ? 'Would write' : 'Generated'} ${result.changed.length} file(s).`);
  for (const path of result.changed) console.log(`${options.dryRun ? 'WRITE' : 'WROTE'} ${path}`);
}
