import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
const HEADINGS = ["角色结果", "能力与控制", "允许的 Actions 与输入", "执行循环", "完成标准", "决策条件", "结果返回"];
const CONTROL_MARKER = "<!-- ai-work-flow:controls -->";
const ACTION_MARKER = "<!-- ai-work-flow:actions -->";
const RESULT_MARKER = "<!-- ai-work-flow:task-result -->";
export const MAX_COMPILED_PROMPT_CHARACTERS = 11_500;
export const MAX_COMPILED_PROMPTS_CHARACTERS = 57_000;
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

function resultFieldNames(contract) {
  const fields = new Set(["result", "summary"]);
  const groups = [
    ...Object.values(contract.io_contracts ?? {}).map((io) => io.result_contracts ?? {}),
    ...Object.values(contract.support_result_contracts ?? {}),
  ];
  for (const results of groups) for (const output of Object.values(results)) {
    for (const field of [...(output.required_fields ?? []), ...(output.optional_fields ?? []), ...(output.required_error_fields ?? [])]) fields.add(field);
  }
  return fields;
}

function validateContract(contract, schemas, errors) {
  if (!isPlainObject(contract) || !isPlainObject(contract.actions) || !isPlainObject(contract.workflows) ||
    !isPlainObject(contract.task_result) || !isPlainObject(contract.structured_content)) {
    errors.push("workflow-contract.json must define actions, workflows, TaskResult, and structured content.");
    return;
  }
  const { digest, ...unsigned } = contract;
  const actual = createHash("sha256").update(JSON.stringify(canonicalize(unsigned))).digest("hex");
  if (digest !== actual) errors.push("workflow-contract.json digest is stale.");
  if (!isPlainObject(schemas) || schemas.contract_digest !== digest || !isPlainObject(schemas.envelope) ||
    !isPlainObject(schemas.field_schemas) || !isPlainObject(schemas.structured_content_schemas)) {
    errors.push("task-result-schemas.json is invalid or stale.");
  } else {
    for (const field of resultFieldNames(contract)) {
      const schema = schemas.envelope[field] ?? schemas.field_schemas[field];
      if (!isPlainObject(schema) || typeof schema.prompt_type !== "string" || !schema.prompt_type.trim()) errors.push(`TaskResult schema is missing: ${field}.`);
    }
    for (const [name, content] of Object.entries(contract.structured_content)) {
      const schema = schemas.structured_content_schemas[name];
      if (!isPlainObject(schema) || schema.type !== "object" || !Array.isArray(schema.required) ||
        JSON.stringify([...schema.required].sort()) !== JSON.stringify([...content.required_fields].sort())) {
        errors.push(`Structured content schema is missing or stale: ${name}.`);
      }
    }
  }
  for (const [id, action] of Object.entries(contract.actions)) {
    if (!action.owner || !action.workflow) errors.push(`Action ${id} must declare owner and workflow.`);
    if (!action.io_contract || !contract.io_contracts?.[action.io_contract]) errors.push(`Action ${id} must reference a named I/O contract.`);
    if (action.workflow !== "support" && (!action.from || !action.completed_to || !contract.workflows[action.workflow]?.phase_actions?.[action.from]?.includes(id))) {
      errors.push(`Action ${id} has an invalid transition.`);
    }
    if (action.completed_to_by_task_mode) {
      const workflow = contract.workflows[action.workflow];
      const branches = action.completed_to_by_task_mode;
      const phases = new Set([...Object.keys(workflow?.phase_actions ?? {}), ...(workflow?.terminal_phases ?? [])]);
      if (!isPlainObject(branches) || Object.keys(branches).sort().join() !== "single,split" || Object.values(branches).some((phase) => !phases.has(phase))) {
        errors.push(`Action ${id} has an invalid task mode transition.`);
      }
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

function validateAssets(catalog, controlsDocument, policiesDocument, defaults, templates, contract, schemas) {
  const errors = [];
  validateContract(contract, schemas, errors);
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
  for (const [callerOwner, supportActions] of Object.entries(contract.support_delegations ?? {})) {
    const caller = roles.find((role) => role.id === callerOwner);
    for (const actionId of supportActions) {
      const supportOwner = contract.actions[actionId]?.owner;
      if (!caller?.delegates.includes(supportOwner)) errors.push(`Support delegation ${callerOwner} -> ${actionId} is not allowed by roles.json.`);
    }
  }
  for (const id of Object.keys(contract.actions)) if (!referencedActions.has(id)) errors.push(`Action is not assigned to a role: ${id}.`);
  const supportRoles = roles.filter((role) => role.kind !== "primary" && role.actions.length === 0).map((role) => role.id).sort();
  if (JSON.stringify(Object.keys(contract.support_result_contracts ?? {}).sort()) !== JSON.stringify(supportRoles)) {
    errors.push("Every non-primary role without an action must have one support result contract.");
  }
  if (!isPlainObject(defaults?.roles)) errors.push("default-config.json must define roles.");
  for (const id of ids) for (const platform of PLATFORM_NAMES) if (!isPlainObject(defaults?.roles?.[id]?.[platform])) errors.push(`default-config.json is missing ${id}/${platform}.`);
  const expectedTemplates = ids.map((id) => `${id}.md`).sort();
  if (JSON.stringify([...templates.keys()].map((id) => `${id}.md`).sort()) !== JSON.stringify(expectedTemplates)) errors.push("Templates and roles.json do not match.");
  for (const [id, body] of templates) {
    const positions = HEADINGS.map((heading) => body.indexOf(`## ${heading}`));
    if (positions.some((position) => position < 0) || positions.some((position, index) => index && position <= positions[index - 1])) errors.push(`Template ${id}.md must use the seven ordered interface headings.`);
    for (const marker of [CONTROL_MARKER, ACTION_MARKER, RESULT_MARKER]) if (body.split(marker).length !== 2) errors.push(`Template ${id}.md must contain one ${marker}.`);
  }
  if (errors.length) fail(`Agent asset catalog is invalid:\n${errors.join("\n")}`);
  return { roles, controls, policies };
}

function typedField(field, schemas) {
  const schema = schemas.envelope[field] ?? schemas.field_schemas[field];
  return `${field}:${schema.prompt_type}`;
}

function resultTemplate(name, output) {
  const fields = [...new Set([...output.required_fields, ...(output.required_error_fields ?? [])])];
  const required = [`result:"${name}"`, "summary", ...fields].join(",");
  const optional = output.optional_fields.length ? `；可选字段=${output.optional_fields.join(",")}` : "";
  return `\`{${required}}\`${optional}`;
}

function fieldTypes(results, schemas) {
  const fields = [...new Set(["summary", ...Object.values(results).flatMap((output) => [
    ...output.required_fields, ...output.optional_fields, ...(output.required_error_fields ?? []),
  ])])];
  const exceptions = fields.filter((field) => !["string", "path string", "absolute path"].includes((schemas.envelope[field] ?? schemas.field_schemas[field]).prompt_type));
  return `未列字段:string,${exceptions.map((field) => typedField(field, schemas)).join(",")}`;
}

function structuredSchemaText(fields, contract) {
  return [...new Set(fields)].filter((field) => contract.structured_content[field]).map((field) => {
    const schema = contract.structured_content[field];
    const guidance = Object.entries(schema.field_guidance).map(([name, value]) => `${name}=${value}`).join(", ");
    return `\`${field}={${schema.required_fields.join(",")}}\`${guidance ? `（${guidance}）` : ""}`;
  }).join("；");
}

function contractGroupText(ids, ioName, contract, roleNames, includeStructures = true) {
  const io = contract.io_contracts[ioName];
  const input = io.input_contract;
  const actionsByOwner = new Map();
  for (const id of ids) {
    const owner = roleNames.get(contract.actions[id].owner) ?? contract.actions[id].owner;
    actionsByOwner.set(owner, [...(actionsByOwner.get(owner) ?? []), `\`${id}\``]);
  }
  const actions = [...actionsByOwner].map(([owner, actionIds]) => `**${owner}**=${actionIds.join("、")}`).join("；");
  const results = Object.entries(io.result_contracts).map(([name, output]) => resultTemplate(name, output)).join("；");
  const structuredFields = [
    ...input.required_fields, ...input.optional_fields,
    ...Object.values(io.result_contracts).flatMap((output) => [...output.required_fields, ...output.optional_fields]),
  ];
  const structures = includeStructures ? structuredSchemaText(structuredFields, contract) : "";
  return `- Actions：${actions}\n  - 输入：必需=${input.required_fields.join(",") || "无"}；可选=${input.optional_fields.join(",") || "无"}。\n  - \`TaskResult\` 验收：${results}。${structures ? `\n  - 完整结构：${structures}。` : ""}`;
}

function actionText(role, contract, schemas, roles) {
  const roleNames = new Map(roles.map((entry) => [entry.id, entry.name]));
  if (role.kind !== "primary" && role.actions.length === 0) {
    const results = contract.support_result_contracts[role.id];
    const templates = Object.entries(results).map(([name, output]) => resultTemplate(name, output)).join("；");
    const fields = Object.values(results).flatMap((output) => [...output.required_fields, ...output.optional_fields]);
    const structures = structuredSchemaText(fields, contract);
    return `- 字段类型：${fieldTypes(results, schemas)}。\n- 支持委派 \`TaskResult\` 验收：${templates}。${structures ? `\n  - 完整结构：${structures}。` : ""}`;
  }
  const actionIds = role.kind === "primary"
    ? Object.keys(contract.actions).filter((id) => contract.actions[id].workflow === role.id)
    : role.actions;
  const groups = new Map();
  for (const id of actionIds) {
    const ioName = contract.actions[id].io_contract;
    groups.set(ioName, [...(groups.get(ioName) ?? []), id]);
  }
  const resultContracts = Object.fromEntries([...groups].flatMap(([ioName]) => Object.entries(contract.io_contracts[ioName].result_contracts)
    .map(([name, output], index) => [`${ioName}:${name}:${index}`, output])));
  const primaryStructures = role.kind === "primary" ? structuredSchemaText([...groups].flatMap(([ioName]) => {
    const io = contract.io_contracts[ioName];
    return [
      ...io.input_contract.required_fields, ...io.input_contract.optional_fields,
      ...Object.values(io.result_contracts).flatMap((output) => [...output.required_fields, ...output.optional_fields]),
    ];
  }), contract) : "";
  const groupText = [...groups].map(([ioName, ids]) => contractGroupText(ids, ioName, contract, roleNames, role.kind !== "primary")).join("\n");
  return `- 字段类型：${fieldTypes(resultContracts, schemas)}。\n${groupText}${primaryStructures ? `\n- 完整结构：${primaryStructures}。` : ""}`;
}

function controlsText(role, controls, policies) {
  const delegates = role.delegates.length ? role.delegates.map((id) => `\`${id}\``).join("、") : "无";
  const skills = role.skills.length ? role.skills.map((name) => `\`$${name}\``).join("、") : "无；不得调用任何 managed Skill";
  const capabilities = Object.entries(policies[role.policy]).map(([key, value]) => `${key}=${value}`).join("; ");
  return [
    `- 能力请求：${capabilities}。`,
    `- 可委派角色：${delegates}。`,
    `- Skill 所有权：${skills}。`,
    ...role.controls.map((id) => `- \`${id}\`：${controls[id].instruction}`),
  ].join("\n");
}

function resultText(role) {
  if (role.kind === "primary") return "每次委派附对应验收模板，并要求 `TaskResult` 使用 2 个空格缩进的多行 JSON。收到可解析 JSON 对象后检查 `result`、字段类型、必需字段、额外字段和完整结构；合格才进入下一 action。不合格时指出字段路径、预期与实际类型并要求原地重返，不重复任务。";
  return "只返回一个可解析的 JSON `TaskResult` 对象，并使用 2 个空格缩进的多行格式，无前后文字或 code fence。字段置于顶层，不使用 `outputs`/`error` 包装；空数组返回 `[]`，不得以字符串代替数组。仅使用当前结果分支允许的字段，完整结构不得用摘要、路径或省略号代替。";
}

export function loadAgentAssets(configRoot = resolve(import.meta.dirname, "..", "config"), templatesRoot = resolve(import.meta.dirname, "..", "templates"), workflowContractPath = contractPath()) {
  const config = resolve(configRoot);
  const templateRoot = resolve(templatesRoot);
  const contractFile = workflowContractPath;
  if (!contractFile) fail("Missing workflow-contract.json.");
  const contract = readJson(contractFile);
  const schemasFile = resolve(dirname(contractFile), "task-result-schemas.json");
  if (!existsSync(schemasFile)) fail("Missing task-result-schemas.json.");
  const schemas = readJson(schemasFile);
  const catalog = readJson(resolve(config, "roles.json"));
  const controlDocument = readJson(resolve(config, "controls.json"));
  const policyDocument = readJson(resolve(config, "policies.json"));
  const defaults = readJson(resolve(config, "default-config.json"));
  const skillAssets = loadSkillAssets(config, undefined, contractFile);
  const bodies = new Map(readdirSync(templateRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => [entry.name.slice(0, -3), readFileSync(resolve(templateRoot, entry.name), "utf8").trimEnd()]));
  const validated = validateAssets(catalog, controlDocument, policyDocument, defaults, bodies, contract, schemas);
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
      .replace(ACTION_MARKER, actionText(role, contract, schemas, roles))
      .replace(RESULT_MARKER, resultText(role));
    if (compiled.length > MAX_COMPILED_PROMPT_CHARACTERS) fail(`Compiled prompt ${role.id} exceeds ${MAX_COMPILED_PROMPT_CHARACTERS} characters: ${compiled.length}.`);
    return [role.id, compiled];
  }));
  const total = [...compiledBodies.values()].reduce((sum, prompt) => sum + prompt.length, 0);
  if (total > MAX_COMPILED_PROMPTS_CHARACTERS) fail(`Compiled prompts exceed ${MAX_COMPILED_PROMPTS_CHARACTERS} characters: ${total}.`);
  return { configRoot: config, templatesRoot: templateRoot, roles, controls, policies, defaults, bodies, compiledBodies, routing, contract, taskResultSchemas: schemas, skills: skillAssets.skills };
}
