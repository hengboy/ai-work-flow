import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import { fail, isPlainObject, readJson } from './shared.mjs';

const ENVIRONMENT_NAME = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PLATFORM_FIELDS = {
  codex: new Set(['model', 'reasoning']),
  claude: new Set(['model', 'effort']),
  opencode: new Set(['model', 'variant', 'options'])
};

export function assertEnvironmentName(name) {
  if (typeof name !== 'string' || !ENVIRONMENT_NAME.test(name) || name.includes('/') || name.includes('\\') || /[\u0000-\u001f\u007f]/.test(name)) {
    fail('Environment name must be 1-64 letters, numbers, dots, underscores, or hyphens and cannot be a path.');
  }
  return name;
}

export function environmentPath(paths, name) {
  assertEnvironmentName(name);
  const path = resolve(paths.environments, `${name}.json`);
  const relativePath = relative(paths.environments, path);
  if (relativePath.startsWith('..') || relativePath.includes(`..${sep}`)) fail('Environment path escapes the environments directory.');
  return path;
}

function assertNoSymbolicLinks(root, path) {
  const relativePath = relative(root, path);
  if (relativePath.startsWith('..') || relativePath.includes(`..${sep}`)) fail(`Environment path escapes its trusted root: ${path}`);
  let current = root;
  for (const segment of ['.', ...relativePath.split(sep).filter(Boolean)]) {
    if (segment !== '.') current = resolve(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) fail(`Environment path must not contain a symbolic link: ${current}`);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
  }
}

export function assertSafeEnvironmentPaths(paths) {
  const trustedRoot = paths.configHome ?? resolve(paths.dir, '..');
  assertNoSymbolicLinks(trustedRoot, paths.dir);
  assertNoSymbolicLinks(trustedRoot, paths.environments);
  assertNoSymbolicLinks(trustedRoot, paths.defaultEnvironment);
  assertNoSymbolicLinks(trustedRoot, paths.environmentMarker);
}

function assertFiniteJson(value, path = 'configuration') {
  if (typeof value === 'number' && !Number.isFinite(value)) fail(`${path} contains a non-finite number.`);
  if (typeof value === 'string' && /[\u0000-\u001f\u007f]/.test(value)) fail(`${path} contains a control character.`);
  if (Array.isArray(value)) value.forEach((item, index) => assertFiniteJson(item, `${path}[${index}]`));
  if (isPlainObject(value)) Object.entries(value).forEach(([key, item]) => assertFiniteJson(item, `${path}.${key}`));
}

function validateKnownShape(config, roles, { overlay }) {
  const errors = [];
  if (!isPlainObject(config) || config.version !== 1 || !isPlainObject(config.roles)) {
    return ['Configuration must contain version: 1 and a roles object.'];
  }
  for (const key of Object.keys(config)) if (!['version', 'roles'].includes(key)) errors.push(`Unknown configuration field: ${key}.`);
  const knownRoles = new Set(roles.map((role) => role.id));
  for (const [roleId, roleConfig] of Object.entries(config.roles)) {
    if (!knownRoles.has(roleId)) {
      errors.push(`Unknown role: ${roleId}.`);
      continue;
    }
    if (!isPlainObject(roleConfig)) {
      errors.push(`${roleId} must be an object.`);
      continue;
    }
    for (const platform of Object.keys(roleConfig)) {
      if (!PLATFORM_FIELDS[platform]) {
        errors.push(`Unknown platform: ${roleId}.${platform}.`);
        continue;
      }
      if (!isPlainObject(roleConfig[platform])) {
        errors.push(`${roleId}.${platform} must be an object.`);
        continue;
      }
      for (const field of Object.keys(roleConfig[platform])) {
        if (!PLATFORM_FIELDS[platform].has(field)) errors.push(`Unknown field: ${roleId}.${platform}.${field}.`);
      }
    }
  }
  if (!overlay) {
    for (const role of roles) if (!Object.hasOwn(config.roles, role.id)) errors.push(`Missing configuration for role: ${role.id}.`);
  }
  return errors;
}

function mergePlatform(base, override, platform) {
  if (override === undefined) return structuredClone(base);
  if (platform === 'opencode' && Object.hasOwn(override, 'options')) return { ...base, ...override, options: override.options };
  return { ...base, ...override };
}

export function mergeConfiguration(base, overlay = { roles: {} }) {
  overlay ??= { roles: {} };
  const roles = {};
  for (const [roleId, baseRole] of Object.entries(base.roles)) {
    const overrideRole = overlay.roles?.[roleId] ?? {};
    roles[roleId] = {};
    for (const platform of Object.keys(PLATFORM_FIELDS)) roles[roleId][platform] = mergePlatform(baseRole[platform], overrideRole[platform], platform);
  }
  return { version: 1, roles };
}

function validateFinal(config, roles, platforms = Object.keys(PLATFORM_FIELDS)) {
  const errors = [];
  const warnings = [];
  for (const role of roles) {
    const entry = config.roles[role.id];
    for (const platform of platforms) {
      const settings = entry?.[platform];
      if (!isPlainObject(settings)) {
        errors.push(`${role.id}.${platform} must be an object.`);
        continue;
      }
      if (platform === 'codex') {
        if (typeof settings.model !== 'string' || !settings.model) errors.push(`${role.id}.codex.model must be a non-empty string.`);
        if (typeof settings.reasoning !== 'string' || !settings.reasoning) errors.push(`${role.id}.codex.reasoning must be a non-empty string.`);
      }
      if (platform === 'claude') {
        if (typeof settings.model !== 'string' || !settings.model) errors.push(`${role.id}.claude.model must be a non-empty string.`);
        if (!['low', 'medium', 'high'].includes(settings.effort)) errors.push(`${role.id}.claude.effort must be low, medium, or high.`);
      }
      if (platform === 'opencode') {
        if (settings.model !== null && typeof settings.model !== 'string') errors.push(`${role.id}.opencode.model must be a provider/model string or null.`);
        if (settings.variant !== null && typeof settings.variant !== 'string') errors.push(`${role.id}.opencode.variant must be a string or null.`);
        if (!isPlainObject(settings.options)) errors.push(`${role.id}.opencode.options must be an object.`);
        if (!settings.model) warnings.push(`${role.id}: OpenCode inherits the primary-session model; configure roles.${role.id}.opencode.model locally for an explicit provider/model.`);
      }
    }
  }
  return { errors, warnings };
}

export function validateConfiguration({ base, overlay, roles, platforms }) {
  const errors = [];
  try {
    assertFiniteJson(base, 'default configuration');
    if (overlay) assertFiniteJson(overlay, 'environment configuration');
  } catch (error) {
    errors.push(error.message);
  }
  errors.push(...validateKnownShape(base, roles, { overlay: false }));
  if (overlay) errors.push(...validateKnownShape(overlay, roles, { overlay: true }));
  if (errors.length) return { errors, warnings: [], config: null };
  const config = mergeConfiguration(base, overlay);
  const final = validateFinal(config, roles, platforms);
  return { ...final, config };
}

function readVerifiedEnvironment(path, paths) {
  assertSafeEnvironmentPaths(paths);
  let entry;
  try {
    entry = lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') fail(`Environment file not found: ${path}`);
    throw error;
  }
  if (entry.isSymbolicLink()) fail(`Environment file must not be a symbolic link: ${path}`);
  if (!entry.isFile()) fail(`Environment path must be a regular file: ${path}`);
  return readJson(path);
}

function readEnvironmentMarker(paths) {
  if (!existsSync(paths.environmentMarker)) return 'default';
  const entry = lstatSync(paths.environmentMarker);
  if (entry.isSymbolicLink()) fail(`Environment marker must not be a symbolic link: ${paths.environmentMarker}`);
  if (!entry.isFile()) fail(`Environment marker must be a regular file: ${paths.environmentMarker}`);
  const name = readFileSync(paths.environmentMarker, 'utf8').trim();
  assertEnvironmentName(name);
  return name;
}

export function loadResolvedConfiguration({ paths, roles, platforms, environmentName = null }) {
  assertSafeEnvironmentPaths(paths);
  const base = readVerifiedEnvironment(paths.defaultEnvironment, paths);
  const markerName = readEnvironmentMarker(paths);
  const name = environmentName ?? markerName;
  if (name !== 'default') assertEnvironmentName(name);
  const overlay = name === 'default' ? null : readVerifiedEnvironment(environmentPath(paths, name), paths);
  const validation = validateConfiguration({ base, overlay, roles, platforms });
  if (validation.errors.length) fail(validation.errors.join('\n'));
  return { ...validation, name, base, overlay };
}
