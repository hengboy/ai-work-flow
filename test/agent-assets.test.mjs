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

test("artifact-producing agents return content for runtime completion", () => {
  const assets = loadAgentAssets();
  const expected = {
    planning: ["planning_context", "runtime 负责 receipt、上游绑定与 artifact 创建"],
    "git-operator": ["review_packet", "即使没有 workflow CLI 也不得省略或改为失败"],
    "bug-fixer": ["change_evidence", "canonical artifact 与 ref 由 runtime completion 创建"],
    "full-stack-coder": ["change_evidence", "canonical artifact 与 ref 由 runtime completion 创建"],
    "code-reviewer": ["review_result", "canonical artifact 与 ref 由 runtime completion 创建"],
  };
  for (const [role, phrases] of Object.entries(expected)) {
    const prompt = assets.compiledBodies.get(role);
    for (const phrase of phrases) assert.match(prompt, new RegExp(phrase), `${role}: ${phrase}`);
    assert.match(prompt, /直接返回完整 JSON 内容，不返回 `\*_ref`/);
    assert.match(prompt, /不得自行创建 workflow artifact 文件或调用 workflow CLI\/状态工具/);
  }
  assert.doesNotMatch(assets.compiledBodies.get("git-operator"), /ReviewPacket 仅可通过 workflow CLI/);
  assert.doesNotMatch(assets.compiledBodies.get("bug-fixer"), /change_evidence ref/);
  assert.doesNotMatch(assets.compiledBodies.get("full-stack-coder"), /change_evidence ref/);
  assert.doesNotMatch(assets.compiledBodies.get("code-reviewer"), /review_result ref/);
});

test("support agents consume artifact content without inventing refs", () => {
  const assets = loadAgentAssets();
  for (const role of assets.roles.filter((entry) => entry.actions.length === 0)) {
    const prompt = assets.compiledBodies.get(role.id);
    assert.match(prompt, /不得读写 workflow 状态、创建 workflow artifact 或虚构 artifact ref/, role.id);
  }
  for (const role of ["review-standards", "review-spec"]) {
    const prompt = assets.compiledBodies.get(role);
    assert.match(prompt, /验证 `review_packet` 完整内容及其冻结身份/);
    assert.match(prompt, /TaskResult=\{result,summary,review_axis_result\}/);
    assert.match(prompt, /不得把 result\/summary 写入 `review_axis_result`/);
    assert.doesNotMatch(prompt, /验证 packet ref/);
  }
  const reviewer = assets.compiledBodies.get("code-reviewer");
  assert.match(reviewer, /必须实际以同一 `review_packet`.*调度 Review Standards 与 Review Spec/);
  assert.match(reviewer, /不得放入子代理的 result\/summary 包装/);
  assert.match(reviewer, /`review_result=\{axis_results,verdict,finding_ids,coverage\}`/);
  assert.match(reviewer, /`finding_ids` 是两轴 blocking `findings` ID 的排序去重结果，不含 advisory/);
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

test("OpenCode File Explorer can inspect external worktrees read-only", () => {
  const assets = loadAgentAssets();
  const explorer = assets.roles.find((role) => role.id === "file-explorer");
  const policy = assets.policies[explorer.policy];
  assert.equal(evaluateOpenCodePermission(explorer, policy, "external_directory"), "allow");
  assert.equal(evaluateOpenCodePermission(explorer, policy, "read"), "allow");
  assert.equal(evaluateOpenCodePermission(explorer, policy, "edit"), "deny");
  assert.equal(evaluateOpenCodePermission(explorer, policy, "bash", "rg --files"), "allow");
  assert.equal(evaluateOpenCodePermission(explorer, policy, "bash", "git status --short"), "allow");
  assert.equal(evaluateOpenCodePermission(explorer, policy, "bash", "rm README.md"), "deny");
  assert.equal(evaluateOpenCodePermission(explorer, policy, "bash", "git status && rm README.md"), "deny");
});

test("OpenCode worktree actors can access legacy external worktrees", () => {
  const assets = loadAgentAssets();
  const allowed = new Set(["file-explorer", "full-stack-coder", "bug-fixer", "git-operator", "code-reviewer", "review-standards", "review-spec"]);
  for (const role of assets.roles) {
    const policy = assets.policies[role.policy];
    assert.equal(evaluateOpenCodePermission(role, policy, "external_directory"), allowed.has(role.id) ? "allow" : "deny", role.id);
  }
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
