import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { fail, isPlainObject, readJson } from "./shared.mjs";
import { loadSkillAssets } from "./skill-catalog.mjs";

const PLATFORM_NAMES = ["codex", "claude", "opencode"];
const ROLE_KINDS = new Set(["primary", "subagent", "reviewer"]);
const CAPABILITIES = {
  filesystem: new Set(["none", "read", "write"]),
  shell: new Set(["none", "read", "write", "git"]),
  network: new Set(["none", "official"]),
  browser: new Set(["none"]),
  git: new Set(["none", "read", "write"]),
  write_scope: new Set(["none", "docs", "planning-artifacts", "tasks", "research", "code", "git"]),
  delegation: new Set(["none", "allowed", "review-only"]),
  workflow_state: new Set(["none", "read", "write"]),
};
const TOOL_REQUIREMENTS = {
  Read: ["filesystem", new Set(["read", "write"])],
  Glob: ["filesystem", new Set(["read", "write"])],
  Grep: ["filesystem", new Set(["read", "write"])],
  Edit: ["filesystem", new Set(["write"])],
  Write: ["filesystem", new Set(["write"])],
  Bash: ["shell", new Set(["read", "write", "git"])],
  WebSearch: ["network", new Set(["official"])],
  WebFetch: ["network", new Set(["official"])],
  Task: ["delegation", new Set(["allowed", "review-only"])],
  Skill: null,
};
const HEADINGS = ["角色结果", "能力与控制", "允许的 Actions 与输入", "执行循环", "完成标准", "决策条件", "结果回执"];
const CONTROL_MARKER = "<!-- ai-work-flow:controls -->";
const ACTION_MARKER = "<!-- ai-work-flow:actions -->";
const RECEIPT_MARKER = "<!-- ai-work-flow:receipt -->";
const MAX_PROMPT = 8_000;
const MAX_TOTAL = 45_000;
export const MAX_AGENT_DEPTH = 2;

function unique(values) {
  return Array.isArray(values) && new Set(values).size === values.length;
}

function contractPath() {
  return [
    resolve(import.meta.dirname, "..", "..", "execution-runtime", "workflow-contract.json"),
    resolve(import.meta.dirname, "..", "execution-runtime", "workflow-contract.json"),
  ].find(existsSync);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

function validateContract(contract, errors) {
  if (!isPlainObject(contract) || !isPlainObject(contract.actions) || !isPlainObject(contract.workflows)) {
    errors.push("workflow-contract.json must define actions and workflows.");
    return;
  }
  const { digest, ...unsigned } = contract;
  const actual = createHash("sha256").update(JSON.stringify(canonicalize(unsigned))).digest("hex");
  if (digest !== actual) errors.push("workflow-contract.json digest is stale.");
  for (const [id, action] of Object.entries(contract.actions)) {
    if (!action.owner || !action.workflow) errors.push(`Action ${id} must declare owner and workflow.`);
    if (action.workflow !== "support" && (!action.from || !action.completed_to || !contract.workflows[action.workflow]?.phase_actions?.[action.from]?.includes(id))) {
      errors.push(`Action ${id} has an invalid transition.`);
    }
  }
}

function validateAssets(catalog, controlsDocument, policiesDocument, defaults, templates, contract) {
  const errors = [];
  validateContract(contract, errors);
  if (!isPlainObject(catalog) || !Array.isArray(catalog.roles) || Object.keys(catalog).some((key) => key !== "roles")) errors.push("roles.json must contain only a roles array.");
  const roles = Array.isArray(catalog?.roles) ? catalog.roles : [];
  const ids = roles.map((role) => role?.id);
  if (!unique(ids)) errors.push("roles.json contains duplicate role ids.");
  if (roles.filter((role) => role.default_primary).length !== 1) errors.push("roles.json must declare exactly one default primary role.");
  if (!isPlainObject(controlsDocument?.controls)) errors.push("controls.json must define controls.");
  if (!isPlainObject(policiesDocument?.policies)) errors.push("policies.json must define policies.");
  const controls = controlsDocument?.controls ?? {};
  const policies = policiesDocument?.policies ?? {};
  const referencedControls = new Set();
  const referencedActions = new Set();
  for (const role of roles) {
    const allowed = ["id", "name", "description", "kind", "default_primary", "policy", "controls", "delegates", "tools", "actions"];
    if (!isPlainObject(role) || Object.keys(role).some((key) => !allowed.includes(key)) || !ROLE_KINDS.has(role.kind)) errors.push(`Role ${role?.id ?? "unknown"} has an invalid shape.`);
    for (const field of ["id", "name", "description", "policy"]) if (typeof role[field] !== "string" || !role[field]) errors.push(`Role ${role.id} must declare ${field}.`);
    for (const field of ["controls", "delegates", "tools", "actions"]) if (!unique(role[field])) errors.push(`Role ${role.id}.${field} must be a duplicate-free array.`);
    if (!policies[role.policy]) errors.push(`Role ${role.id} references unknown policy ${role.policy}.`);
    for (const id of role.controls ?? []) {
      if (!controls[id]) errors.push(`Role ${role.id} references unknown control ${id}.`);
      referencedControls.add(id);
    }
    for (const id of role.actions ?? []) {
      if (contract.actions[id]?.owner !== role.id) errors.push(`Role ${role.id} does not own action ${id}.`);
      if (referencedActions.has(id)) errors.push(`Action ${id} is assigned more than once.`);
      referencedActions.add(id);
    }
    for (const delegate of role.delegates ?? []) if (!ids.includes(delegate)) errors.push(`Role ${role.id} delegates to unknown role ${delegate}.`);
    const policy = policies[role.policy];
    for (const tool of role.tools ?? []) {
      const requirement = TOOL_REQUIREMENTS[tool];
      if (requirement === undefined) errors.push(`Role ${role.id} declares unknown tool ${tool}.`);
      else if (requirement && policy && !requirement[1].has(policy[requirement[0]])) errors.push(`Role ${role.id} tool ${tool} conflicts with policy.`);
    }
  }
  for (const [name, policy] of Object.entries(policies)) {
    if (!isPlainObject(policy) || Object.keys(CAPABILITIES).some((key) => !CAPABILITIES[key].has(policy[key]))) errors.push(`Policy ${name} is incomplete or invalid.`);
  }
  for (const [id, control] of Object.entries(controls)) {
    if (!referencedControls.has(id)) errors.push(`Control is not referenced: ${id}.`);
    if (!isPlainObject(control) || typeof control.instruction !== "string" || !control.instruction.trim() || !isPlainObject(control.policy_requirements)) errors.push(`Control ${id} is invalid.`);
    for (const [capability, values] of Object.entries(control.policy_requirements ?? {})) {
      if (!CAPABILITIES[capability] || !unique(values) || values.some((value) => !CAPABILITIES[capability].has(value))) errors.push(`Control ${id}.${capability} is invalid.`);
    }
  }
  for (const id of Object.keys(contract.actions)) if (!referencedActions.has(id)) errors.push(`Action is not assigned to a role: ${id}.`);
  if (!isPlainObject(defaults?.roles)) errors.push("default-config.json must define roles.");
  for (const id of ids) for (const platform of PLATFORM_NAMES) if (!isPlainObject(defaults?.roles?.[id]?.[platform])) errors.push(`default-config.json is missing ${id}/${platform}.`);
  const expectedTemplates = ids.map((id) => `${id}.md`).sort();
  if (JSON.stringify([...templates.keys()].map((id) => `${id}.md`).sort()) !== JSON.stringify(expectedTemplates)) errors.push("Templates and roles.json do not match.");
  for (const [id, body] of templates) {
    const positions = HEADINGS.map((heading) => body.indexOf(`## ${heading}`));
    if (positions.some((position) => position < 0) || positions.some((position, index) => index && position <= positions[index - 1])) errors.push(`Template ${id}.md must use the seven ordered interface headings.`);
    for (const marker of [CONTROL_MARKER, ACTION_MARKER, RECEIPT_MARKER]) if (body.split(marker).length !== 2) errors.push(`Template ${id}.md must contain one ${marker}.`);
  }
  if (errors.length) fail(`Agent asset catalog is invalid:\n${errors.join("\n")}`);
  return { roles, controls, policies };
}

function actionText(role, contract) {
  return role.actions.map((id) => {
    const action = contract.actions[id];
    const input = action.workflow === "support" ? "由调用者提供精确目标和验收证据" : `仅当 snapshot.phase 为 \`${action.from}\` 且 \`ready_actions\` 包含此 ID`;
    return `- \`${id}\`：${input}；成功后由 runtime 转到 \`${action.completed_to ?? "support result"}\`。`;
  }).join("\n");
}

function controlsText(role, controls, policies) {
  const delegates = role.delegates.length ? role.delegates.map((id) => `\`${id}\``).join("、") : "无";
  const capabilities = Object.entries(policies[role.policy]).map(([key, value]) => `${key}=${value}`).join("; ");
  return [
    `- 能力请求：${capabilities}。`,
    `- 可委派角色：${delegates}。`,
    ...role.controls.map((id) => `- \`${id}\`：${controls[id].instruction}`),
  ].join("\n");
}

function receiptText() {
  return "只返回一个 `ActionReceipt`：`run_id`、`action_id`、`attempt`、`result`、`summary`、`artifacts`、`checks`，需要用户决定时附 `decision_request`，失败时可附 `error`。完整证据写入本地 artifact，聊天只传 `ArtifactRef`。";
}

export function loadAgentAssets(configRoot = resolve(import.meta.dirname, "..", "config"), templatesRoot = resolve(import.meta.dirname, "..", "templates"), workflowContractPath = contractPath()) {
  const config = resolve(configRoot);
  const templateRoot = resolve(templatesRoot);
  const contractFile = workflowContractPath;
  if (!contractFile) fail("Missing workflow-contract.json.");
  const contract = readJson(contractFile);
  const catalog = readJson(resolve(config, "roles.json"));
  const controlDocument = readJson(resolve(config, "controls.json"));
  const policyDocument = readJson(resolve(config, "policies.json"));
  const defaults = readJson(resolve(config, "default-config.json"));
  const skillAssets = loadSkillAssets(config, undefined, contractFile);
  const bodies = new Map(readdirSync(templateRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => [entry.name.slice(0, -3), readFileSync(resolve(templateRoot, entry.name), "utf8").trimEnd()]));
  const { roles, controls, policies } = validateAssets(catalog, controlDocument, policyDocument, defaults, bodies, contract);
  const routing = readFileSync(resolve(config, "routing.md"), "utf8");
  const routingDigest = createHash("sha256").update(routing).digest("hex");
  const compiledBodies = new Map(roles.map((role) => {
    const compiled = `<!-- ai-work-flow:contract-digest=${contract.digest} routing-digest=${routingDigest} -->\n\n${bodies.get(role.id)}`
      .replace(CONTROL_MARKER, controlsText(role, controls, policies))
      .replace(ACTION_MARKER, actionText(role, contract))
      .replace(RECEIPT_MARKER, receiptText());
    if (compiled.length > MAX_PROMPT) fail(`Compiled prompt ${role.id} exceeds ${MAX_PROMPT} characters.`);
    return [role.id, compiled];
  }));
  const total = [...compiledBodies.values()].reduce((sum, prompt) => sum + prompt.length, 0);
  if (total > MAX_TOTAL) fail(`Compiled prompts exceed ${MAX_TOTAL} characters: ${total}.`);
  return { configRoot: config, templatesRoot: templateRoot, roles, controls, policies, defaults, bodies, compiledBodies, routing, contract, skills: skillAssets.skills };
}
