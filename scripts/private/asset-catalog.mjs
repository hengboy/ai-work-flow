import { createHash } from 'node:crypto';
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
  write_scope: new Set(['none', 'docs', 'plans', 'tasks', 'research', 'code', 'git']),
  delegation: new Set(['none', 'allowed', 'review-only'])
};
const ROLE_KINDS = new Set(['primary', 'subagent', 'reviewer']);
export const MAX_AGENT_DEPTH = 2;
const TOOL_REQUIREMENTS = {
  Read: ['filesystem', new Set(['read', 'write'])],
  Glob: ['filesystem', new Set(['read', 'write'])],
  Grep: ['filesystem', new Set(['read', 'write'])],
  Edit: ['filesystem', new Set(['write'])],
  Write: ['filesystem', new Set(['write'])],
  Bash: ['shell', new Set(['read', 'write', 'git'])],
  WebSearch: ['network', new Set(['official'])],
  WebFetch: ['network', new Set(['official'])],
  Task: ['delegation', new Set(['allowed', 'review-only'])]
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
  for (const property of Object.keys(role)) {
    if (!['id', 'name', 'description', 'kind', 'default_primary', 'policy', 'delegates', 'tools', 'routing_sections'].includes(property)) errors.push(`Role ${role.id} has unknown field: ${property}.`);
  }
  if (role.default_primary !== undefined && typeof role.default_primary !== 'boolean') errors.push(`Role ${role.id}.default_primary must be a boolean.`);
  if (!Array.isArray(role.delegates)) errors.push(`Role ${role.id}.delegates must be an array.`);
  if (!Array.isArray(role.tools)) errors.push(`Role ${role.id}.tools must be an array.`);
  if (!Array.isArray(role.routing_sections) || role.routing_sections.length === 0) errors.push(`Role ${role.id}.routing_sections must be a non-empty array.`);
}

function parseRoutingSections(source, errors) {
  const sections = new Map();
  const start = /^<!-- ai-work-flow:section id="([a-z0-9][a-z0-9-]*)" -->$/gm;
  let match;
  while ((match = start.exec(source))) {
    const end = source.indexOf('<!-- ai-work-flow:section-end -->', start.lastIndex);
    const nested = source.indexOf('<!-- ai-work-flow:section id="', start.lastIndex);
    if (end === -1 || (nested !== -1 && nested < end)) {
      errors.push(`Routing section ${match[1]} is missing a non-nested end marker.`);
      continue;
    }
    if (sections.has(match[1])) errors.push(`Routing section id is duplicated: ${match[1]}.`);
    else sections.set(match[1], source.slice(start.lastIndex, end).trim());
    start.lastIndex = end + '<!-- ai-work-flow:section-end -->'.length;
  }
  if (!sections.size) errors.push('routing.md must contain at least one managed section.');
  return sections;
}

function validateDelegateGraph(roles, errors) {
  const byId = new Map(roles.map((role) => [role.id, role]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) {
      errors.push(`Role delegation contains a cycle at: ${id}.`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const delegate of byId.get(id)?.delegates ?? []) visit(delegate);
    visiting.delete(id);
    visited.add(id);
  };
  for (const role of roles) visit(role.id);
}

function validateDelegateDepth(roles, errors) {
  const byId = new Map(roles.map((role) => [role.id, role]));
  const visit = (id, path) => {
    if (path.length - 1 > MAX_AGENT_DEPTH) {
      errors.push(`Role delegation exceeds max depth ${MAX_AGENT_DEPTH}: ${path.join(' -> ')}.`);
      return;
    }
    for (const delegate of byId.get(id)?.delegates ?? []) {
      if (!path.includes(delegate)) visit(delegate, [...path, delegate]);
    }
  };
  for (const primary of roles.filter((role) => role.kind === 'primary')) visit(primary.id, [primary.id]);
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
  const primaryRoles = roles.filter((role) => role.kind === 'primary');
  const defaultPrimaryRoles = roles.filter((role) => role.default_primary === true);
  if (primaryRoles.length === 0) errors.push('roles.json must contain at least one primary role.');
  if (defaultPrimaryRoles.length !== 1) errors.push('roles.json must contain exactly one role with default_primary: true.');
  if (defaultPrimaryRoles.length === 1 && defaultPrimaryRoles[0].kind !== 'primary') errors.push(`Role ${defaultPrimaryRoles[0].id} sets default_primary: true but is not a primary role.`);
  for (const role of roles) {
    if (!ROLE_KINDS.has(role.kind)) errors.push(`Role ${role.id} has invalid kind: ${role.kind}.`);
    if (!unique(role.delegates ?? [])) errors.push(`Role ${role.id} has duplicate delegates.`);
    if (!unique(role.tools ?? [])) errors.push(`Role ${role.id} has duplicate tools.`);
    for (const delegate of role.delegates ?? []) {
      if (typeof delegate !== 'string' || !ids.includes(delegate)) errors.push(`Role ${role.id} delegates to an unknown role: ${delegate}.`);
    }
    const policy = policyDocument?.policies?.[role.policy];
    if (policy) {
      if (policy.delegation === 'none' && ((role.delegates?.length ?? 0) > 0 || role.tools?.includes('Task'))) errors.push(`Role ${role.id} conflicts with delegation=none.`);
      if (policy.delegation === 'review-only' && (role.delegates ?? []).some((id) => roles.find((candidate) => candidate.id === id)?.kind !== 'reviewer')) errors.push(`Role ${role.id} review-only delegation must target reviewers.`);
      for (const tool of role.tools ?? []) {
        const requirement = TOOL_REQUIREMENTS[tool];
        if (!requirement) errors.push(`Role ${role.id} declares unknown tool: ${tool}.`);
        else if (!requirement[1].has(policy[requirement[0]])) errors.push(`Role ${role.id} tool ${tool} conflicts with policy ${requirement[0]}=${policy[requirement[0]]}.`);
      }
    }
  }
  validateDelegateGraph(roles, errors);
  validateDelegateDepth(roles, errors);

  const routing = readFileSync(resolve(assetRoot, 'routing.md'), 'utf8');
  const sections = parseRoutingSections(routing, errors);
  const referenced = new Set();
  for (const role of roles) for (const section of role.routing_sections ?? []) {
    if (typeof section !== 'string' || !sections.has(section)) errors.push(`Role ${role.id} references an unknown routing section: ${section}.`);
    else referenced.add(section);
  }
  for (const section of sections.keys()) if (!referenced.has(section)) errors.push(`Routing section is not referenced: ${section}.`);

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
  return { routing, sections };
}

function delegationContract(role) {
  const delegates = role.delegates ?? [];
  const boundary = delegates.length
    ? `只允许委派以下角色 ID：${delegates.map((id) => `\`${id}\``).join('、')}。调用委派工具时必须显式选择其中一个精确 ID；禁止委派当前角色 \`${role.id}\`，也禁止委派任何未列出的角色。`
    : `此角色不得委派任何子代理。禁止委派当前角色 \`${role.id}\` 或任何其他角色。`;
  return `## 运行时委派约束\n\n当前角色 ID 是 \`${role.id}\`。${boundary}`;
}

export function loadAgentAssets(assetRoot = resolve(import.meta.dirname, '..', 'agent-assets')) {
  const root = resolve(assetRoot);
  const catalog = readJson(resolve(root, 'roles.json'));
  const policyDocument = readJson(resolve(root, 'policies.json'));
  const defaults = readJson(resolve(root, 'default-config.json'));
  const bodyNames = readdirSync(resolve(root, 'bodies'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name);
  const { routing, sections } = validateAssetRelationships(catalog, policyDocument, defaults, bodyNames, root);
  const bodies = new Map(catalog.roles.map((role) => [
    role.id,
    readFileSync(resolve(root, 'bodies', `${role.id}.md`), 'utf8').trimEnd()
  ]));
  const routingDigest = createHash('sha256').update(routing).digest('hex');
  const compiledBodies = new Map(catalog.roles.map((role) => [
    role.id,
    `<!-- ai-work-flow:routing-digest=${routingDigest} sections=${role.routing_sections.join(',')} -->\n\n${delegationContract(role)}\n\n${role.routing_sections.map((id) => sections.get(id)).join('\n\n')}\n\n${bodies.get(role.id)}`
  ]));
  return {
    root,
    roles: catalog.roles,
    policies: policyDocument.policies,
    defaults,
    bodies,
    compiledBodies,
    routing
  };
}
