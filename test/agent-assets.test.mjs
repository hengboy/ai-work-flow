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
  assert.match(assets.compiledBodies.get("planning"), /discover → confirm requirements → write_spec → select task mode → write_plan → \(split: preview\/revise\/confirm → sync_plan_tasks → write_tasks/);
  assert.match(assets.compiledBodies.get("planning"), /planning_context=\{context_id,plan_id.*context_id=source_context_id metadata value; independent from plan_id/s);
  assert.match(assets.compiledBodies.get("planning"), /仅尚未解决的真实需求疑问维护递增且跨轮次不重复的 `question_number`/);
  assert.match(assets.compiledBodies.get("planning"), /open_decisions:array<\{question,recommendation\}>/);
  assert.match(assets.compiledBodies.get("file-explorer"), /open_decisions:array<\{question,recommendation\}>/);
  assert.match(assets.compiledBodies.get("planning"), /每次只问一个并以 `问题 <question_number>` 开头，同时给出明确建议及建议原因，存在选项时标明推荐选项/);
  assert.match(assets.compiledBodies.get("planning"), /跨轮次不重复.*中断后从对话或 `decision_history` 最大编号继续/s);
  assert.match(assets.compiledBodies.get("planning"), /完整需求确认、后续 `task_mode` 选择及 task preview 确认或修订均不使用 `问题 <question_number>`，也不递增 `question_number`/);
  assert.match(assets.compiledBodies.get("planning"), /确认完整需求后生成无模式的 `planning_context` 并立即写 spec/);
  assert.match(assets.compiledBodies.get("planning"), /spec 回执未绑定目标和摘要时不得询问模式/);
  assert.match(assets.compiledBodies.get("planning"), /规划工件路径固定为 `.ai-work-flow\/plans\/<plan-id>\/spec.md`、`.ai-work-flow\/plans\/<plan-id>\/plan.md` 和 split 模式下的 `.ai-work-flow\/plans\/<plan-id>\/tasks\/NN-<task-id>.md`/);
  assert.match(assets.compiledBodies.get("planning"), /spec 复验后单独要求选择 `single` 或 `split`；此时 `spec.md` 已生成且不属于模式产物/);
  assert.match(assets.compiledBodies.get("planning"), /`single` 仅生成 `plan.md`，不创建 task 文件；`split` 生成 `plan.md`，并拆分 task，写入前展示完整 task 标题与概要供用户确认/);
  assert.doesNotMatch(assets.compiledBodies.get("planning"), /`single`（仅 spec\/plan）/);
  assert.match(assets.compiledBodies.get("planning"), /task_mode_selection=\{selected,confirmed_by:"user",user_response\}/);
  assert.match(assets.compiledBodies.get("planning"), /`split` 由 \*\*Task Planner\*\* 只读预览全部标题\/概要并请求确认/);
  assert.match(assets.compiledBodies.get("planning"), /反馈原文作为 `revision_feedback`，revision 递增后重新请求确认/);
  assert.doesNotMatch(assets.compiledBodies.get("planning"), /用新编号.*(?:选择|确认)/);
  assert.match(assets.compiledBodies.get("planning"), /task_preview_confirmation=\{confirmed_by:"user",user_response,preview_revision\}/);
  assert.match(assets.compiledBodies.get("planning-writer"), /`planning\.write_spec`：写入 context；`source_context_id` 等于 `context_id`，digest 绑定原文/);
  assert.match(assets.compiledBodies.get("planning-writer"), /spec 无模式；plan 回执模式等于输入/);
  assert.match(assets.compiledBodies.get("planning-writer"), /`planning\.write_plan`：绑定 approved spec 原始 SHA-256；模式等于输入/);
  assert.match(assets.compiledBodies.get("planning-writer"), /`planning\.sync_plan_tasks`.*确认 preview.*`plan_digest` 更新为新 plan SHA-256/s);
  assert.match(assets.compiledBodies.get("planning-writer"), /split plan 与最终 task 集合的数量、ID、顺序、标题和概要一致/);
  assert.match(assets.compiledBodies.get("task-planner"), /`input\.task_mode` 与 plan 元数据必须同为 `split`/);
  assert.match(assets.compiledBodies.get("task-planner"), /`planning\.preview_tasks`.*不得创建、修改或删除 task 文件/s);
  assert.match(assets.compiledBodies.get("task-planner"), /以可独立交付和验收的职责边界确定合理颗粒度.*不以 task 数量为目标.*不按单个文件、代码层或实施步骤机械拆分/);
  assert.match(assets.compiledBodies.get("task-planner"), /`planning\.revise_task_preview`.*revision 严格增加 1/s);
  assert.match(assets.compiledBodies.get("task-planner"), /`planning\.write_tasks`.*用户确认的当前 revision.*逐字写 preview ID\/order\/title\/summary.*写入后.*`task_artifact_manifest`/s);
  assert.match(assets.compiledBodies.get("task-planner"), /`files\[\]\.sha256`.*对应 task Markdown 文件的原始字节.*SHA-256.*`source_plan_digest` 只能绑定 `plan\.md`，不得代替 task digest.*`planning\.verify_tasks`.*逐文件重算.*拒绝.*混用/s);
  assert.match(assets.compiledBodies.get("task-planner"), /实施清单、验收标准和验证步骤映射为所需写路径.*全部新增、修改、删除和移动源\/目标.*测试\/fixture\/snapshot.*配置\/schema.*生成物.*导航索引和 MEMORY/s);
  assert.match(assets.compiledBodies.get("task-planner"), /已知文件写精确文件.*最窄责任目录前缀.*不得用仓库根或无关上层目录掩盖遗漏.*任一路径无法由 plan 和仓库事实确认时返回 `needs_decision`.*不得省略后仍标记 `exhaustive`/s);
  assert.match(assets.compiledBodies.get("task-planner"), /write_scope_mode: `exhaustive`/);
  assert.doesNotMatch(assets.compiledBodies.get("file-explorer"), /planning\.verify_tasks|task_artifact_manifest/);
  assert.match(assets.compiledBodies.get("git-operator"), /planning task verify.*`shasum -a 256 -- <path>`.*`sha256sum -- <path>`.*Task Planner.*`task_artifact_manifest`.*不执行 Git mutation/s);
  assert.match(assets.compiledBodies.get("coding"), /当前会话/);
  assert.match(assets.compiledBodies.get("code-reviewer"), /同一完整对象/);
  assert.match(assets.compiledBodies.get("full-stack-coder"), /\*\*File Explorer\*\*/);
  assert.match(assets.compiledBodies.get("full-stack-coder"), /`TaskResult`/);
  assert.match(assets.compiledBodies.get("coding"), /changed_paths:string\[\]/);
  assert.match(assets.compiledBodies.get("coding"), /`single` 保持现有 action 链/);
  assert.match(assets.compiledBodies.get("coding"), /`split` 只执行一次不含 `task_id` 的 `coding\.prepare`/);
  assert.match(assets.compiledBodies.get("coding"), /`blocked_by` 已完成上述整合、勾选和 cleanup/);
  assert.match(assets.compiledBodies.get("coding"), /task_path.*task_digest.*复选框.*完成提交/s);
  assert.match(assets.compiledBodies.get("coding"), /每个 task 恰好委派一个独立 \*\*Full Stack Coder\*\*/);
  assert.match(assets.compiledBodies.get("coding"), /Git actions 串行/);
  assert.match(assets.compiledBodies.get("coding"), /`coding\.validate_plan`.*完整无重复 IDs.*slices 覆盖全部 task/s);
  assert.match(assets.compiledBodies.get("coding"), /连续 integration\/cleanup 证据.*verification 全 passed/s);
  assert.match(assets.compiledBodies.get("coding"), /权威任务集合是 `tasks\/NN-\*\.md`.*不得从 plan 的步骤数、候选文件或“建议任务”等叙述推断另一套 task 数量/s);
  assert.match(assets.compiledBodies.get("coding"), /不得要求 contract 未声明的“实施基线元数据”/);
  assert.match(assets.compiledBodies.get("coding"), /task 不审查/);
  assert.match(assets.compiledBodies.get("coding"), /`coding\.implement_task`[\s\S]*`\{result:"completed",summary,task_id,head_sha,changed_paths,change_evidence,write_scope\}`/);
  for (const action of ["prepare_task", "implement_task", "commit_task", "integrate_task", "cleanup_task"]) {
    assert.match(assets.compiledBodies.get("coding"), new RegExp(`coding\\.${action}`));
  }
  assert.match(assets.compiledBodies.get("coding"), /支持委派：\*\*Researcher\*\*[\s\S]*report_path,citation_urls,changed_paths,checks/);
  assert.match(assets.compiledBodies.get("full-stack-coder"), /`planning\.discover`/);
  assert.match(assets.compiledBodies.get("bug-fixer"), /支持委派：\*\*Document Maintainer\*\*/);
  assert.match(assets.compiledBodies.get("code-reviewer"), /支持委派：\*\*Review Standards\*\*[\s\S]*review_axis_result/);
  assert.match(assets.compiledBodies.get("full-stack-coder"), /全部 PathChange 均在 scope 内/);
  assert.match(assets.compiledBodies.get("full-stack-coder"), /连续 integration 链.*verification 只有全部 passed 才可 completed/s);
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
  assert.match(assets.compiledBodies.get("git-operator"), /`ai-work-flow\/<plan_id>\/integration`.*`<repository>\/\.worktrees\/<plan_id>`/);
  assert.match(assets.compiledBodies.get("git-operator"), /`ai-work-flow\/<plan_id>\/tasks\/<task_id>`.*`<repository>\/\.worktrees\/<plan_id>--<task_id>`/);
  assert.match(assets.compiledBodies.get("git-operator"), /git merge --no-ff.*git merge --abort/s);
  assert.match(assets.compiledBodies.get("git-operator"), /`- \[ \]`.*`- \[x\]`.*task_completion_sha=resulting_plan_sha/s);
  assert.match(assets.compiledBodies.get("git-operator"), /merge_aborted=true.*clean_state\.clean=true/s);
  assert.match(assets.compiledBodies.get("git-operator"), /task SHA 是 resulting plan SHA 祖先/);
  assert.match(assets.compiledBodies.get("git-operator"), /worktree_removed.*branch_removed.*均为 true/s);
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
  assert.throws(() => loadAgentAssets(undefined, individual.templates), /Compiled prompt coding exceeds 14000 characters: 14001\./);

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
  assert.throws(() => loadAgentAssets(undefined, aggregate.templates), /Compiled prompts exceed 65000 characters: 65001\./);
});

test("primary agents have Task only and Task Planner owns the complete split lifecycle", () => {
  const assets = loadAgentAssets();
  const planning = assets.roles.find((role) => role.id === "planning");
  assert.deepEqual(planning.tools, ["Task"]);
  const coding = assets.roles.find((role) => role.id === "coding");
  assert.deepEqual(coding.tools, ["Task"]);
  for (const role of [planning, coding]) {
    assert.equal(role.controls.includes("workflow-decision-visibility"), true, role.id);
    assert.match(assets.compiledBodies.get(role.id), /每个流程决策点[\s\S]*`状态`[\s\S]*`决策`[\s\S]*`委派`[\s\S]*`下一步`/);
    assert.match(assets.compiledBodies.get(role.id), /四项分行用 `\*\*名称\*\*：<内容>`；只加粗名称，冒号和内容不得加粗/);
  }
  for (const role of assets.roles.filter((role) => role.kind !== "primary")) {
    assert.equal(role.controls.includes("workflow-decision-visibility"), false, role.id);
  }
  assert.equal(coding.delegates.includes("planning-writer"), false);
  assert.equal(assets.contract.workflows.coding.orchestrator, "coding");
  assert.equal(assets.contract.workflows.coding_task.orchestrator, "coding");
  const taskPlanner = assets.roles.find((role) => role.id === "task-planner");
  assert.deepEqual(taskPlanner.actions, ["planning.preview_tasks", "planning.revise_task_preview", "planning.write_tasks"]);
  assert.deepEqual(taskPlanner.tools, ["Read", "Edit", "Write", "Bash"]);
  assert.equal(assets.policies[taskPlanner.policy].write_scope, "tasks");
  for (const role of assets.roles) assert.equal(role.tools.includes("WorkflowRuntime"), false, role.id);
});

test("File Explorer only discovers facts and Git Operator verifies task manifests", () => {
  const assets = loadAgentAssets();
  const fileExplorer = assets.roles.find((role) => role.id === "file-explorer");
  const gitOperator = assets.roles.find((role) => role.id === "git-operator");
  const taskPath = ".ai-work-flow/plans/example/tasks/01-first.md";
  assert.deepEqual(fileExplorer.actions, ["planning.discover"]);
  assert.equal(gitOperator.actions.includes("planning.verify_tasks"), true);
  assert.equal(assets.contract.actions["planning.verify_tasks"].owner, "git-operator");
  assert.equal(evaluateOpenCodePermission(fileExplorer, assets.policies[fileExplorer.policy], "bash", `shasum -a 256 -- ${taskPath}`), "deny");
  assert.equal(evaluateOpenCodePermission(gitOperator, assets.policies[gitOperator.policy], "bash", `shasum -a 256 -- ${taskPath}`), "allow");
});

test("Task Planner alone can edit confirmed task artifacts", () => {
  const assets = loadAgentAssets();
  const taskPath = ".ai-work-flow/plans/example/tasks/01-first.md";
  const taskPlanner = assets.roles.find((role) => role.id === "task-planner");
  const planningWriter = assets.roles.find((role) => role.id === "planning-writer");
  const fileExplorer = assets.roles.find((role) => role.id === "file-explorer");
  assert.equal(evaluateOpenCodePermission(taskPlanner, assets.policies[taskPlanner.policy], "edit", taskPath), "allow");
  assert.equal(evaluateOpenCodePermission(planningWriter, assets.policies[planningWriter.policy], "edit", taskPath), "deny");
  assert.equal(evaluateOpenCodePermission(fileExplorer, assets.policies[fileExplorer.policy], "edit", taskPath), "deny");
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
