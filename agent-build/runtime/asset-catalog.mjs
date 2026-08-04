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
  write_scope: new Set(["none", "docs", "planning-artifacts", "tasks", "research", "code", "git", "environment"]),
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
  WorkflowState: ["workflow_state", new Set(["write"])],
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
    if (!action.io_contract || !contract.io_contracts?.[action.io_contract]) errors.push(`Action ${id} must reference a named I/O contract.`);
    if (action.workflow !== "support" && (!action.from || !action.completed_to || !contract.workflows[action.workflow]?.phase_actions?.[action.from]?.includes(id))) {
      errors.push(`Action ${id} has an invalid transition.`);
    }
  }
}

function validateDelegateGraph(roles, errors) {
  const byId = new Map(roles.map((role) => [role.id, role]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (id, path) => {
    if (visiting.has(id)) {
      errors.push(`Role delegation contains a cycle: ${[...path, id].join(" -> ")}.`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const delegate of byId.get(id)?.delegates ?? []) visit(delegate, [...path, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const role of roles) visit(role.id, []);
}

function validateDelegateDepth(roles, errors) {
  const byId = new Map(roles.map((role) => [role.id, role]));
  const visit = (id, path) => {
    if (path.length - 1 > MAX_AGENT_DEPTH) {
      errors.push(`Role delegation exceeds max depth ${MAX_AGENT_DEPTH}: ${path.join(" -> ")}.`);
      return;
    }
    for (const delegate of byId.get(id)?.delegates ?? []) if (!path.includes(delegate)) visit(delegate, [...path, delegate]);
  };
  for (const role of roles.filter((candidate) => candidate.kind === "primary")) visit(role.id, [role.id]);
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
    if (policy?.delegation === "none" && ((role.delegates?.length ?? 0) > 0 || role.tools?.includes("Task"))) errors.push(`Role ${role.id} conflicts with delegation=none.`);
    if (policy?.delegation === "review-only" && (role.delegates ?? []).some((id) => roles.find((candidate) => candidate.id === id)?.kind !== "reviewer")) {
      errors.push(`Role ${role.id} review-only delegation must target reviewers.`);
    }
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
  for (const role of roles) {
    const policy = policies[role.policy];
    if (!policy) continue;
    for (const id of role.controls ?? []) {
      for (const [capability, values] of Object.entries(controls[id]?.policy_requirements ?? {})) {
        if (Array.isArray(values) && !values.includes(policy[capability])) {
          errors.push(`Role ${role.id} policy does not satisfy control ${id}: ${capability}=${policy[capability]}.`);
        }
      }
    }
  }
  validateDelegateGraph(roles, errors);
  validateDelegateDepth(roles, errors);
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
    const io = contract.io_contracts[action.io_contract];
    const input = io.input_contract;
    const result = Object.entries(io.result_contracts).map(([name, output]) => {
      const error = output.required_error_fields?.length ? `；error=${output.required_error_fields.join(",")}` : "";
      return `${name}[outputs=${output.required_fields.join(",") || "无"}; artifacts=${output.required_artifact_kinds.join(",") || "无"}${error}]`;
    }).join("；");
    const gate = action.workflow === "support" ? "经 support_validate 校验且不推进 phase" : `phase=\`${action.from}\` 且位于 ready_actions`;
    return `- \`${id}\`（\`${action.io_contract}\`）：${gate}；input.fields 必需=${input.required_fields.join(",") || "无"}，可选=${input.optional_fields.join(",") || "无"}；input.artifacts=${input.required_artifact_kinds.join(",") || "无"}。结果：${result}。`;
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

function receiptText(role, contract) {
  const supportOnly = role.actions.every((id) => contract.actions[id].workflow === "support");
  if (supportOnly) return "只返回一个 `SupportReceipt`：`run_id`、`caller_ref`、稳定 `call_id`、`action_id`、`result`、`summary`、`outputs`、`artifacts`、`checks`；需要决定时附 `decision_request`，失败时附契约要求的 `error`。调用者用原始 support input 执行 `support_validate`，并把重要 refs、checks 与失败写入父 `ActionReceipt`。";
  return "只返回一个 `ActionReceipt`：`run_id`、`action_id`、`attempt`、`result`、`summary`、必需 `outputs`、`artifacts`、`checks`；需要决定时附 `decision_request`，失败时附契约要求的 `error`。完整证据写入本地 artifact，聊天只传 `ArtifactRef`；响应损坏时用 `status(action_id)` 读取同一 canonical receipt。";
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
  const validated = validateAssets(catalog, controlDocument, policyDocument, defaults, bodies, contract);
  const skillNamesByOwner = new Map();
  for (const skill of skillAssets.skills) skillNamesByOwner.set(skill.owner, [...(skillNamesByOwner.get(skill.owner) ?? []), skill]);
  const roles = validated.roles.map((role) => ({ ...role, skills: (skillNamesByOwner.get(role.id) ?? []).map((skill) => skill.name).sort() }));
  for (const role of roles) {
    if (role.tools.includes("Skill") !== (role.skills.length > 0)) fail(`Role ${role.id} Skill tool must match skills.json ownership.`);
  }
  const { controls, policies } = validated;
  const routing = readFileSync(resolve(config, "routing.md"), "utf8");
  const routingDigest = createHash("sha256").update(routing).digest("hex");
  const compiledBodies = new Map(roles.map((role) => {
    const compiled = `<!-- ai-work-flow:contract-digest=${contract.digest} routing-digest=${routingDigest} -->\n\n${bodies.get(role.id)}`
      .replace(CONTROL_MARKER, controlsText(role, controls, policies))
      .replace(ACTION_MARKER, actionText(role, contract))
      .replace(RECEIPT_MARKER, receiptText(role, contract));
    if (compiled.length > MAX_PROMPT) fail(`Compiled prompt ${role.id} exceeds ${MAX_PROMPT} characters.`);
    return [role.id, compiled];
  }));
  const total = [...compiledBodies.values()].reduce((sum, prompt) => sum + prompt.length, 0);
  if (total > MAX_TOTAL) fail(`Compiled prompts exceed ${MAX_TOTAL} characters: ${total}.`);
  return { configRoot: config, templatesRoot: templateRoot, roles, controls, policies, defaults, bodies, compiledBodies, routing, contract, skills: skillAssets.skills };
}
