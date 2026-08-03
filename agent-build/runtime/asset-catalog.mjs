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
  write_scope: new Set(['none', 'docs', 'planning-artifacts', 'tasks', 'research', 'code', 'git']),
  delegation: new Set(['none', 'allowed', 'review-only'])
};
const ROLE_KINDS = new Set(['primary', 'subagent', 'reviewer']);
export const MAX_AGENT_DEPTH = 2;
const MAX_COMPILED_PROMPT_LENGTH = 53_000;
const ROLE_TEMPLATE_HEADINGS = ['职责结果', '不可违反约束', '输入前置条件', '确定性工作流', '暂停条件', '交接格式'];
const CONTROL_MARKER = '<!-- ai-work-flow:controls -->';
const ROUTING_SECTION_ASSIGNMENTS = {
  coding: ['browser-governance', 'retry-governance', 'planning-governance', 'orchestration-governance', 'change-handoff-governance', 'git-lifecycle-governance', 'review-orchestration-governance'],
  planning: ['browser-governance', 'retry-governance', 'planning-governance'],
  'file-explorer': ['browser-governance', 'handoff-governance'],
  researcher: ['browser-governance', 'handoff-governance'],
  'document-maintainer': ['browser-governance', 'handoff-governance'],
  'planning-writer': ['browser-governance', 'handoff-governance', 'planning-governance'],
  'task-planner': ['browser-governance', 'handoff-governance', 'planning-governance'],
  'full-stack-coder': ['browser-governance', 'retry-governance', 'handoff-governance', 'change-handoff-governance'],
  'bug-fixer': ['browser-governance', 'retry-governance', 'handoff-governance', 'change-handoff-governance'],
  'git-operator': ['browser-governance', 'planning-governance', 'handoff-governance', 'change-handoff-governance', 'git-lifecycle-governance'],
  'code-reviewer': ['browser-governance', 'retry-governance', 'handoff-governance', 'review-evidence-governance', 'review-orchestration-governance'],
  'review-standards': ['browser-governance', 'handoff-governance', 'review-evidence-governance'],
  'review-spec': ['browser-governance', 'handoff-governance', 'review-evidence-governance']
};
const TOOL_REQUIREMENTS = {
  Read: ['filesystem', new Set(['read', 'write'])],
  Glob: ['filesystem', new Set(['read', 'write'])],
  Grep: ['filesystem', new Set(['read', 'write'])],
  Edit: ['filesystem', new Set(['write'])],
  Write: ['filesystem', new Set(['write'])],
  Bash: ['shell', new Set(['read', 'write', 'git'])],
  WebSearch: ['network', new Set(['official'])],
  WebFetch: ['network', new Set(['official'])],
  Task: ['delegation', new Set(['allowed', 'review-only'])],
  Skill: null
};
const SPEC_FIRST_TEMPLATE_CONTRACTS = {
  planning: [
    'spec.md',
    'source_spec_digest',
    'SHA-256',
    '拆分',
    '不拆分'
  ],
  'planning-writer': [
    'Spec Metadata',
    'status: `approved`',
    'Open Questions',
    'source_spec_digest'
  ],
  'task-planner': ['source_plan_digest', '完整字节', '全量替换'],
  coding: ['spec.md', 'source_spec_digest', '旧平铺计划'],
  'git-operator': ['spec.md', 'source_spec_digest']
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
    if (!['id', 'name', 'description', 'kind', 'default_primary', 'policy', 'controls', 'delegates', 'tools', 'routing_sections'].includes(property)) errors.push(`Role ${role.id} has unknown field: ${property}.`);
  }
  if (role.default_primary !== undefined && typeof role.default_primary !== 'boolean') errors.push(`Role ${role.id}.default_primary must be a boolean.`);
  if (!Array.isArray(role.delegates)) errors.push(`Role ${role.id}.delegates must be an array.`);
  if (!Array.isArray(role.tools)) errors.push(`Role ${role.id}.tools must be an array.`);
  if (!Array.isArray(role.controls) || role.controls.length === 0) errors.push(`Role ${role.id}.controls must be a non-empty array.`);
  if (!Array.isArray(role.routing_sections) || role.routing_sections.length === 0) errors.push(`Role ${role.id}.routing_sections must be a non-empty array.`);
}

function validateControls(controlDocument, roles, policyDocument, errors) {
  if (!isPlainObject(controlDocument) || controlDocument.version !== 1 || !isPlainObject(controlDocument.controls)) {
    errors.push('controls.json must contain version: 1 and a controls object.');
    return {};
  }
  for (const property of Object.keys(controlDocument)) {
    if (!['version', 'controls'].includes(property)) errors.push(`controls.json has unknown field: ${property}.`);
  }
  const controls = controlDocument.controls;
  for (const [id, control] of Object.entries(controls)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) errors.push(`Control id is invalid: ${id}.`);
    if (!isPlainObject(control)) {
      errors.push(`Control ${id} must be an object.`);
      continue;
    }
    for (const property of Object.keys(control)) {
      if (!['instruction', 'policy_requirements'].includes(property)) errors.push(`Control ${id} has unknown field: ${property}.`);
    }
    if (typeof control.instruction !== 'string' || !control.instruction.trim()) errors.push(`Control ${id} must have a non-empty instruction.`);
    if (!isPlainObject(control.policy_requirements)) {
      errors.push(`Control ${id}.policy_requirements must be an object.`);
      continue;
    }
    for (const [capability, allowed] of Object.entries(control.policy_requirements)) {
      const validValues = POLICY_CAPABILITIES[capability];
      if (!validValues) {
        errors.push(`Control ${id} has unknown capability: ${capability}.`);
        continue;
      }
      if (!Array.isArray(allowed) || allowed.length === 0 || !unique(allowed)) {
        errors.push(`Control ${id}.${capability} must be a non-empty array without duplicates.`);
        continue;
      }
      for (const value of allowed) if (!validValues.has(value)) errors.push(`Control ${id}.${capability} has invalid policy value: ${value}.`);
    }
  }
  const referenced = new Set();
  for (const role of roles) {
    if (!unique(role.controls ?? [])) errors.push(`Role ${role.id} has duplicate controls.`);
    for (const id of role.controls ?? []) {
      if (typeof id !== 'string' || !Object.hasOwn(controls, id)) errors.push(`Role ${role.id} references an unknown control: ${id}.`);
      else referenced.add(id);
    }
    const policy = policyDocument?.policies?.[role.policy];
    if (!policy) continue;
    for (const id of role.controls ?? []) {
      const requirements = controls[id]?.policy_requirements;
      if (!isPlainObject(requirements)) continue;
      for (const [capability, allowed] of Object.entries(requirements)) {
        if (Array.isArray(allowed) && !allowed.includes(policy[capability])) {
          errors.push(`Role ${role.id} policy does not satisfy control ${id}: ${capability}=${policy[capability]}.`);
        }
      }
    }
  }
  for (const id of Object.keys(controls)) if (!referenced.has(id)) errors.push(`Control is not referenced: ${id}.`);
  return controls;
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

function validateAssetRelationships(catalog, controlDocument, policyDocument, defaults, bodyNames, configRoot, templatesRoot) {
  const errors = [];
  if (!isPlainObject(catalog) || catalog.version !== 2 || !Array.isArray(catalog.roles)) {
    errors.push('roles.json must contain version: 2 and a roles array.');
  }
  const roles = Array.isArray(catalog?.roles) ? catalog.roles : [];
  if (isPlainObject(catalog)) for (const property of Object.keys(catalog)) {
    if (!['version', 'roles'].includes(property)) errors.push(`roles.json has unknown field: ${property}.`);
  }
  for (const role of roles) validateRole(role, errors);
  if (!isPlainObject(policyDocument) || policyDocument.version !== 1 || !isPlainObject(policyDocument.policies)) {
    errors.push('policies.json must contain version: 1 and a policies object.');
  } else {
    for (const property of Object.keys(policyDocument)) {
      if (!['version', 'policies'].includes(property)) errors.push(`policies.json has unknown field: ${property}.`);
    }
    for (const [name, policy] of Object.entries(policyDocument.policies)) validatePolicy(name, policy, errors);
    for (const role of roles) if (!isPlainObject(policyDocument.policies[role.policy])) errors.push(`Role ${role.id} references an unknown policy: ${role.policy}.`);
  }
  const controls = validateControls(controlDocument, roles, policyDocument, errors);
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
    if (ROUTING_SECTION_ASSIGNMENTS[role.id] && JSON.stringify(role.routing_sections) !== JSON.stringify(ROUTING_SECTION_ASSIGNMENTS[role.id])) {
      errors.push(`Role ${role.id} has an invalid routing section assignment.`);
    }
    for (const delegate of role.delegates ?? []) {
      if (typeof delegate !== 'string' || !ids.includes(delegate)) errors.push(`Role ${role.id} delegates to an unknown role: ${delegate}.`);
    }
    const policy = policyDocument?.policies?.[role.policy];
    if (policy) {
      if (policy.delegation === 'none' && ((role.delegates?.length ?? 0) > 0 || role.tools?.includes('Task'))) errors.push(`Role ${role.id} conflicts with delegation=none.`);
      if (policy.delegation === 'review-only' && (role.delegates ?? []).some((id) => roles.find((candidate) => candidate.id === id)?.kind !== 'reviewer')) errors.push(`Role ${role.id} review-only delegation must target reviewers.`);
      for (const tool of role.tools ?? []) {
        const requirement = TOOL_REQUIREMENTS[tool];
        if (requirement === undefined) errors.push(`Role ${role.id} declares unknown tool: ${tool}.`);
        else if (requirement && !requirement[1].has(policy[requirement[0]])) errors.push(`Role ${role.id} tool ${tool} conflicts with policy ${requirement[0]}=${policy[requirement[0]]}.`);
      }
    }
  }
  validateDelegateGraph(roles, errors);
  validateDelegateDepth(roles, errors);

  const routing = readFileSync(resolve(configRoot, 'routing.md'), 'utf8');
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
    for (const property of Object.keys(defaults)) {
      if (!['version', 'roles'].includes(property)) errors.push(`default-config.json has unknown field: ${property}.`);
    }
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
    if (!bodyNames.includes(name)) errors.push(`Missing template: ${name}.`);
  }
  for (const name of bodyNames) {
    if (!expectedBodies.includes(name)) errors.push(`Template has no catalog role: ${name}.`);
  }
  for (const name of expectedBodies.filter((body) => bodyNames.includes(body))) {
    const body = readFileSync(resolve(templatesRoot, name), 'utf8');
    if (!body.trim()) errors.push(`Template is empty: ${name}.`);
    const roleId = name.slice(0, -3);
    const headingPositions = ROLE_TEMPLATE_HEADINGS.map((heading) => body.indexOf(`## ${heading}`));
    if (headingPositions.some((position) => position < 0) || headingPositions.some((position, index) => index > 0 && position <= headingPositions[index - 1])) {
      errors.push(`Template ${name} must contain the ordered role interface headings: ${ROLE_TEMPLATE_HEADINGS.join(', ')}.`);
    }
    if (body.split(CONTROL_MARKER).length - 1 !== 1) errors.push(`Template ${name} must contain exactly one controls placeholder.`);
    for (const marker of SPEC_FIRST_TEMPLATE_CONTRACTS[roleId] ?? []) {
      if (!body.includes(marker)) errors.push(`Template ${name} is missing spec-first contract marker: ${marker}.`);
    }
  }
  if (errors.length) fail(`Agent asset catalog is invalid:\n${errors.join('\n')}`);
  return { routing, sections, controls };
}

function delegationContract(role) {
  const delegates = role.delegates ?? [];
  const boundary = delegates.length
    ? `只允许委派以下角色 ID：${delegates.map((id) => `\`${id}\``).join('、')}。调用委派工具时必须显式选择其中一个精确 ID；禁止委派当前角色 \`${role.id}\`，也禁止委派任何未列出的角色。`
    : `此角色不得委派任何子代理。禁止委派当前角色 \`${role.id}\` 或任何其他角色。`;
  return `## 运行时委派约束\n\n当前角色 ID 是 \`${role.id}\`。${boundary}`;
}

export function loadAgentAssets(configRoot = resolve(import.meta.dirname, '..', 'config'), templatesRoot = resolve(import.meta.dirname, '..', 'templates')) {
  const config = resolve(configRoot);
  const templates = resolve(templatesRoot);
  const catalog = readJson(resolve(config, 'roles.json'));
  const controlDocument = readJson(resolve(config, 'controls.json'));
  const policyDocument = readJson(resolve(config, 'policies.json'));
  const defaults = readJson(resolve(config, 'default-config.json'));
  const bodyNames = readdirSync(templates, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name);
  const { routing, sections, controls } = validateAssetRelationships(catalog, controlDocument, policyDocument, defaults, bodyNames, config, templates);
  const bodies = new Map(catalog.roles.map((role) => [
    role.id,
    readFileSync(resolve(templates, `${role.id}.md`), 'utf8').trimEnd()
  ]));
  const routingDigest = createHash('sha256').update(routing).digest('hex');
  const compiledBodies = new Map(catalog.roles.map((role) => [
    role.id,
    `<!-- ai-work-flow:routing-digest=${routingDigest} sections=${role.routing_sections.join(',')} -->\n\n${delegationContract(role)}\n\n${role.routing_sections.map((id) => sections.get(id)).join('\n\n')}\n\n${bodies.get(role.id).replace(CONTROL_MARKER, `<!-- ai-work-flow:control-ids=${role.controls.join(',')} -->\n\n${role.controls.map((id) => `- ${controls[id].instruction}`).join('\n')}`)}`
  ]));
  const totalCompiledLength = [...compiledBodies.values()].reduce((total, body) => total + body.length, 0);
  if (totalCompiledLength > MAX_COMPILED_PROMPT_LENGTH) fail(`Compiled agent prompts exceed ${MAX_COMPILED_PROMPT_LENGTH} characters: ${totalCompiledLength}.`);
  for (const role of catalog.roles.filter((candidate) => candidate.kind !== 'primary')) {
    const prompt = compiledBodies.get(role.id);
    for (const field of ['status', 'summary', 'artifacts', 'checks', 'details', 'blocking_reason']) {
      if (!prompt.includes(`"${field}"`)) fail(`Compiled prompt ${role.id} is missing JSON handoff field: ${field}.`);
    }
  }
  const coding = compiledBodies.get('coding');
  const codingStates = [...coding.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]);
  const expectedCodingStates = ['discovery', 'ready_to_implement', 'implementing', 'ready_to_commit', 'ready_to_review', 'review_passed', 'awaiting_finding_ids', 'fixing_findings', 'resync_required', 'complete'];
  if (JSON.stringify(codingStates) !== JSON.stringify(expectedCodingStates)) fail('Compiled Coding prompt has an invalid deterministic state table.');
  for (const marker of ['产品决策', '共享理解批准', 'plan-id 同名冲突', '拆分模式', '删除旧 tasks', 'planning commit', '实施授权', 'blocking finding IDs', 'stash 授权', '冲突语义', '不可恢复故障']) {
    if (!coding.includes(marker)) fail(`Compiled Coding prompt is missing manual gate: ${marker}.`);
  }
  if (!coding.includes('普通目录式流程') || !coding.includes('不执行第二次评审') || !coding.includes('complete-review-fix') || !coding.includes('最终评审')) {
    fail('Compiled Coding prompt does not distinguish ordinary and canonical review-fix successors.');
  }
  return {
    configRoot: config,
    templatesRoot: templates,
    roles: catalog.roles,
    controls,
    policies: policyDocument.policies,
    defaults,
    bodies,
    compiledBodies,
    routing
  };
}
