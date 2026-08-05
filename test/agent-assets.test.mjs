import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { loadAgentAssets } from "../agent-build/runtime/asset-catalog.mjs";
import { capabilityEvidence, capabilityMatrix, evaluateOpenCodePermission, planGeneration } from "../agent-build/runtime/platform-adapter.mjs";
import { loadSkillAssets } from "../agent-build/runtime/skill-catalog.mjs";

const headings = ["角色结果", "能力与控制", "允许的 Actions 与输入", "执行循环", "完成标准", "决策条件", "结果回执"];
const retiredTool = ["workflow", "state"].join("_");

function generationFixture() {
  const fixture = mkdtempSync(resolve(tmpdir(), "agent-v2-assets-"));
  const paths = {
    dir: resolve(fixture, "ai-work-flow"), codexDir: resolve(fixture, "codex"),
    claudeDir: resolve(fixture, "claude"), claudeConfig: resolve(fixture, "claude.json"), openCodeDir: resolve(fixture, "opencode"),
  };
  for (const path of [paths.dir, paths.codexDir, paths.claudeDir, paths.openCodeDir]) mkdirSync(path, { recursive: true });
  return paths;
}

test("machine contract assigns every action to exactly one of 14 roles", () => {
  const assets = loadAgentAssets();
  assert.equal(assets.roles.length, 14);
  assert.deepEqual(assets.roles.flatMap((role) => role.actions).sort(), Object.keys(assets.contract.actions).sort());
});

test("compiled prompts keep seven sections and contain only v2 workflow names", () => {
  const assets = loadAgentAssets();
  for (const body of assets.compiledBodies.values()) {
    let previous = -1;
    for (const heading of headings) {
      const position = body.indexOf(`## ${heading}`);
      assert.ok(position > previous);
      previous = position;
    }
    assert.equal(body.includes(retiredTool), false);
  }
  const coding = assets.compiledBodies.get("coding");
  assert.match(coding, /coding_start_direct/);
  assert.match(coding, /coding_start_plan/);
  assert.match(coding, /workflow_claim_next/);
  assert.match(coding, /completion_tool/);
  assert.match(coding, /runtime 读取真实 spec、plan 和 tasks/);
});

test("only Planning and Coding receive workflow runtime tools", () => {
  const assets = loadAgentAssets();
  for (const role of assets.roles) {
    assert.equal(role.tools.includes("WorkflowRuntime"), ["coding", "planning"].includes(role.id), role.id);
  }
});

test("Claude and OpenCode allow narrow tools only for primary workflow agents", () => {
  const assets = loadAgentAssets();
  const paths = generationFixture();
  for (const role of assets.roles) {
    const policy = assets.policies[role.policy];
    const expected = ["coding", "planning"].includes(role.id) ? "allow" : "deny";
    assert.equal(evaluateOpenCodePermission(role, policy, "ai-work-flow_workflow_claim_next"), expected, role.id);
  }
  const claude = planGeneration({ platform: "claude", paths, roles: assets.roles, policies: assets.policies, config: assets.defaults, bodies: assets.compiledBodies });
  const coding = claude.find((step) => step.path.endsWith("/coding.md")).contents;
  const fixer = claude.find((step) => step.path.endsWith("/bug-fixer.md")).contents;
  assert.match(coding, /mcp__ai-work-flow__workflow_claim_next/);
  assert.match(coding, /mcp__ai-work-flow__workflow_complete_implementation/);
  assert.doesNotMatch(fixer, /mcp__ai-work-flow__workflow_/);
  assert.equal(JSON.stringify(claude).includes(retiredTool), false);
});

test("workflow runtime capability reports platform enforcement honestly", () => {
  const assets = loadAgentAssets();
  const coding = assets.roles.find((role) => role.id === "coding");
  const fixer = assets.roles.find((role) => role.id === "bug-fixer");
  assert.equal(capabilityMatrix("opencode", coding, assets.policies[coding.policy]).workflow_runtime, "enforced");
  assert.deepEqual(capabilityEvidence("opencode", coding, assets.policies[coding.policy]).workflow_runtime.evidence, ["narrow MCP workflow tool allowlist"]);
  assert.equal(capabilityMatrix("codex", fixer, assets.policies[fixer.policy]).workflow_runtime, "instruction-only");
});

test("maintenance and navigation remain direct managed Skills", () => {
  const skills = loadSkillAssets().skills;
  assert.deepEqual(skills.map((skill) => skill.name).sort(), [
    "generate-ai-work-flow-agents", "git-commit", "init-ai-work-flow", "project-code-navigation", "switch-ai-work-flow-env",
  ]);
  const assets = loadAgentAssets();
  assert.deepEqual(assets.roles.find((role) => role.id === "environment-operator").skills.sort(), ["generate-ai-work-flow-agents", "switch-ai-work-flow-env"]);
});

test("all three platforms register the same broker without exposing the retired tool name", () => {
  const assets = loadAgentAssets();
  const paths = generationFixture();
  for (const platform of ["codex", "claude", "opencode"]) {
    const plan = planGeneration({ platform, paths, roles: assets.roles, policies: assets.policies, config: assets.defaults, bodies: assets.compiledBodies });
    assert.ok(plan.some((step) => step.path.includes(platform === "opencode" ? "opencode" : platform)));
    assert.equal(JSON.stringify(plan).includes(retiredTool), false);
  }
});

test("generate restores the managed routing file", () => {
  const fixture = mkdtempSync(resolve(tmpdir(), "agent-v2-routing-"));
  const home = resolve(fixture, "home");
  const configHome = resolve(fixture, "config");
  mkdirSync(home, { recursive: true });
  mkdirSync(configHome, { recursive: true });
  const environment = { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome };
  const options = { cwd: resolve(import.meta.dirname, ".."), env: environment, stdio: "ignore" };
  execFileSync(process.execPath, ["agent-build/install.mjs", "init"], options);
  const routing = resolve(configHome, "ai-work-flow", "routing.md");
  rmSync(routing);
  execFileSync(process.execPath, ["agent-build/install.mjs", "generate", "--platform", "codex"], options);
  assert.equal(readFileSync(routing, "utf8"), loadAgentAssets().routing);
  rmSync(routing);
  execFileSync(process.execPath, ["agent-build/install.mjs", "generate", "--platform", "codex"], options);
  assert.equal(readFileSync(routing, "utf8"), loadAgentAssets().routing);
});
