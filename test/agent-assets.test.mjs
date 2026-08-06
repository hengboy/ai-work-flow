import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  loadAgentAssets,
  MAX_COMPILED_PROMPT_CHARACTERS,
  MAX_COMPILED_PROMPTS_CHARACTERS,
} from "../agent-build/runtime/asset-catalog.mjs";
import { evaluateOpenCodePermission, planGeneration } from "../agent-build/runtime/platform-adapter.mjs";
import { loadSkillAssets } from "../agent-build/runtime/skill-catalog.mjs";

const headings = ["角色结果", "能力与控制", "允许的 Actions 与输入", "执行循环", "完成标准", "决策条件", "结果返回"];
const forbiddenPromptTerms = /\b(?:MCP|CLI|run|lease|completion|resume)\b|artifact ref|_ref/i;

function generationFixture() {
  const fixture = mkdtempSync(resolve(tmpdir(), "agent-assets-"));
  const paths = {
    dir: resolve(fixture, "ai-work-flow"), codexDir: resolve(fixture, "codex"),
    claudeDir: resolve(fixture, "claude"), claudeConfig: resolve(fixture, "claude.json"), openCodeDir: resolve(fixture, "opencode"),
  };
  for (const path of [paths.dir, paths.codexDir, paths.claudeDir, paths.openCodeDir]) mkdirSync(path, { recursive: true });
  return paths;
}

function generation(platform, paths, assets = loadAgentAssets()) {
  return planGeneration({ platform, paths, roles: assets.roles, policies: assets.policies, config: assets.defaults, bodies: assets.compiledBodies });
}

function promptFixture() {
  const root = mkdtempSync(resolve(tmpdir(), "agent-prompts-"));
  const templates = resolve(root, "templates");
  mkdirSync(templates);
  for (const name of readdirSync(resolve(import.meta.dirname, "..", "agent-build", "templates"))) {
    writeFileSync(resolve(templates, name), readFileSync(resolve(import.meta.dirname, "..", "agent-build", "templates", name), "utf8"));
  }
  return { root, templates };
}

function extendPrompt(templates, role, count) {
  const path = resolve(templates, `${role}.md`);
  writeFileSync(path, `${readFileSync(path, "utf8").trimEnd()}${"x".repeat(count)}`);
}

test("machine contract assigns every action to exactly one of 14 roles", () => {
  const assets = loadAgentAssets();
  assert.equal(assets.roles.length, 14);
  assert.deepEqual(assets.roles.flatMap((role) => role.actions).sort(), Object.keys(assets.contract.actions).sort());
});

test("compiled prompts use seven sections and no persistent workflow vocabulary", () => {
  const assets = loadAgentAssets();
  for (const [role, body] of assets.compiledBodies) {
    let previous = -1;
    for (const heading of headings) {
      const position = body.indexOf(`## ${heading}`);
      assert.ok(position > previous, `${role}: ${heading}`);
      previous = position;
    }
    assert.doesNotMatch(body, forbiddenPromptTerms, role);
  }
  assert.match(assets.compiledBodies.get("planning"), /discover → confirm → write_spec → write_plan/);
  assert.match(assets.compiledBodies.get("planning"), /planning_context=\{context_id,plan_id.*context_id=source_context_id metadata value; independent from plan_id/s);
  assert.match(assets.compiledBodies.get("planning"), /`task_mode` 是必选的用户决定/);
  assert.match(assets.compiledBodies.get("planning"), /`single` 只生成 spec\/plan、不生成 tasks，`split` 还会生成/);
  assert.match(assets.compiledBodies.get("planning"), /不得根据复杂度、文件数量、工件内容或代理偏好代替用户选择/);
  assert.match(assets.compiledBodies.get("planning"), /task_mode_selection=\{selected,confirmed_by:"user",user_response\}/);
  assert.match(assets.compiledBodies.get("planning"), /`planning\.write_\*` 输入的 `task_mode` 必须逐字等于 `planning_context\.task_mode`/);
  assert.match(assets.compiledBodies.get("planning-writer"), /source_context_id.*planning_context\.context_id.*不得从 `plan_id` 推断/);
  assert.match(assets.compiledBodies.get("planning-writer"), /计划元数据的 `task_mode` 必须逐字等于 `input\.task_mode`，不得默认 `single`/);
  assert.match(assets.compiledBodies.get("task-planner"), /`input\.task_mode` 与 plan 元数据的 `task_mode` 逐字一致且都为 `split`/);
  assert.match(assets.compiledBodies.get("task-planner"), /可并行 task 的 scope 必须明确互斥/);
  assert.match(assets.compiledBodies.get("task-planner"), /write_scope_mode: `exhaustive`/);
  assert.match(assets.compiledBodies.get("coding"), /当前会话/);
  assert.match(assets.compiledBodies.get("code-reviewer"), /同一完整对象/);
  assert.match(assets.compiledBodies.get("full-stack-coder"), /\*\*File Explorer\*\*/);
  assert.match(assets.compiledBodies.get("full-stack-coder"), /`TaskResult`/);
  assert.match(assets.compiledBodies.get("coding"), /changed_paths:string\[\]/);
  assert.match(assets.compiledBodies.get("coding"), /`single` 只推进一条 action 链/);
  assert.match(assets.compiledBodies.get("coding"), /旧格式.*保持串行/);
  assert.match(assets.compiledBodies.get("coding"), /每个 task 恰好委派一个独立 \*\*Full Stack Coder\*\* 执行 `coding\.implement_task`/);
  assert.match(assets.compiledBodies.get("coding"), /同一 ready batch 可并行调用/);
  assert.match(assets.compiledBodies.get("coding"), /commit、review、integrate、cleanup 仍按 task 串行推进/);
  assert.match(assets.compiledBodies.get("full-stack-coder"), /全部 PathChange 均在 scope 内/);
  assert.match(assets.compiledBodies.get("researcher"), /checks:array/);
  assert.match(assets.compiledBodies.get("coding"), /可解析 JSON 对象/);
  assert.match(assets.compiledBodies.get("researcher"), /可解析的 JSON `TaskResult`/);
  assert.match(assets.compiledBodies.get("coding"), /`TaskResult` 使用 2 个空格缩进的多行 JSON/);
  assert.match(assets.compiledBodies.get("researcher"), /`TaskResult` 对象，并使用 2 个空格缩进的多行格式/);
  assert.match(assets.compiledBodies.get("coding"), /review_mode=skipped_small_change/);
  assert.match(assets.compiledBodies.get("coding"), /未执行 Standards\/Spec 双轴审查/);
  assert.match(assets.compiledBodies.get("git-operator"), /最多 2 个被修改的文本文件/);
  assert.match(assets.compiledBodies.get("git-operator"), /增删总和不超过 50/);
  assert.match(assets.compiledBodies.get("git-operator"), /failed\|indeterminate/);
  assert.match(assets.compiledBodies.get("git-operator"), /skipped_small_change.*禁止携带伪造的 `review_result`/);
  assert.match(assets.compiledBodies.get("git-operator"), /`ai-work-flow\/<plan_id>`.*`<repository>\/\.worktrees\/<plan_id>`/);
  assert.match(assets.compiledBodies.get("git-operator"), /`ai-work-flow\/<plan_id>\/<task_id>`.*`<repository>\/\.worktrees\/<plan_id>--<task_id>`/);
  assert.match(assets.compiledBodies.get("code-reviewer"), /只能在 `review_mode=dual_axis` 时被调用/);
  const gitOperator = assets.compiledBodies.get("git-operator");
  for (const literal of [
    "direct_request_origin", "initial_review_stage", "full_review_not_requested", "modified_text_files_only", "changed_file_limit",
    "changed_line_limit", "no_sensitive_changes", "triage_scope_match", "automated_verification_passed", "public_api_contract", "data_schema",
    "permissions_security", "dependencies", "build_release", "cross_module_behavior", "persistence",
  ]) assert.match(gitOperator, new RegExp(literal));
  assert.match(gitOperator, /本次变更符合低风险小改动快速通道，未执行 Standards\/Spec 双轴审查；已完成聚焦自动化验证和 Git 状态校验。/);
  assert.match(gitOperator, /review_basis/);
  assert.match(gitOperator, /review_packet.*review_disposition.*feature\/review\/packet SHA 一致/s);
});

test("compiled prompt character limits accept the boundary and reject one character over", (t) => {
  const individual = promptFixture();
  t.after(() => rmSync(individual.root, { recursive: true, force: true }));
  const codingLength = loadAgentAssets().compiledBodies.get("coding").length;
  extendPrompt(individual.templates, "coding", MAX_COMPILED_PROMPT_CHARACTERS - codingLength);
  assert.equal(loadAgentAssets(undefined, individual.templates).compiledBodies.get("coding").length, MAX_COMPILED_PROMPT_CHARACTERS);
  extendPrompt(individual.templates, "coding", 1);
  assert.throws(() => loadAgentAssets(undefined, individual.templates), /Compiled prompt coding exceeds 10000 characters: 10001\./);

  const aggregate = promptFixture();
  t.after(() => rmSync(aggregate.root, { recursive: true, force: true }));
  const initial = loadAgentAssets(undefined, aggregate.templates);
  let remaining = MAX_COMPILED_PROMPTS_CHARACTERS - [...initial.compiledBodies.values()].reduce((sum, prompt) => sum + prompt.length, 0);
  for (const [role, prompt] of initial.compiledBodies) {
    const added = Math.min(remaining, MAX_COMPILED_PROMPT_CHARACTERS - prompt.length);
    extendPrompt(aggregate.templates, role, added);
    remaining -= added;
    if (remaining === 0) break;
  }
  assert.equal(remaining, 0);
  const atLimit = loadAgentAssets(undefined, aggregate.templates);
  assert.equal([...atLimit.compiledBodies.values()].reduce((sum, prompt) => sum + prompt.length, 0), MAX_COMPILED_PROMPTS_CHARACTERS);
  const expandable = [...atLimit.compiledBodies].find(([, prompt]) => prompt.length < MAX_COMPILED_PROMPT_CHARACTERS)[0];
  extendPrompt(aggregate.templates, expandable, 1);
  assert.throws(() => loadAgentAssets(undefined, aggregate.templates), /Compiled prompts exceed 55000 characters: 55001\./);
});

test("Planning and Coding have Task only", () => {
  const assets = loadAgentAssets();
  assert.deepEqual(assets.roles.find((role) => role.id === "planning").tools, ["Task"]);
  assert.deepEqual(assets.roles.find((role) => role.id === "coding").tools, ["Task"]);
  for (const role of assets.roles) assert.equal(role.tools.includes("WorkflowRuntime"), false, role.id);
});

test("all platforms render primary agents without shell or workflow MCP tools", () => {
  const assets = loadAgentAssets();
  const paths = generationFixture();
  const claude = generation("claude", paths, assets);
  const coding = claude.find((step) => step.path.endsWith("/coding.md")).contents;
  assert.match(coding, /tools: \["Task"\]/);
  assert.doesNotMatch(coding, /mcp__ai-work-flow/);
  const codingRole = assets.roles.find((role) => role.id === "coding");
  assert.equal(evaluateOpenCodePermission(codingRole, assets.policies[codingRole.policy], "bash"), "deny");
  assert.equal(evaluateOpenCodePermission(codingRole, assets.policies[codingRole.policy], "read"), "deny");
  assert.equal(evaluateOpenCodePermission(codingRole, assets.policies[codingRole.policy], "task"), "allow");
  for (const platform of ["codex", "claude", "opencode"]) {
    const plan = generation(platform, paths, assets);
    assert.equal(JSON.stringify(plan).includes("ai-work-flow_workflow_"), false, platform);
    assert.equal(JSON.stringify(plan).includes("mcp__ai-work-flow"), false, platform);
  }
});

test("generation removes exact legacy MCP configuration", () => {
  const assets = loadAgentAssets();
  const paths = generationFixture();
  const broker = resolve(paths.dir, "execution-runtime", "workflow-broker.mjs");
  writeFileSync(resolve(paths.codexDir, "config.toml"), `[agents]\nmax_depth = 2\n\n# ai-work-flow:workflow-broker:begin\n[mcp_servers.ai-work-flow]\ncommand = "node"\nargs = [${JSON.stringify(broker)}]\n# ai-work-flow:workflow-broker:end\n`);
  writeFileSync(paths.claudeConfig, `${JSON.stringify({ mcpServers: { "ai-work-flow": { type: "stdio", command: "node", args: [broker] } } })}\n`);
  writeFileSync(resolve(paths.openCodeDir, "opencode.json"), `${JSON.stringify({ mcp: { "ai-work-flow": { type: "local", command: ["node", broker], enabled: true } } })}\n`);
  for (const platform of ["codex", "claude", "opencode"]) {
    const configName = platform === "codex" ? "config.toml" : platform === "claude" ? "claude.json" : "opencode.json";
    const step = generation(platform, paths, assets).find((entry) => entry.path.endsWith(configName));
    assert.ok(step, platform);
    assert.equal(step.contents.includes("ai-work-flow"), false, platform);
  }
});

test("generation rejects modified legacy MCP configuration", () => {
  const assets = loadAgentAssets();
  for (const platform of ["codex", "claude", "opencode"]) {
    const paths = generationFixture();
    if (platform === "codex") writeFileSync(resolve(paths.codexDir, "config.toml"), "[mcp_servers.ai-work-flow]\ncommand = \"custom\"\n");
    if (platform === "claude") writeFileSync(paths.claudeConfig, `${JSON.stringify({ mcpServers: { "ai-work-flow": { command: "custom" } } })}\n`);
    if (platform === "opencode") writeFileSync(resolve(paths.openCodeDir, "opencode.json"), `${JSON.stringify({ mcp: { "ai-work-flow": { command: ["custom"] } } })}\n`);
    assert.throws(() => generation(platform, paths, assets), /Conflicting/, platform);
  }
});

test("maintenance and navigation remain direct managed Skills", () => {
  const skills = loadSkillAssets().skills;
  assert.deepEqual(skills.map((skill) => skill.name).sort(), [
    "generate-ai-work-flow-agents", "git-commit", "init-ai-work-flow", "project-code-navigation", "switch-ai-work-flow-env",
  ]);
});

test("install replaces runtime exactly and only full install removes repository state", () => {
  const fixture = mkdtempSync(resolve(tmpdir(), "agent-install-"));
  const home = resolve(fixture, "home");
  const configHome = resolve(fixture, "config");
  const repository = resolve(fixture, "repository");
  mkdirSync(home, { recursive: true });
  mkdirSync(configHome, { recursive: true });
  mkdirSync(repository, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repository, stdio: "ignore" });
  const state = resolve(repository, ".git", "ai-work-flow");
  mkdirSync(state, { recursive: true });
  writeFileSync(resolve(state, "legacy.json"), "{}\n");
  const environment = { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome };
  const install = resolve(import.meta.dirname, "..", "agent-build", "install.mjs");
  const execute = (args, output = "ignore") => execFileSync(process.execPath, [install, ...args], { cwd: repository, env: environment, encoding: "utf8", stdio: output === "ignore" ? "ignore" : undefined });
  execute(["init"]);
  const dryRun = execute(["--platform", "codex", "--dry-run"], "capture");
  assert.equal(existsSync(state), true);
  assert.match(dryRun, /\.git\/ai-work-flow/);
  execute(["generate", "--platform", "codex"]);
  assert.equal(existsSync(state), true);
  const installedRuntime = resolve(configHome, "ai-work-flow", "execution-runtime");
  mkdirSync(resolve(installedRuntime, "lib"), { recursive: true });
  writeFileSync(resolve(installedRuntime, "lib", "obsolete.mjs"), "old\n");
  execute(["--platform", "codex"]);
  assert.equal(existsSync(state), false);
  assert.deepEqual(readdirSync(installedRuntime).sort(), ["lib", "task-result-schemas.json", "workflow-contract.json"]);
  assert.deepEqual(readdirSync(resolve(installedRuntime, "lib")), ["workflow-contract.mjs"]);
  rmSync(fixture, { recursive: true, force: true });
});
