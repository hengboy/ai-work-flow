import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { loadAgentAssets } from "../agent-build/runtime/asset-catalog.mjs";
import { capabilityMatrix, controlMatrix, planGeneration } from "../agent-build/runtime/platform-adapter.mjs";
import { loadSkillAssets, renderSkillOpenAiYaml } from "../agent-build/runtime/skill-catalog.mjs";

const root = resolve(import.meta.dirname, "..");
const configRoot = resolve(root, "agent-build/config");
const templatesRoot = resolve(root, "agent-build/templates");
const contractPath = resolve(root, "execution-runtime/workflow-contract.json");
const headings = ["角色结果", "能力与控制", "允许的 Actions 与输入", "执行循环", "完成标准", "决策条件", "结果回执"];

test("machine contract assigns every action to exactly one of 13 roles", () => {
  const assets = loadAgentAssets();
  assert.equal(assets.roles.length, 13);
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
    assert.doesNotMatch(prompt, /protocol_recovery_attempt|prepare envelope|directory_bundle|fixed_point|runtime_provenance/);
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

test("review roles expose instruction-only workflow state while source and Git remain read-only", () => {
  const assets = loadAgentAssets();
  for (const id of ["code-reviewer", "review-standards", "review-spec"]) {
    const role = assets.roles.find((candidate) => candidate.id === id);
    const policy = assets.policies[role.policy];
    assert.equal(policy.filesystem, "read");
    assert.equal(policy.git, "read");
    assert.equal(capabilityMatrix("opencode", role, policy).workflow_state, "instruction-only");
    assert.equal(controlMatrix("opencode", role, policy, assets.controls)["workflow-state-only"], "instruction-only");
  }
});

test("removing an action or required contract field makes asset validation fail", () => {
  const fixture = mkdtempSync(resolve(tmpdir(), "agent-assets-"));
  const fixtureConfig = resolve(fixture, "config");
  const fixtureTemplates = resolve(fixture, "templates");
  const fixtureContract = resolve(fixture, "workflow-contract.json");
  cpSync(configRoot, fixtureConfig, { recursive: true });
  cpSync(templatesRoot, fixtureTemplates, { recursive: true });
  cpSync(contractPath, fixtureContract);

  const roles = JSON.parse(readFileSync(resolve(fixtureConfig, "roles.json"), "utf8"));
  roles.roles.find((role) => role.id === "coding").actions = [];
  writeFileSync(resolve(fixtureConfig, "roles.json"), JSON.stringify(roles));
  assert.throws(() => loadAgentAssets(fixtureConfig, fixtureTemplates, fixtureContract), /Action is not assigned/);

  cpSync(resolve(configRoot, "roles.json"), resolve(fixtureConfig, "roles.json"));
  const contract = JSON.parse(readFileSync(fixtureContract, "utf8"));
  delete contract.actions["coding.cleanup"].owner;
  writeFileSync(fixtureContract, JSON.stringify(contract));
  assert.throws(() => loadAgentAssets(fixtureConfig, fixtureTemplates, fixtureContract), /digest is stale|must declare owner/);
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

test("all three platforms render every compiled prompt from the same contract digest", () => {
  const assets = loadAgentAssets();
  const fixture = mkdtempSync(resolve(tmpdir(), "agent-platforms-"));
  const paths = {
    codexDir: resolve(fixture, "codex"),
    claudeDir: resolve(fixture, "claude"),
    openCodeDir: resolve(fixture, "opencode"),
  };
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  for (const platform of ["codex", "claude", "opencode"]) {
    const plan = planGeneration({ platform, paths, roles: assets.roles, policies: assets.policies, config: assets.defaults, bodies: assets.compiledBodies });
    const agentWrites = plan.filter((entry) => entry.type === "write" && entry.path.includes("/agents/") && !entry.path.endsWith("AGENTS.md"));
    assert.equal(agentWrites.length, 13, platform);
    for (const entry of agentWrites) assert.match(entry.contents, new RegExp(`contract-digest=${assets.contract.digest}`), entry.path);
  }
});
