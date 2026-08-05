import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { loadAgentAssets } from "../agent-build/runtime/asset-catalog.mjs";
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
  assert.match(assets.compiledBodies.get("coding"), /当前会话/);
  assert.match(assets.compiledBodies.get("code-reviewer"), /同一完整对象/);
  assert.match(assets.compiledBodies.get("full-stack-coder"), /\*\*File Explorer\*\*/);
  assert.match(assets.compiledBodies.get("full-stack-coder"), /`TaskResult`/);
  assert.match(assets.compiledBodies.get("coding"), /changed_paths:string\[\]/);
  assert.match(assets.compiledBodies.get("researcher"), /checks:array/);
  assert.match(assets.compiledBodies.get("coding"), /可解析 JSON 对象/);
  assert.match(assets.compiledBodies.get("researcher"), /可解析的 JSON `TaskResult`/);
  assert.match(assets.compiledBodies.get("coding"), /`TaskResult` 使用 2 个空格缩进的多行 JSON/);
  assert.match(assets.compiledBodies.get("researcher"), /`TaskResult` 对象，并使用 2 个空格缩进的多行格式/);
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
