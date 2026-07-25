import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { fail, isPlainObject, readJson } from './shared.mjs';

const PLATFORM_NAMES = ['codex', 'claude', 'opencode'];
const POLICY_CAPABILITIES = {
  filesystem: new Set(['none', 'read', 'write']),
  shell: new Set(['none', 'read', 'write', 'git']),
  network: new Set(['none', 'official']),
  browser: new Set(['none']),
  git: new Set(['none', 'read', 'write']),
  write_scope: new Set(['none', 'docs', 'plans', 'code', 'git']),
  delegation: new Set(['none', 'allowed', 'review-only'])
};

function unique(values) {
  return new Set(values).size === values.length;
}

function validateRole(role, errors) {
  if (!isPlainObject(role) || typeof role.id !== 'string' || !role.id) {
    errors.push('Each catalog role must have a non-empty id.');
    return;
  }
  for (const property of ['name', 'description', 'kind', 'policy']) {
    if (typeof role[property] !== 'string' || !role[property]) errors.push(`Role ${role.id} must have a non-empty ${property}.`);
  }
  if (!Array.isArray(role.delegates)) errors.push(`Role ${role.id}.delegates must be an array.`);
  if (!Array.isArray(role.tools)) errors.push(`Role ${role.id}.tools must be an array.`);
}

function validatePolicy(name, policy, errors) {
  if (!isPlainObject(policy)) {
    errors.push(`Policy ${name} must be an object.`);
    return;
  }
  for (const [capability, value] of Object.entries(policy)) {
    const values = POLICY_CAPABILITIES[capability];
    if (!values) errors.push(`Policy ${name} has unknown capability: ${capability}.`);
    else if (!values.has(value)) errors.push(`Policy ${name}.${capability} must be one of: ${[...values].join(', ')}.`);
  }
  for (const capability of Object.keys(POLICY_CAPABILITIES)) {
    if (!Object.hasOwn(policy, capability)) errors.push(`Policy ${name} is missing capability: ${capability}.`);
  }
}

function validateAssetRelationships(catalog, policyDocument, defaults, bodyNames, assetRoot) {
  const errors = [];
  if (!isPlainObject(catalog) || catalog.version !== 1 || !Array.isArray(catalog.roles)) {
    errors.push('roles.json must contain version: 1 and a roles array.');
  }
  const roles = Array.isArray(catalog?.roles) ? catalog.roles : [];
  for (const role of roles) validateRole(role, errors);
  if (!isPlainObject(policyDocument) || policyDocument.version !== 1 || !isPlainObject(policyDocument.policies)) {
    errors.push('policies.json must contain version: 1 and a policies object.');
  } else {
    for (const [name, policy] of Object.entries(policyDocument.policies)) validatePolicy(name, policy, errors);
    for (const role of roles) if (!isPlainObject(policyDocument.policies[role.policy])) errors.push(`Role ${role.id} references an unknown policy: ${role.policy}.`);
  }
  const ids = roles.map((role) => role?.id).filter(Boolean);
  if (!unique(ids)) errors.push('roles.json contains duplicate role ids.');

  if (!isPlainObject(defaults) || defaults.version !== 1 || !isPlainObject(defaults.roles)) {
    errors.push('default-config.json must contain version: 1 and a roles object.');
  } else {
    const configured = Object.keys(defaults.roles);
    for (const id of ids) {
      if (!Object.hasOwn(defaults.roles, id)) errors.push(`default-config.json is missing role: ${id}.`);
    }
    for (const id of configured) {
      if (!ids.includes(id)) errors.push(`default-config.json contains unknown role: ${id}.`);
    }
    for (const id of ids) {
      const settings = defaults.roles[id];
      for (const platform of PLATFORM_NAMES) {
        if (!isPlainObject(settings?.[platform])) errors.push(`default-config.json role ${id} is missing ${platform} settings.`);
      }
    }
  }

  const expectedBodies = ids.map((id) => `${id}.md`);
  for (const name of expectedBodies) {
    if (!bodyNames.includes(name)) errors.push(`Missing body template: ${name}.`);
  }
  for (const name of bodyNames) {
    if (!expectedBodies.includes(name)) errors.push(`Body template has no catalog role: ${name}.`);
  }
  for (const name of expectedBodies.filter((body) => bodyNames.includes(body))) {
    if (!readFileSync(resolve(assetRoot, 'bodies', name), 'utf8').trim()) errors.push(`Body template is empty: ${name}.`);
  }
  if (errors.length) fail(`Agent asset catalog is invalid:\n${errors.join('\n')}`);
}

export function loadAgentAssets() {
  const root = resolve(import.meta.dirname, '..', 'agent-assets');
  const catalog = readJson(resolve(root, 'roles.json'));
  const policyDocument = readJson(resolve(root, 'policies.json'));
  const defaults = readJson(resolve(root, 'default-config.json'));
  const bodyNames = readdirSync(resolve(root, 'bodies'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name);
  validateAssetRelationships(catalog, policyDocument, defaults, bodyNames, root);
  const bodies = new Map(catalog.roles.map((role) => [
    role.id,
    readFileSync(resolve(root, 'bodies', `${role.id}.md`), 'utf8').trimEnd()
  ]));
  return {
    root,
    roles: catalog.roles,
    policies: policyDocument.policies,
    defaults,
    bodies,
    routing: readFileSync(resolve(root, 'routing.md'), 'utf8')
  };
}
