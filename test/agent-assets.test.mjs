import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import TOML from "@iarna/toml";
import { parse as parseYaml } from "yaml";

import { loadAgentAssets } from "../agent-build/runtime/asset-catalog.mjs";
import { capabilityEvidence, capabilityMatrix, controlMatrix, evaluateOpenCodePermission, planGeneration } from "../agent-build/runtime/platform-adapter.mjs";
import { loadSkillAssets, renderSkillOpenAiYaml } from "../agent-build/runtime/skill-catalog.mjs";

const root = resolve(import.meta.dirname, "..");
const configRoot = resolve(root, "agent-build/config");
const templatesRoot = resolve(root, "agent-build/templates");
const contractPath = resolve(root, "execution-runtime/workflow-contract.json");
const headings = ["角色结果", "能力与控制", "允许的 Actions 与输入", "执行循环", "完成标准", "决策条件", "结果回执"];
const retiredTerms = [
  ["protocol", "recovery", "attempt"].join("_"),
  ["prepare", "envelope"].join(" "),
  ["directory", "bundle"].join("_"),
  ["fixed", "point"].join("_"),
  ["runtime", "provenance"].join("_"),
];

function fixtureAssets() {
  const fixture = mkdtempSync(resolve(tmpdir(), "agent-assets-"));
  const fixtureConfig = resolve(fixture, "config");
  const fixtureTemplates = resolve(fixture, "templates");
  const fixtureContract = resolve(fixture, "workflow-contract.json");
  cpSync(configRoot, fixtureConfig, { recursive: true });
  cpSync(templatesRoot, fixtureTemplates, { recursive: true });
  cpSync(contractPath, fixtureContract);
  return { fixtureConfig, fixtureTemplates, fixtureContract };
}

test("machine contract assigns every action to exactly one of 14 roles", () => {
  const assets = loadAgentAssets();
  assert.equal(assets.roles.length, 14);
  const assigned = assets.roles.flatMap((role) => role.actions).sort();
  assert.deepEqual(assigned, Object.keys(assets.contract.actions).sort());
  for (const role of assets.roles) {
    for (const action of role.actions) assert.equal(assets.contract.actions[action].owner, role.id, action);
  }
});

test("compiled prompts use the seven-section interface and stay within budgets", () => {
  const assets = loadAgentAssets();
  let total = 0;
  for (const role of assets.roles) {
    const prompt = assets.compiledBodies.get(role.id);
    total += prompt.length;
    assert.ok(prompt.length <= 8_000, role.id);
    const positions = headings.map((heading) => prompt.indexOf(`## ${heading}`));
    assert.ok(positions.every((position) => position >= 0), role.id);
    assert.ok(positions.every((position, index) => index === 0 || position > positions[index - 1]), role.id);
    assert.match(prompt, new RegExp(`contract-digest=${assets.contract.digest}`));
    assert.match(prompt, /ActionReceipt/);
    assert.match(prompt, new RegExp(`\\*\\*${role.name}\\*\\*`), role.id);
    for (const term of retiredTerms) assert.equal(prompt.includes(term), false, `${role.id}: ${term}`);
  }
  assert.ok(total <= 45_000, total);
});

test("planning artifact prompts preserve fenced Markdown file templates", () => {
  const compiled = loadAgentAssets().compiledBodies;
  const writer = compiled.get("planning-writer");
  const tasks = compiled.get("task-planner");
  assert.match(writer, /### `spec\.md` 文件模板[\s\S]*```markdown[\s\S]*status: `approved`[\s\S]*## 开放问题[\s\S]*N\/A[\s\S]*```/);
  assert.match(writer, /### `plan\.md` 文件模板[\s\S]*```markdown[\s\S]*source_spec_digest:[\s\S]*task_mode:[\s\S]*```/);
  assert.match(tasks, /tasks\/NN-<short-name>\.md[\s\S]*```markdown[\s\S]*task_id:[\s\S]*source_plan_digest:[\s\S]*## 验收标准[\s\S]*```/);
});

test("Planning numbers requirement questions and explains each recommendation", () => {
  const planning = loadAgentAssets().compiledBodies.get("planning");
  assert.match(planning, /需求确认的首题显示 `问题 1`/);
  assert.match(planning, /后续按 decision history 自增且不重复/);
  assert.match(planning, /每题列出推荐选项，并用已知事实解释推荐原因/);
});

test("primary agents only orchestrate delegated work and Coding uses verified startup metadata", () => {
  const assets = loadAgentAssets();
  const coding = assets.compiledBodies.get("coding");
  const planning = assets.compiledBodies.get("planning");
  assert.deepEqual(assets.roles.find((role) => role.id === "coding").actions, []);
  assert.equal(Object.hasOwn(assets.contract.actions, "support.orchestrate"), false);
  for (const prompt of [coding, planning]) {
    assert.match(prompt, /不得自行读取|不得直接读取/);
    assert.match(prompt, /File Explorer/);
    assert.match(prompt, /不得.*联网/);
  }
  assert.match(coding, /计划启动预检|启动预检/);
  assert.match(coding, /kind=coding/);
  assert.match(coding, /plan_digest/);
  assert.match(coding, /task_mode/);
  assert.ok(coding.indexOf("启动预检") < coding.indexOf("start(repository"));
  assert.match(coding, /只恢复这个响应返回的 `run_id`/);
  assert.match(coding, /其他 run 的 claim 不阻塞本 run/);
  assert.doesNotMatch(coding, /先用 `status` 恢复当前 coding run/);
  assert.match(coding, /不得尝试 `task_mode=coding`/);
  assert.match(coding, /support_orchestration/);
  assert.match(planning, /Planning Writer/);
  assert.match(planning, /Task Planner/);
  assert.match(planning, /Git Operator/);
  assert.match(planning, /support\.research/);
  assert.ok(assets.roles.find((role) => role.id === "planning").delegates.includes("researcher"));
  assert.ok(assets.contract.support_delegations.planning.includes("support.research"));
  const roleNames = ["File Explorer", "Researcher", "Document Maintainer", "Planning Writer", "Task Planner", "Full Stack Coder", "Bug Fixer", "Git Operator", "Environment Operator", "Code Reviewer", "Review Standards", "Review Spec", "Planning", "Coding"];
  for (const role of roleNames) {
    assert.match(assets.routing, new RegExp(`\\*\\*${role}\\*\\*`));
  }
  let routingWithoutBoldRoles = assets.routing;
  for (const role of [...roleNames].sort((left, right) => right.length - left.length)) routingWithoutBoldRoles = routingWithoutBoldRoles.replaceAll(`**${role}**`, "");
  for (const role of roleNames) assert.equal(routingWithoutBoldRoles.includes(role), false, `unbolded role name: ${role}`);
});

test("review roles use enforced broker state while source and Git remain read-only", () => {
  const assets = loadAgentAssets();
  for (const id of ["code-reviewer", "review-standards", "review-spec"]) {
    const role = assets.roles.find((candidate) => candidate.id === id);
    const policy = assets.policies[role.policy];
    assert.equal(policy.filesystem, "read");
    assert.equal(policy.git, "read");
    assert.equal(capabilityMatrix("opencode", role, policy).workflow_state, "enforced");
    assert.deepEqual(capabilityEvidence("opencode", role, policy).workflow_state.evidence, ["isolated MCP workflow broker"]);
    assert.equal(controlMatrix("opencode", role, policy, assets.controls)["workflow-state-only"], "enforced");
  }
});

test("removing an action or required contract field makes asset validation fail", () => {
  const { fixtureConfig, fixtureTemplates, fixtureContract } = fixtureAssets();

  const roles = JSON.parse(readFileSync(resolve(fixtureConfig, "roles.json"), "utf8"));
  roles.roles.find((role) => role.id === "planning").actions = [];
  writeFileSync(resolve(fixtureConfig, "roles.json"), JSON.stringify(roles));
  assert.throws(() => loadAgentAssets(fixtureConfig, fixtureTemplates, fixtureContract), /Action is not assigned/);

  cpSync(resolve(configRoot, "roles.json"), resolve(fixtureConfig, "roles.json"));
  const contract = JSON.parse(readFileSync(fixtureContract, "utf8"));
  delete contract.actions["coding.cleanup"].owner;
  writeFileSync(fixtureContract, JSON.stringify(contract));
  assert.throws(() => loadAgentAssets(fixtureConfig, fixtureTemplates, fixtureContract), /digest is stale|must declare owner/);
});

test("agent validation rejects policy-control conflicts and invalid delegation graphs", () => {
  {
    const { fixtureConfig, fixtureTemplates, fixtureContract } = fixtureAssets();
    const policiesPath = resolve(fixtureConfig, "policies.json");
    const policies = JSON.parse(readFileSync(policiesPath, "utf8"));
    policies.policies.review.workflow_state = "read";
    writeFileSync(policiesPath, JSON.stringify(policies));
    assert.throws(() => loadAgentAssets(fixtureConfig, fixtureTemplates, fixtureContract), /does not satisfy control/);
  }
  {
    const { fixtureConfig, fixtureTemplates, fixtureContract } = fixtureAssets();
    const rolesPath = resolve(fixtureConfig, "roles.json");
    const roles = JSON.parse(readFileSync(rolesPath, "utf8"));
    roles.roles.find((role) => role.id === "review-standards").delegates = ["code-reviewer"];
    writeFileSync(rolesPath, JSON.stringify(roles));
    assert.throws(() => loadAgentAssets(fixtureConfig, fixtureTemplates, fixtureContract), /delegation=|cycle/);
  }
});

test("Planning and Coding use the broker while generated workspace permissions remain read-only", () => {
  const assets = loadAgentAssets();
  for (const id of ["planning", "coding"]) {
    const role = assets.roles.find((candidate) => candidate.id === id);
    assert.ok(role.tools.includes("WorkflowState"), id);
    assert.equal(role.tools.includes("Bash"), false, id);
    assert.equal(assets.policies[role.policy].shell, "none", id);
    assert.match(assets.compiledBodies.get(id), /workflow_state/);
    const fixture = mkdtempSync(resolve(tmpdir(), `driver-permissions-${id}-`));
    const paths = {
      dir: resolve(fixture, "ai-work-flow"),
      codexDir: resolve(fixture, "codex"),
      claudeDir: resolve(fixture, "claude"),
      claudeConfig: resolve(fixture, "claude.json"),
      openCodeDir: resolve(fixture, "opencode"),
    };
    for (const path of [paths.dir, paths.codexDir, paths.claudeDir, paths.openCodeDir]) mkdirSync(path, { recursive: true });
    const rendered = Object.fromEntries(["codex", "claude", "opencode"].map((platform) => {
      const entry = planGeneration({ platform, paths, roles: assets.roles, policies: assets.policies, config: assets.defaults, bodies: assets.compiledBodies })
        .find((candidate) => candidate.type === "write" && candidate.path.includes(`/agents/${id}.`));
      return [platform, entry.contents];
    }));
    assert.match(rendered.codex, /sandbox_mode = "read-only"/);
    assert.match(rendered.claude, /permissionMode: "plan"/);
    assert.match(rendered.claude, /mcp__ai-work-flow__workflow_state/);
    assert.match(rendered.opencode, /"bash":"deny"/);
    assert.match(rendered.opencode, /"ai-work-flow_workflow_state":"allow"/);
  }
});

test("all platform configurations register the installed workflow broker", () => {
  const assets = loadAgentAssets();
  const fixture = mkdtempSync(resolve(tmpdir(), "broker-config-"));
  const paths = {
    dir: resolve(fixture, "ai-work-flow"),
    codexDir: resolve(fixture, "codex"),
    claudeDir: resolve(fixture, "claude"),
    claudeConfig: resolve(fixture, "claude.json"),
    openCodeDir: resolve(fixture, "opencode"),
  };
  for (const path of [paths.dir, paths.codexDir, paths.claudeDir, paths.openCodeDir]) mkdirSync(path, { recursive: true });
  const expected = resolve(paths.dir, "execution-runtime", "workflow-broker.mjs");
  for (const platform of ["codex", "claude", "opencode"]) {
    const plan = planGeneration({ platform, paths, roles: assets.roles, policies: assets.policies, config: assets.defaults, bodies: assets.compiledBodies });
    const config = plan.find((entry) => entry.type === "write" && [resolve(paths.codexDir, "config.toml"), paths.claudeConfig, resolve(paths.openCodeDir, "opencode.json")].includes(entry.path));
    assert.ok(config, platform);
    assert.match(config.contents, /ai-work-flow/);
    assert.ok(config.contents.includes(expected), platform);
  }
});

test("broker configuration preserves unrelated entries, rejects collisions, and is idempotent", () => {
  const assets = loadAgentAssets();
  const fixture = mkdtempSync(resolve(tmpdir(), "broker-preserve-"));
  const paths = {
    dir: resolve(fixture, "ai-work-flow"),
    codexDir: resolve(fixture, "codex"),
    claudeDir: resolve(fixture, "claude"),
    claudeConfig: resolve(fixture, "claude.json"),
    openCodeDir: resolve(fixture, "opencode"),
  };
  for (const path of [paths.dir, paths.codexDir, paths.claudeDir, paths.openCodeDir]) mkdirSync(path, { recursive: true });
  const configPaths = {
    codex: resolve(paths.codexDir, "config.toml"),
    claude: paths.claudeConfig,
    opencode: resolve(paths.openCodeDir, "opencode.json"),
  };
  writeFileSync(configPaths.codex, "[mcp_servers.user-server]\ncommand = \"user\"\n");
  writeFileSync(configPaths.claude, JSON.stringify({ keep: true, mcpServers: { "user-server": { command: "user" } } }));
  writeFileSync(configPaths.opencode, JSON.stringify({ keep: true, mcp: { "user-server": { type: "remote", url: "https://example.test" } } }));

  const generated = {};
  for (const platform of ["codex", "claude", "opencode"]) {
    const plan = planGeneration({ platform, paths, roles: assets.roles, policies: assets.policies, config: assets.defaults, bodies: assets.compiledBodies });
    generated[platform] = plan.find((entry) => entry.path === configPaths[platform]).contents;
    assert.match(generated[platform], /user-server/);
    writeFileSync(configPaths[platform], generated[platform]);
    const repeated = planGeneration({ platform, paths, roles: assets.roles, policies: assets.policies, config: assets.defaults, bodies: assets.compiledBodies });
    assert.equal(repeated.some((entry) => entry.path === configPaths[platform]), false, platform);
  }

  writeFileSync(configPaths.codex, "[mcp_servers.ai-work-flow]\ncommand = \"user\"\n");
  assert.throws(() => planGeneration({ platform: "codex", paths, roles: assets.roles, policies: assets.policies, config: assets.defaults, bodies: assets.compiledBodies }), /Unmanaged/);
  const reversedMarkers = "# ai-work-flow:workflow-broker:end\n[user]\nvalue = \"keep\"\n# ai-work-flow:workflow-broker:begin\n";
  writeFileSync(configPaths.codex, reversedMarkers);
  assert.throws(() => planGeneration({ platform: "codex", paths, roles: assets.roles, policies: assets.policies, config: assets.defaults, bodies: assets.compiledBodies }), /Cannot safely update workflow broker block/);
  assert.equal(readFileSync(configPaths.codex, "utf8"), reversedMarkers);
  writeFileSync(configPaths.claude, JSON.stringify({ mcpServers: { "ai-work-flow": { command: "user" } } }));
  assert.throws(() => planGeneration({ platform: "claude", paths, roles: assets.roles, policies: assets.policies, config: assets.defaults, bodies: assets.compiledBodies }), /Unmanaged/);
  writeFileSync(configPaths.opencode, JSON.stringify({ mcp: { "ai-work-flow": { type: "local", command: ["user"] } } }));
  assert.throws(() => planGeneration({ platform: "opencode", paths, roles: assets.roles, policies: assets.policies, config: assets.defaults, bodies: assets.compiledBodies }), /Unmanaged/);
});

test("navigation runtime action is read-only and implementation maintenance stays with Full Stack Coder", () => {
  const assets = loadAgentAssets();
  assert.equal(assets.contract.actions["navigation.locate"].owner, "file-explorer");
  assert.equal(Object.hasOwn(assets.contract.actions, ["navigation.locate", "maintain"].join("_or_")), false);
  assert.ok(assets.roles.find((role) => role.id === "full-stack-coder").actions.includes("coding.implement"));
});

test("skill metadata deterministically owns all five Skills and generated OpenAI YAML", () => {
  const assets = loadSkillAssets();
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  assert.equal(assets.skills.length, 5);
  for (const skill of assets.skills) {
    assert.ok(skill.short_description.length >= 25 && skill.short_description.length <= 64, skill.name);
    assert.match(skill.default_prompt, new RegExp(`\\$${skill.name}`));
    assert.equal(contract.actions[skill.runtime_action].owner, skill.owner);
    assert.equal(readFileSync(resolve(assets.skillsRoot, skill.name, "agents/openai.yaml"), "utf8"), renderSkillOpenAiYaml(skill));
    const body = readFileSync(resolve(assets.skillsRoot, skill.name, "SKILL.md"), "utf8");
    assert.doesNotMatch(body.slice(body.indexOf("---", 4) + 3), /触发场景/);
  }
});

test("every action I/O contract is compiled and multi-action roles keep explicit branches", () => {
  const assets = loadAgentAssets();
  for (const [id, action] of Object.entries(assets.contract.actions)) {
    const prompt = assets.compiledBodies.get(action.owner);
    const io = assets.contract.io_contracts[action.io_contract];
    assert.match(prompt, new RegExp(id.replaceAll(".", "\\.")), id);
    for (const field of io.input_contract.required_fields) assert.ok(prompt.includes(field), `${id}: ${field}`);
    for (const result of Object.values(io.result_contracts)) for (const field of result.required_fields) assert.ok(prompt.includes(field), `${id}: ${field}`);
  }
  assert.match(assets.compiledBodies.get("full-stack-coder"), /`coding\.implement`[\s\S]*`project\.initialize`/);
  assert.match(assets.compiledBodies.get("git-operator"), /prepare：[\s\S]*commit：[\s\S]*review prepare：[\s\S]*resync：[\s\S]*integrate：[\s\S]*cleanup：/);
  assert.match(assets.compiledBodies.get("planning-writer"), /`planning\.write_spec`[\s\S]*`planning\.write_plan`/);
  assert.match(assets.compiledBodies.get("file-explorer"), /`planning\.discover`[\s\S]*`navigation\.locate`/);
});

test("all platform Skill allowlists are derived only from skills.json ownership", () => {
  const assets = loadAgentAssets();
  const fixture = mkdtempSync(resolve(tmpdir(), "skill-allowlists-"));
  const paths = {
    dir: resolve(fixture, "ai-work-flow"), codexDir: resolve(fixture, "codex"), claudeDir: resolve(fixture, "claude"),
    claudeConfig: resolve(fixture, "claude.json"), openCodeDir: resolve(fixture, "opencode"),
  };
  for (const path of [paths.dir, paths.codexDir, paths.claudeDir, paths.openCodeDir]) mkdirSync(path, { recursive: true });
  const frontmatter = (source) => parseYaml(source.slice(4, source.indexOf("\n---", 4)));
  for (const role of assets.roles) {
    const policy = assets.policies[role.policy];
    for (const skill of assets.skills) {
      assert.equal(evaluateOpenCodePermission(role, policy, "skill", skill.name), skill.owner === role.id ? "allow" : "deny", `${role.id}/${skill.name}`);
    }
    const generated = Object.fromEntries(["codex", "claude", "opencode"].map((platform) => {
      const target = resolve(paths[platform === "opencode" ? "openCodeDir" : `${platform}Dir`], "agents", `${role.id}.${platform === "codex" ? "toml" : "md"}`);
      const entry = planGeneration({ platform, paths, roles: assets.roles, policies: assets.policies, config: assets.defaults, bodies: assets.compiledBodies }).find((step) => step.path === target);
      return [platform, entry.contents];
    }));
    const codex = TOML.parse(generated.codex);
    const codexSkills = Object.fromEntries(codex.skills.config.map((entry) => [entry.path.split("/").at(-2), entry.enabled]));
    const claude = frontmatter(generated.claude);
    const opencode = frontmatter(generated.opencode);
    for (const skill of assets.skills) {
      assert.equal(codexSkills[skill.name], skill.owner === role.id, `codex/${role.id}/${skill.name}`);
      assert.equal(opencode.permission.skill?.[skill.name] ?? "deny", skill.owner === role.id ? "allow" : "deny", `opencode/${role.id}/${skill.name}`);
    }
    assert.deepEqual(claude.skills, role.skills, `claude/${role.id}`);
    assert.equal(claude.tools.includes("Skill"), false, `claude/${role.id}`);
    assert.match(assets.compiledBodies.get(role.id), /Skill 所有权：/);
  }
  assert.deepEqual(assets.roles.find((role) => role.id === "git-operator").skills, ["git-commit"]);
  assert.deepEqual(assets.roles.find((role) => role.id === "environment-operator").skills, ["generate-ai-work-flow-agents", "switch-ai-work-flow-env"]);
  assert.deepEqual(assets.roles.find((role) => role.id === "full-stack-coder").skills, ["init-ai-work-flow"]);
});

test("support delegations remain a subset of role delegation permissions", () => {
  const assets = loadAgentAssets();
  for (const [callerOwner, actionIds] of Object.entries(assets.contract.support_delegations)) {
    const caller = assets.roles.find((role) => role.id === callerOwner);
    for (const actionId of actionIds) assert.ok(caller.delegates.includes(assets.contract.actions[actionId].owner), `${callerOwner}/${actionId}`);
  }
});

test("Environment Operator owns maintenance actions without Git or delegation", () => {
  const assets = loadAgentAssets();
  const role = assets.roles.find((candidate) => candidate.id === "environment-operator");
  const policy = assets.policies[role.policy];
  assert.deepEqual(role.actions, ["agents.generate", "env.use"]);
  assert.deepEqual(role.delegates, []);
  assert.equal(policy.git, "none");
  assert.equal(policy.write_scope, "environment");
  assert.equal(assets.defaults.roles[role.id].codex.model, "gpt-5.6-terra");
  assert.equal(assets.defaults.roles[role.id].claude.model, "haiku");
  assert.equal(assets.defaults.roles[role.id].opencode.model, "baibai/gpt-5.6-terra");
});

test("all three platforms render every compiled prompt from the same contract digest", () => {
  const assets = loadAgentAssets();
  const fixture = mkdtempSync(resolve(tmpdir(), "agent-platforms-"));
  const paths = {
    dir: resolve(fixture, "ai-work-flow"),
    codexDir: resolve(fixture, "codex"),
    claudeDir: resolve(fixture, "claude"),
    claudeConfig: resolve(fixture, "claude.json"),
    openCodeDir: resolve(fixture, "opencode"),
  };
  for (const path of [paths.dir, paths.codexDir, paths.claudeDir, paths.openCodeDir]) mkdirSync(path, { recursive: true });
  for (const platform of ["codex", "claude", "opencode"]) {
    const plan = planGeneration({ platform, paths, roles: assets.roles, policies: assets.policies, config: assets.defaults, bodies: assets.compiledBodies });
    const agentWrites = plan.filter((entry) => entry.type === "write" && entry.path.includes("/agents/") && !entry.path.endsWith("AGENTS.md"));
    assert.equal(agentWrites.length, 14, platform);
    for (const entry of agentWrites) assert.match(entry.contents, new RegExp(`contract-digest=${assets.contract.digest}`), entry.path);
  }
});
