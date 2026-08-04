import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { relative, resolve, sep } from 'node:path';

import { fail, isPlainObject } from './shared.mjs';
import { MAX_AGENT_DEPTH } from './asset-catalog.mjs';
import { applyTransaction } from './transaction.mjs';
import { updateManagedMarker } from './managed-content.mjs';

const LEGACY_PRIMARY_AGENT_ID = 'orchestrator';
const LEGACY_GIT_OPERATOR_AGENT_ID = 'git-committer';
const LEGACY_CODE_REVIEWER_AGENT = 'AGENT.md';
const WORKFLOW_MCP_ID = 'ai-work-flow';
const WORKFLOW_TOOL = 'workflow_state';
const OPENCODE_WORKFLOW_TOOL = `${WORKFLOW_MCP_ID}_${WORKFLOW_TOOL}`;
const OPENCODE_PERMISSION_KEYS = ['read', 'edit', 'glob', 'grep', 'bash', 'task', 'skill', 'webfetch', 'websearch', 'question', 'external_directory', OPENCODE_WORKFLOW_TOOL];
const OPENCODE_TOOL_KEYS = {
  Read: 'read',
  Edit: 'edit',
  Write: 'edit',
  Glob: 'glob',
  Grep: 'grep',
  Bash: 'bash',
  Task: 'task',
  Skill: 'skill',
  WebFetch: 'webfetch',
  WebSearch: 'websearch',
  Question: 'question',
  ExternalDirectory: 'external_directory'
};

function brokerPath(paths) {
  return resolve(paths.dir, 'execution-runtime', 'workflow-broker.mjs');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  return value;
}

function mergeBrokerEntry(entries, expected, path, label) {
  if (Object.hasOwn(entries, WORKFLOW_MCP_ID) && JSON.stringify(canonicalJson(entries[WORKFLOW_MCP_ID])) !== JSON.stringify(canonicalJson(expected))) {
    fail(`Unmanaged ${label} workflow broker config already exists in ${path}.`);
  }
  return { ...entries, [WORKFLOW_MCP_ID]: expected };
}

// --- Shared functions ---

function agentDescription(role) {
  return `**${role.name}**: ${role.description}`;
}

function assertNoSymbolicLinks(root, target) {
  let current = resolve(root);
  const segments = relative(current, resolve(target)).split(sep).filter(Boolean);
  for (const segment of ['.', ...segments]) {
    if (segment !== '.') current = resolve(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) fail(`Legacy reviewer path must not contain a symbolic link: ${current}`);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
  }
}

// --- Codex strategy ---

function tomlString(value) {
  return JSON.stringify(String(value));
}

function codexSandbox(policy) {
  return policy.filesystem === 'none' || policy.filesystem === 'read' ? 'read-only' : 'workspace-write';
}

function codexRender(role, settings, body, policy, context) {
  const skillConfig = context.roles.flatMap((candidate) => candidate.skills).filter((name, index, names) => names.indexOf(name) === index).sort().flatMap((name) => [
    '',
    '[[skills.config]]',
    `path = ${tomlString(resolve(context.paths.codexDir, 'skills', name, 'SKILL.md'))}`,
    `enabled = ${role.skills.includes(name)}`,
  ]);
  return [
    `name = ${tomlString(role.id)}`,
    `description = ${tomlString(agentDescription(role))}`,
    `model = ${tomlString(settings.model)}`,
    `model_reasoning_effort = ${tomlString(settings.reasoning)}`,
    `sandbox_mode = ${tomlString(codexSandbox(policy))}`,
    `developer_instructions = ${tomlString(body)}`,
    ...skillConfig,
    ''
  ].join('\n');
}

function codexAssertSafeToml(source, path) {
  let quote = false;
  let square = 0;
  let curly = 0;
  for (const rawLine of source.split('\n')) {
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
    }
  }
  if (quote || square !== 0 || curly !== 0) fail(`Cannot safely parse existing TOML at ${path}. Add agents.max_depth = ${MAX_AGENT_DEPTH} manually.`);
  if ((source.match(/^\[agents\]\s*$/gm) || []).length > 1) {
    fail(`Cannot safely update duplicate [agents] tables in ${path}. Add max_depth = ${MAX_AGENT_DEPTH} manually.`);
  }
}

function codexUpdateConfig(source, path) {
  codexAssertSafeToml(source, path);
  const direct = /^(agents\.max_depth\s*=\s*)(\d+)(\s*(?:#.*)?)$/m;
  if (direct.test(source)) return source.replace(direct, (_, prefix, value, suffix) => `${prefix}${Math.max(MAX_AGENT_DEPTH, Number(value))}${suffix}`);
  const table = /^\[agents\]\s*$/m;
  if (!table.test(source)) return `${source.replace(/\s*$/, '')}${source.trim() ? '\n\n' : ''}[agents]\nmax_depth = ${MAX_AGENT_DEPTH}\n`;
  const start = source.search(table);
  const bodyStart = source.indexOf('\n', start) + 1;
  const nextTable = source.slice(bodyStart).search(/^\[/m);
  const end = nextTable === -1 ? source.length : bodyStart + nextTable;
  const body = source.slice(bodyStart, end);
  const existing = /^(max_depth\s*=\s*)(\d+)(\s*(?:#.*)?)$/m;
  if (existing.test(body)) {
    const updated = body.replace(existing, (_, prefix, value, suffix) => `${prefix}${Math.max(MAX_AGENT_DEPTH, Number(value))}${suffix}`);
    return `${source.slice(0, bodyStart)}${updated}${source.slice(end)}`;
  }
  return `${source.slice(0, end)}${body.endsWith('\n') || !body ? '' : '\n'}max_depth = ${MAX_AGENT_DEPTH}\n${source.slice(end)}`;
}

function codexBrokerConfig(source, path, paths) {
  const begin = '# ai-work-flow:workflow-broker:begin';
  const end = '# ai-work-flow:workflow-broker:end';
  const block = `${begin}\n[mcp_servers.${WORKFLOW_MCP_ID}]\ncommand = "node"\nargs = [${tomlString(brokerPath(paths))}]\n${end}`;
  const start = source.indexOf(begin);
  const finish = source.indexOf(end);
  if ((start === -1) !== (finish === -1) || (start !== -1 && start >= finish) || source.indexOf(begin, start + 1) !== -1 || source.indexOf(end, finish + 1) !== -1) {
    fail(`Cannot safely update workflow broker block in ${path}.`);
  }
  if (start !== -1) return `${source.slice(0, start)}${block}${source.slice(finish + end.length)}`;
  if (/^\[mcp_servers\.ai-work-flow\]\s*$/m.test(source)) fail(`Unmanaged workflow broker config already exists in ${path}.`);
  return `${source.replace(/\s*$/, '')}${source.trim() ? '\n\n' : ''}${block}\n`;
}

// --- Claude strategy ---

function claudePermission(policy) {
  return policy.filesystem === 'none' || policy.filesystem === 'read' ? 'plan' : 'acceptEdits';
}

function claudeTools(role) {
  return (role.tools.length ? role.tools : ['Task']).filter((tool) => tool !== 'Skill').map((tool) => tool === 'WorkflowState' ? `mcp__${WORKFLOW_MCP_ID}__${WORKFLOW_TOOL}` : tool);
}

function yamlValue(value) {
  return JSON.stringify(value);
}

function claudeRender(role, settings, body, policy) {
  const frontmatter = [
    '---',
    `name: ${yamlValue(role.id)}`,
    `description: ${yamlValue(agentDescription(role))}`,
    `model: ${yamlValue(settings.model)}`,
    `effort: ${yamlValue(settings.effort)}`,
    `tools: ${yamlValue(claudeTools(role))}`,
    `skills: ${yamlValue(role.skills)}`,
    `permissionMode: ${yamlValue(claudePermission(policy))}`
  ];
  return [
    ...frontmatter,
    '---',
    '',
    body,
    ''
  ].join('\n');
}

function claudeUpdateConfig(source, path, roles, paths) {
  let current;
  try { current = source ? JSON.parse(source) : {}; }
  catch (error) { fail(`Cannot safely parse existing Claude config at ${path}: ${error.message}`); }
  if (!isPlainObject(current) || (current.mcpServers !== undefined && !isPlainObject(current.mcpServers))) fail(`Cannot safely merge Claude MCP config at ${path}.`);
  const expected = { type: 'stdio', command: 'node', args: [brokerPath(paths)] };
  const mcpServers = mergeBrokerEntry(current.mcpServers ?? {}, expected, path, 'Claude');
  return `${JSON.stringify({ ...current, mcpServers }, null, 2)}\n`;
}

// --- OpenCode strategy ---

export function opencodePermission(role, policy) {
  const permission = Object.fromEntries(OPENCODE_PERMISSION_KEYS.map((key) => [key, 'deny']));
  for (const tool of role.tools) {
    const key = OPENCODE_TOOL_KEYS[tool];
    if (key) permission[key] = 'allow';
  }
  if (role.tools.includes('Skill')) permission.skill = { '*': 'deny', ...Object.fromEntries((role.skills ?? []).map((name) => [name, 'allow'])) };
  if (policy.filesystem === 'none') {
    permission.read = 'deny';
    permission.edit = 'deny';
    permission.glob = 'deny';
    permission.grep = 'deny';
    permission.bash = 'deny';
  }
  if (role.tools.includes('WorkflowState')) permission[OPENCODE_WORKFLOW_TOOL] = 'allow';
  if (policy.delegation === 'allowed') permission.task = 'allow';
  if (policy.delegation === 'none') permission.task = 'deny';
  if (role.id === 'task-planner') {
    permission.edit = {
      '*': 'deny',
      '.ai-work-flow/plans/*/tasks/??-*.md': 'allow',
      '.ai-work-flow/plans/*/tasks/*/*': 'deny'
    };
  }
  if (role.id === 'planning-writer') {
    permission.edit = {
      '*': 'deny',
      '.ai-work-flow/plans/*/spec.md': 'allow',
      '.ai-work-flow/plans/*/plan.md': 'allow',
      '.ai-work-flow/plans/*/*/*': 'deny'
    };
  }
  if (policy.write_scope === 'research') {
    permission.edit = {
      '*': 'deny',
      '.ai-work-flow/research/*.md': 'allow',
      '.ai-work-flow/research/*/*.md': 'deny'
    };
  }
  return permission;
}

function wildcardMatch(pattern, value) {
  const expression = pattern.replace(/[|\\{}()[\]^$+.]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
  return new RegExp(`^${expression}$`).test(value);
}

export function evaluateOpenCodePermission(role, policy, key, value = '*') {
  if (!OPENCODE_PERMISSION_KEYS.includes(key)) return 'deny';
  const permission = opencodePermission(role, policy)[key];
  if (typeof permission === 'string') return permission;
  let result = 'deny';
  const rules = Object.entries(permission).sort(([left], [right]) => left.length - right.length || left.localeCompare(right));
  for (const [pattern, action] of rules) if (wildcardMatch(pattern, value)) result = action;
  return result;
}

function opencodeRender(role, settings, body, policy) {
  const frontmatter = [
    '---',
    `description: ${yamlValue(agentDescription(role))}`,
    `mode: ${yamlValue(role.kind === 'primary' ? 'primary' : 'subagent')}`,
    `permission: ${yamlValue(opencodePermission(role, policy))}`
  ];
  if (settings.model) frontmatter.splice(3, 0, `model: ${yamlValue(settings.model)}`);
  if (settings.variant) frontmatter.push(`variant: ${yamlValue(settings.variant)}`);
  if (isPlainObject(settings.options) && Object.keys(settings.options).length) frontmatter.push(`options: ${yamlValue(settings.options)}`);
  frontmatter.push('---', '', body, '');
  return frontmatter.join('\n');
}

function opencodeUpdateConfig(source, path, roles, paths) {
  const current = source ? JSON.parse(source) : {};
  if (!isPlainObject(current)) fail(`Cannot safely merge opencode.json: root must be an object.`);
  if (current.agent !== undefined && !isPlainObject(current.agent)) {
    fail(`Cannot safely merge opencode.json: agent must be an object.`);
  }
  if (current.subagent_depth !== undefined && (!Number.isInteger(current.subagent_depth) || current.subagent_depth < 0)) {
    fail(`Cannot safely merge opencode.json: subagent_depth must be a non-negative integer.`);
  }
  if (current.mcp !== undefined && !isPlainObject(current.mcp)) fail(`Cannot safely merge opencode.json: mcp must be an object.`);
  const agent = { ...(current.agent ?? {}) };
  if (agent.explore === false) delete agent.explore;
  const defaultPrimary = roles.find((role) => role.default_primary === true);
  if (!defaultPrimary) fail('Cannot configure OpenCode without a default primary role.');
  const expected = { type: 'local', command: ['node', brokerPath(paths)], enabled: true };
  const mcp = mergeBrokerEntry(current.mcp ?? {}, expected, path, 'OpenCode');
  return `${JSON.stringify({ ...current, agent, mcp, subagent_depth: Math.max(MAX_AGENT_DEPTH, current.subagent_depth ?? 0), default_agent: defaultPrimary.id }, null, 2)}\n`;
}

function digest(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function agentFile(paths, platform, roleId) {
  const strategy = strategies[platform];
  return resolve(paths[strategy.agentDir], 'agents', `${roleId}.${strategy.extension}`);
}

function isManagedLegacyAgent(path) {
  try {
    return lstatSync(path).isFile() && readFileSync(path, 'utf8').includes('<!-- ai-work-flow:routing-digest=');
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function projectShadow(platform, roleId) {
  const extension = strategies[platform].extension;
  const agentPath = resolve(process.cwd(), `.${platform}`, 'agents', `${roleId}.${extension}`);
  if (existsSync(agentPath)) return 'project-agent';
  if (platform !== 'opencode') return null;
  for (const configPath of [resolve(process.cwd(), 'opencode.json'), resolve(process.cwd(), '.opencode', 'opencode.json')]) {
    if (!existsSync(configPath)) continue;
    try {
      const agent = JSON.parse(readFileSync(configPath, 'utf8')).agent;
      if (agent && typeof agent === 'object' && Object.hasOwn(agent, roleId)) return 'project-inline-agent';
    } catch {
      return 'project-config-unreadable';
    }
  }
  return null;
}

function userShadow(platform, paths, roleId) {
  if (platform === 'codex' && roleId === 'code-reviewer' && existsSync(resolve(paths.codexDir, 'agents', 'code-reviewer', LEGACY_CODE_REVIEWER_AGENT))) {
    return 'legacy-reviewer-agent';
  }
  if (platform !== 'opencode') return null;
  const configPath = resolve(paths.openCodeDir, 'opencode.json');
  if (!existsSync(configPath)) return null;
  try {
    const agent = JSON.parse(readFileSync(configPath, 'utf8')).agent;
    return agent && typeof agent === 'object' && Object.hasOwn(agent, roleId) ? 'user-inline-agent' : null;
  } catch {
    return 'user-config-unreadable';
  }
}

function markerDrift(strategy, paths) {
  if (!strategy.marker) return false;
  const path = strategy.marker.path(paths);
  try {
    const source = existsSync(path) ? readFileSync(path, 'utf8') : '';
    return strategy.marker.update(source, path) !== source;
  } catch {
    return true;
  }
}

function configurationDrift(strategy, paths, roles) {
  if (!strategy.globalConfig) return false;
  const path = strategy.globalConfig.path(paths);
  try {
    const source = existsSync(path) ? readFileSync(path, 'utf8') : '';
    return strategy.globalConfig.update(source, path, roles, paths) !== source;
  } catch {
    return true;
  }
}

// --- Strategy map ---

const strategies = {
  codex: {
    agentDir: 'codexDir',
    extension: 'toml',
    render: codexRender,
    globalConfig: {
      path: (paths) => resolve(paths.codexDir, 'config.toml'),
      update: (source, path, roles, paths) => codexBrokerConfig(codexUpdateConfig(source, path), path, paths)
    },
    marker: {
      path: (paths) => resolve(paths.codexDir, 'AGENTS.md'),
      update: updateManagedMarker
    }
  },
  claude: {
    agentDir: 'claudeDir',
    extension: 'md',
    render: claudeRender,
    globalConfig: {
      path: (paths) => paths.claudeConfig,
      update: claudeUpdateConfig
    },
    marker: {
      path: (paths) => resolve(paths.claudeDir, 'CLAUDE.md'),
      update: updateManagedMarker
    }
  },
  opencode: {
    agentDir: 'openCodeDir',
    extension: 'md',
    render: opencodeRender,
    globalConfig: {
      path: (paths) => resolve(paths.openCodeDir, 'opencode.json'),
      update: opencodeUpdateConfig
    },
    cleanup: true
  }
};

function capabilityLevel(platform, role, capability, requested) {
  if (capability === 'workflow_state') return role.tools.includes('WorkflowState') ? 'enforced' : 'instruction-only';
  if (capability === 'filesystem') {
    if (platform === 'codex') return requested === 'none' ? 'unsupported' : 'enforced';
    if (platform === 'opencode') return 'enforced';
    return 'instruction-only';
  }
  if (capability === 'delegation_targets') {
    if (platform === 'opencode' && role.delegates.length === 0 && requested !== 'allowed' && !role.tools.includes('Task')) return 'enforced';
    return 'instruction-only';
  }
  if (capability === 'write_scope' && platform === 'opencode') {
    return role.id === 'researcher' ? 'enforced' : 'instruction-only';
  }
  if (capability === 'network' || capability === 'browser') return 'unsupported';
  if (platform === 'opencode' && capability === 'delegation') return 'enforced';
  return 'instruction-only';
}

export function capabilityEvidence(platform, role, policy) {
  const levels = capabilityMatrix(platform, role, policy);
  return Object.fromEntries(Object.entries(levels).map(([capability, level]) => [capability, {
    requested: capability === 'delegation_targets' ? role.delegates : policy[capability],
    level,
    evidence: level === 'enforced' ? [capability === 'workflow_state' ? 'isolated MCP workflow broker' : 'platform permission key'] : []
  }]));
}

export function capabilityMatrix(platform, role, policy) {
  if (!strategies[platform]) fail(`Unknown platform: ${platform}`);
  return {
    ...Object.fromEntries(Object.entries(policy).map(([capability, requested]) => [capability, capabilityLevel(platform, role, capability, requested)])),
    delegation_targets: capabilityLevel(platform, role, 'delegation_targets', policy.delegation)
  };
}

export function controlMatrix(platform, role, policy, controls) {
  if (!strategies[platform]) fail(`Unknown platform: ${platform}`);
  const rank = { unsupported: 0, 'instruction-only': 1, enforced: 2 };
  return Object.fromEntries(role.controls.map((controlId) => {
    const requirements = controls[controlId].policy_requirements;
    const levels = Object.keys(requirements).map((capability) => capabilityLevel(platform, role, capability, policy[capability]));
    const level = levels.length
      ? levels.reduce((weakest, candidate) => rank[candidate] < rank[weakest] ? candidate : weakest, 'enforced')
      : 'instruction-only';
    return [controlId, level];
  }));
}

// --- Entry point ---

export function planGeneration({ platform, paths, roles, policies, config, bodies }) {
  const strategy = strategies[platform];
  const plan = [];
  const addWrite = (path, contents) => {
    const before = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    if (before !== contents) plan.push({ type: 'write', path, contents });
  };

  if (strategy.globalConfig) {
    const configPath = strategy.globalConfig.path(paths);
    const source = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
    addWrite(configPath, strategy.globalConfig.update(source, configPath, roles, paths));
  }

  if (strategy.marker) {
    const markerPath = strategy.marker.path(paths);
    const source = existsSync(markerPath) ? readFileSync(markerPath, 'utf8') : '';
    addWrite(markerPath, strategy.marker.update(source, markerPath));
  }

  const agentDir = resolve(paths[strategy.agentDir], 'agents');
  for (const role of roles) {
    const policy = policies?.[role.policy];
    if (!policy) fail(`Missing policy for role: ${role.id}`);
    addWrite(resolve(agentDir, `${role.id}.${strategy.extension}`), strategy.render(role, config.roles[role.id][platform], bodies.get(role.id), policy, { paths, roles }));
  }
  for (const legacyRoleId of [LEGACY_PRIMARY_AGENT_ID, LEGACY_GIT_OPERATOR_AGENT_ID]) {
    const legacyAgentPath = resolve(agentDir, `${legacyRoleId}.${strategy.extension}`);
    if (isManagedLegacyAgent(legacyAgentPath)) plan.push({ type: 'delete', path: legacyAgentPath });
  }

  if (platform === 'codex') {
    const legacyReviewerPath = resolve(agentDir, 'code-reviewer', LEGACY_CODE_REVIEWER_AGENT);
    assertNoSymbolicLinks(paths.codexDir, legacyReviewerPath);
    if (existsSync(legacyReviewerPath)) plan.push({ type: 'delete', path: legacyReviewerPath });
  }

  if (strategy.cleanup) {
    const guardPath = resolve(paths.openCodeDir, 'plugins/ai-work-flow-subagent-model-guard.js');
    if (existsSync(guardPath)) plan.push({ type: 'delete', path: guardPath });
  }

  return plan;
}

export function generationStatus({ platforms, paths, roles, policies, config, bodies, managedPlatforms, managedManifestPresent = true }) {
  return platforms.flatMap((platform) => {
    const strategy = strategies[platform];
    const markerIsDrifted = markerDrift(strategy, paths);
    const configurationIsDrifted = configurationDrift(strategy, paths, roles);
    return roles.map((role) => {
      const expected = strategy.render(role, config.roles[role.id][platform], bodies.get(role.id), policies[role.policy], { paths, roles });
      const target = agentFile(paths, platform, role.id);
      const reasons = [];
      let installedDigest;
      if (!managedManifestPresent || !managedPlatforms.includes(platform)) reasons.push('manifest');
      if (!existsSync(target)) reasons.push('missing');
      else {
        const installed = readFileSync(target, 'utf8');
        installedDigest = digest(installed);
        if (installed !== expected) reasons.push('bytes');
      }
      if (markerIsDrifted) reasons.push('marker');
      if (configurationIsDrifted) reasons.push('config');
      const shadows = [userShadow(platform, paths, role.id), projectShadow(platform, role.id)].filter(Boolean);
      reasons.push(...shadows);
      return {
        platform,
        role_id: role.id,
        state: shadows.length ? 'shadowed' : reasons.length ? 'drifted' : 'in-sync',
        reasons,
        planned_digest: digest(expected),
        ...(installedDigest ? { installed_digest: installedDigest } : {})
      };
    });
  });
}

export function applyGenerationPlan(plan, dryRun, transaction) {
  return applyTransaction(plan, { ...transaction, dryRun });
}

export function generate(options) {
  return applyGenerationPlan(planGeneration(options), options.dryRun, options.transaction);
}
