import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { MARKER_END, MARKER_START, updateManagedMarker } from '../scripts/private/managed-content.mjs';
import { capabilityMatrix } from '../scripts/private/platform-adapter.mjs';
import { applyTransaction, recoverTransaction } from '../scripts/private/transaction.mjs';

const root = resolve(import.meta.dirname, '..');
const installer = resolve(root, 'scripts/install.mjs');
const agentAssets = resolve(root, 'scripts/agent-assets');
const catalog = JSON.parse(readFileSync(resolve(agentAssets, 'roles.json'), 'utf8'));
const policies = JSON.parse(readFileSync(resolve(agentAssets, 'policies.json'), 'utf8')).policies;
const managedSkillDirectories = [
  'generate-ai-work-flow-agents',
  'switch-ai-work-flow-env',
  'project-code-navigation',
  'run-matt-spec-to-completion'
];
const defaultSkillPrompts = new Map([
  ['generate-ai-work-flow-agents', '使用 `$generate-ai-work-flow-agents` 验证全局配置并生成代理。'],
  ['switch-ai-work-flow-env', '使用 `$switch-ai-work-flow-env` 切换到指定环境并重新生成代理。'],
  ['project-code-navigation', '使用 `$project-code-navigation` 为当前项目创建或更新 `.ai-work-flow/index/` 代码导航索引。']
]);

function assertPromptLayout(source, name) {
  assert.equal((source.match(/^# [^\n]+$/gm) ?? []).length, 1, `${name} needs one primary title`);
  assert.match(source, /^## 回复格式$/m, `${name} needs a reply format`);
  assert.match(source, /\*\*(?:状态|结论|阻塞|结果|更新|注意|完成|发现|提交结果|严重)：\*\*/, `${name} needs a bold response label`);
  assert.doesNotMatch(source, /^#{1,3} [^\n]+\n(?!\n)/m, `${name} headings need a following blank line`);
}

function codexDeveloperInstructions(source) {
  const encoded = source.match(/^developer_instructions = (.+)$/m)?.[1];
  assert.ok(encoded, 'Codex agent needs developer instructions');
  return JSON.parse(encoded).replaceAll('\\n', '\n');
}

function fixture() {
  return mkdtempSync(resolve(tmpdir(), 'agent-workflow-'));
}

function environment() {
  const base = fixture();
  return {
    base,
    home: resolve(base, 'home'),
    config: resolve(base, 'config'),
    project: resolve(base, 'project')
  };
}

function env(paths) {
  return { ...process.env, HOME: paths.home, XDG_CONFIG_HOME: paths.config };
}

function run(paths, ...args) {
  mkdirSync(paths.project, { recursive: true });
  return spawnSync(process.execPath, [installer, ...args], {
    cwd: paths.project,
    encoding: 'utf8',
    env: env(paths)
  });
}

function install(paths) {
  return spawnSync(process.execPath, [installer], {
    cwd: root,
    encoding: 'utf8',
    env: env(paths)
  });
}

function runInstalledWorkflow(paths, ...args) {
  mkdirSync(paths.project, { recursive: true });
  return spawnSync(process.execPath, [resolve(paths.config, 'ai-work-flow/agent-workflow.mjs'), ...args], {
    cwd: paths.project,
    encoding: 'utf8',
    env: env(paths)
  });
}

function legacyConfigPath(paths) {
  return resolve(paths.config, 'ai-work-flow/config.json');
}

function defaultEnvironmentPath(paths) {
  return resolve(paths.config, 'ai-work-flow/environments/default.json');
}

function agentPath(paths, platform, name, extension) {
  const base = platform === 'codex'
    ? resolve(paths.home, '.codex')
    : platform === 'claude'
      ? resolve(paths.home, '.claude')
      : resolve(paths.config, 'opencode');
  return resolve(base, 'agents', `${name}.${extension}`);
}

test('every role has one shared body template without platform formatting', () => {
  const expected = catalog.roles.map((role) => `${role.id}.md`).sort();
  const bodies = resolve(agentAssets, 'bodies');
  assert.deepEqual(readdirSync(bodies).sort(), expected);
  for (const name of expected) {
    const body = readFileSync(resolve(bodies, name), 'utf8');
    assert.doesNotMatch(body, /^---$/m, name);
    assert.match(body, /\$XDG_CONFIG_HOME\/ai-work-flow\/routing\.md/, name);
    assert.match(body, /~\/\.config\/ai-work-flow\/routing\.md/, name);
  }
});

test('managed prompt documents use the Markdown layout', () => {
  const entries = [
    ['docs/prompt-format.md', readFileSync(resolve(root, 'docs/prompt-format.md'), 'utf8')],
    ['routing.md', readFileSync(resolve(agentAssets, 'routing.md'), 'utf8')],
    ...managedSkillDirectories.map((directory) => [
      `skills/${directory}/SKILL.md`,
      readFileSync(resolve(root, 'skills', directory, 'SKILL.md'), 'utf8')
    ]),
    ...catalog.roles.map((role) => [
      `bodies/${role.id}.md`,
      readFileSync(resolve(agentAssets, 'bodies', `${role.id}.md`), 'utf8')
    ])
  ];

  for (const [name, source] of entries) assertPromptLayout(source, name);
});

test('role bodies derive their common structure and reply sections from the catalog', () => {
  const replyLabels = {
    orchestrator: ['协调状态', '已委派', '已收到', '结论', '阻塞'],
    'file-explorer': ['发现', '代码地图', '交接', '阻塞'],
    researcher: ['发现', '来源', '交接', '阻塞'],
    'document-maintainer': ['完成', '变更', '验证', '阻塞'],
    'planning-writer': ['完成', '变更', '验证', '阻塞'],
    'full-stack-coder': ['完成', '变更', '验证', '阻塞'],
    'git-committer': ['提交结果'],
    'code-reviewer': ['Standards', 'Spec', '结论', '测试缺口', '阻塞'],
    'review-standards': ['结论', '发现', '测试缺口', '阻塞'],
    'review-spec': ['结论', '发现', '测试缺口', '阻塞']
  };

  for (const role of catalog.roles) {
    const body = readFileSync(resolve(agentAssets, 'bodies', `${role.id}.md`), 'utf8');
    assert.match(body, new RegExp(`^# ${role.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), role.id);
    assert.match(body, new RegExp(`你是 \\*\\*${role.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*\\*。`), role.id);
    for (const heading of ['职责', '工作边界', '回复格式']) assert.match(body, new RegExp(`^## ${heading}$`, 'm'), `${role.id}: ${heading}`);
    for (const label of replyLabels[role.id]) assert.match(body, new RegExp(`\\*\\*${label}：\\*\\*`), `${role.id}: ${label}`);
  }
});

test('installation and platform generation retain the managed prompt content', () => {
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);

  for (const platformRoot of [resolve(paths.home, '.codex'), resolve(paths.home, '.claude'), resolve(paths.config, 'opencode')]) {
    for (const directory of managedSkillDirectories) {
      const sourceSkill = resolve(root, 'skills', directory);
      const installedSkill = resolve(platformRoot, 'skills', directory);
      assert.equal(
        readFileSync(resolve(installedSkill, 'SKILL.md'), 'utf8'),
        readFileSync(resolve(sourceSkill, 'SKILL.md'), 'utf8'),
        directory
      );
      assert.equal(readFileSync(resolve(installedSkill, 'agents/openai.yaml'), 'utf8'), readFileSync(resolve(sourceSkill, 'agents/openai.yaml'), 'utf8'), directory);
    }
    const installedSkill = resolve(platformRoot, 'skills/run-matt-spec-to-completion');
    assert.ok(existsSync(resolve(platformRoot, 'execution-runtime/handoff-result-schema.json')));
    const runtimeCheck = spawnSync(process.execPath, [resolve(installedSkill, 'scripts/check-runtime-dependencies.mjs')], {
      cwd: installedSkill,
      encoding: 'utf8',
      env: env(paths)
    });
    assert.equal(runtimeCheck.status, 0, runtimeCheck.stderr);
  }

  for (const [directory, prompt] of defaultSkillPrompts) {
    const source = readFileSync(resolve(root, 'skills', directory, 'agents/openai.yaml'), 'utf8');
    assert.ok(source.includes(`  default_prompt: ${JSON.stringify(prompt)}\n`), directory);
  }
  assert.doesNotMatch(readFileSync(resolve(root, 'skills/run-matt-spec-to-completion/agents/openai.yaml'), 'utf8'), /^  default_prompt:/m);

  assert.equal(readFileSync(resolve(paths.config, 'ai-work-flow/routing.md'), 'utf8'), readFileSync(resolve(agentAssets, 'routing.md'), 'utf8'));
  const runtime = resolve(paths.config, 'ai-work-flow/execution-runtime/execution-cli.mjs');
  assert.ok(existsSync(runtime));
  assert.ok(existsSync(resolve(paths.config, 'ai-work-flow/execution-runtime/handoff-result-schema.json')));
  assert.ok(existsSync(resolve(paths.config, 'ai-work-flow/skills/run-matt-spec-to-completion/lib/validation.mjs')));
  const runtimeResult = spawnSync(process.execPath, [runtime, 'record-ticket', '--repository', paths.project, '--feature', 'example', '--worktree', paths.project], {
    encoding: 'utf8',
    env: env(paths),
    input: '{}\n'
  });
  assert.equal(runtimeResult.status, 1);
  assert.match(runtimeResult.stderr, /Handoff Result violates schema/);
  for (const role of catalog.roles) {
    const body = readFileSync(resolve(agentAssets, 'bodies', `${role.id}.md`), 'utf8').trimEnd();
    assert.equal(codexDeveloperInstructions(readFileSync(agentPath(paths, 'codex', role.id, 'toml'), 'utf8')), body, role.id);
    assert.ok(readFileSync(agentPath(paths, 'claude', role.id, 'md'), 'utf8').endsWith(`${body}\n`), role.id);
    assert.ok(readFileSync(agentPath(paths, 'opencode', role.id, 'md'), 'utf8').endsWith(`${body}\n`), role.id);
  }
});

test('routing is the sole source for shared Git authorization governance', () => {
  const gitCommitter = readFileSync(resolve(agentAssets, 'bodies/git-committer.md'), 'utf8');
  const orchestrator = readFileSync(resolve(agentAssets, 'bodies/orchestrator.md'), 'utf8');
  const routing = readFileSync(resolve(agentAssets, 'routing.md'), 'utf8');
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);

  const sharedAssertions = [
    /首次阻塞清单是唯一授权对象/,
    /授权必须发生在清单展示之后/,
    /只能原样转交.*只能逐项校验/,
    /当前变更集合必须与授权快照一致/,
    /白名单一次性消费/,
    /不得推断文件相关性/
  ];

  assert.match(gitCommitter, /`routing\.md` 的授权范围/);
  assert.match(gitCommitter, /`git-commit` Skill/);
  assert.match(orchestrator, /共同的委派、审查、确认、重试和 Git 授权规则只定义在/);
  for (const body of [gitCommitter, orchestrator]) {
    assert.doesNotMatch(body, /首次范围检查/);
    assert.doesNotMatch(body, /一次性白名单/);
  }
  for (const assertion of sharedAssertions) assert.match(routing, assertion);
  assert.equal(readFileSync(resolve(paths.config, 'ai-work-flow/routing.md'), 'utf8'), routing);

  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    const generatedCommitter = readFileSync(agentPath(paths, platform, 'git-committer', extension), 'utf8');
    const generatedOrchestrator = readFileSync(agentPath(paths, platform, 'orchestrator', extension), 'utf8');
    assert.match(generatedCommitter, /`routing\.md` 的授权范围/, platform);
    assert.match(generatedOrchestrator, /共同的委派、审查、确认、重试和 Git 授权规则只定义在/, platform);
  }
});

test('managed marker updates preserve user content outside the marker byte-for-byte', () => {
  const userPrefix = '# User configuration\n\nKeep this exact.\n\n';
  const userSuffix = '\n\n## User notes\nDo not rewrite.\n';
  const source = `${userPrefix}${MARKER_START}\nold managed content\n${MARKER_END}${userSuffix}`;
  const updated = updateManagedMarker(source, '/tmp/CLAUDE.md');
  const afterMarker = (value) => value.slice(value.indexOf(MARKER_END) + MARKER_END.length);

  assert.deepEqual(Buffer.from(updated.slice(0, updated.indexOf(MARKER_START))), Buffer.from(userPrefix));
  assert.deepEqual(Buffer.from(afterMarker(updated)), Buffer.from(userSuffix));
  const marker = updated.slice(updated.indexOf(MARKER_START), updated.indexOf(MARKER_END) + MARKER_END.length);
  assert.match(marker, /^## AI Work Flow 代理$/m);
  assert.doesNotMatch(marker, /^# (?!#)/m);
});

test('root installer installs every skill globally and generates every platform agent', () => {
  const paths = environment();
  for (const destination of [
    resolve(paths.home, '.codex/skills/user-skill'),
    resolve(paths.home, '.claude/skills/user-skill'),
    resolve(paths.config, 'opencode/skills/user-skill')
  ]) {
    mkdirSync(destination, { recursive: true });
    writeFileSync(resolve(destination, 'SKILL.md'), 'user skill\n');
  }

  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);
  for (const platformRoot of [
    resolve(paths.home, '.codex'),
    resolve(paths.home, '.claude'),
    resolve(paths.config, 'opencode')
  ]) {
    for (const entry of readdirSync(resolve(root, 'skills'), { withFileTypes: true })) {
      if (entry.isDirectory()) assert.ok(existsSync(resolve(platformRoot, 'skills', entry.name, 'SKILL.md')), entry.name);
    }
    assert.equal(readFileSync(resolve(platformRoot, 'skills/user-skill/SKILL.md'), 'utf8'), 'user skill\n');
  }
  assert.ok(existsSync(defaultEnvironmentPath(paths)));
  assert.ok(!existsSync(legacyConfigPath(paths)));
  assert.ok(existsSync(resolve(paths.config, 'ai-work-flow/routing.md')));
  assert.ok(existsSync(resolve(paths.config, 'ai-work-flow/agent-workflow.mjs')));
  assert.equal(readdirSync(resolve(paths.home, '.codex/agents')).filter((name) => name.endsWith('.toml')).length, catalog.roles.length);
  assert.equal(readdirSync(resolve(paths.home, '.claude/agents')).filter((name) => name.endsWith('.md')).length, catalog.roles.length);
  assert.equal(readdirSync(resolve(paths.config, 'opencode/agents')).filter((name) => name.endsWith('.md')).length, catalog.roles.length);
  assert.match(readFileSync(agentPath(paths, 'codex', 'orchestrator', 'toml'), 'utf8'), /~\/\.config\/ai-work-flow\/routing/);
});

test('init creates the default environment without creating a legacy config', () => {
  const paths = environment();

  const result = run(paths, 'init');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(defaultEnvironmentPath(paths)));
  assert.ok(!existsSync(legacyConfigPath(paths)));
});

test('init ignores a legacy config when creating the default environment', () => {
  const paths = environment();
  const legacyConfig = JSON.parse(readFileSync(resolve(agentAssets, 'default-config.json'), 'utf8'));
  legacyConfig.roles.orchestrator.codex.model = 'legacy-config-model';
  legacyConfig.version = 0;
  mkdirSync(resolve(paths.config, 'ai-work-flow'), { recursive: true });
  writeFileSync(legacyConfigPath(paths), `${JSON.stringify(legacyConfig, null, 2)}\n`);

  const result = run(paths, 'init');
  assert.equal(result.status, 0, result.stderr);

  const defaultConfig = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  assert.notEqual(defaultConfig.roles.orchestrator.codex.model, 'legacy-config-model');
  assert.equal(readFileSync(legacyConfigPath(paths), 'utf8'), `${JSON.stringify(legacyConfig, null, 2)}\n`);
  const validation = run(paths, 'validate');
  assert.equal(validation.status, 0, validation.stderr);
});

test('routing is the sole source for shared discovery governance', () => {
  const routing = readFileSync(resolve(agentAssets, 'routing.md'), 'utf8');
  const source = readFileSync(resolve(agentAssets, 'bodies/orchestrator.md'), 'utf8');
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);

  for (const content of [routing]) {
    assert.match(content, /未知本地路径、文件搜索或枚举、代码地图、现有惯例或集成发现/);
    assert.match(content, /先委派 \*\*File Explorer\*\* 并等待其交接/);
    assert.match(content, /当前会话已有交接时可复用/);
    assert.match(content, /用户给出精确路径/);
    assert.match(content, /不得将发现阶段.*后续执行角色/);
  }
  assert.equal(
    readFileSync(resolve(paths.config, 'ai-work-flow/agent-assets/bodies/orchestrator.md'), 'utf8'),
    source
  );
  assert.equal(readFileSync(resolve(paths.config, 'ai-work-flow/routing.md'), 'utf8'), routing);
  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    const generated = readFileSync(agentPath(paths, platform, 'orchestrator', extension), 'utf8');
    assert.match(generated, /~\/\.config\/ai-work-flow\/routing\.md/, platform);
    assert.doesNotMatch(generated, /未知本地路径、文件搜索或枚举、代码地图、现有惯例或集成发现/, platform);
  }
  assert.match(source, /~\/\.config\/ai-work-flow\/routing\.md/);
  assert.doesNotMatch(source, /未知本地路径、文件搜索或枚举、代码地图、现有惯例或集成发现/);
});

test('project navigation is a managed global skill and stores indexes in the project workflow directory', () => {
  const skill = readFileSync(resolve(root, 'skills/project-code-navigation/SKILL.md'), 'utf8');
  const routing = readFileSync(resolve(agentAssets, 'routing.md'), 'utf8');
  const explorer = readFileSync(resolve(agentAssets, 'bodies/file-explorer.md'), 'utf8');
  const coder = readFileSync(resolve(agentAssets, 'bodies/full-stack-coder.md'), 'utf8');
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);

  assert.match(skill, /^name: project-code-navigation$/m);
  assert.match(skill, /\.ai-work-flow\/index\//);
  assert.doesNotMatch(skill, /\.agents\/skills\/project-code-navigation/);
  for (const source of [routing, explorer, coder]) assert.match(source, /\.ai-work-flow\/index\//);
  assert.match(routing, /不得创建 `\.agents\/skills\/project-code-navigation\/`/);
  assert.match(skill, /不得执行全局文件检索/);
  assert.match(skill, /同一轮改动中更新对应索引/);
  assert.match(skill, /新功能缺少导航索引视为未完成/);
  assert.match(routing, /索引命中时直接读取记录的代码，禁止全局文件检索/);
  assert.match(routing, /缺少索引的新功能视为未完成/);
  assert.equal(readFileSync(resolve(paths.config, 'ai-work-flow/routing.md'), 'utf8'), routing);
  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    assert.match(readFileSync(agentPath(paths, platform, 'file-explorer', extension), 'utf8'), /索引命中时交接其中记录的路径/);
    assert.match(readFileSync(agentPath(paths, platform, 'full-stack-coder', extension), 'utf8'), /同一轮改动中更新对应索引/);
  }
});

test('workflow browser automation requires an explicit user request', () => {
  const routing = readFileSync(resolve(agentAssets, 'routing.md'), 'utf8');
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);

  const assertions = [
    /用户在当前请求中明确要求浏览器自动化、E2E 测试或视觉验证/,
    /不得启动、连接或操作 Chrome 或其他可见浏览器/,
    /不得调用 Browser、Chrome DevTools 或 Playwright/,
    /既有 E2E 用例不构成授权/,
    /默认使用无头模式/
  ];

  for (const assertion of assertions) assert.match(routing, assertion);
  assert.equal(readFileSync(resolve(paths.config, 'ai-work-flow/routing.md'), 'utf8'), routing);
  for (const role of catalog.roles) {
    const body = readFileSync(resolve(agentAssets, 'bodies', `${role.id}.md`), 'utf8');
    assert.match(body, /~\/.config\/ai-work-flow\/routing\.md/, role.id);
  }
});

test('planning workflow resolves material user decisions before writing a plan and waits for implementation confirmation', () => {
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);

  const planningWriter = readFileSync(resolve(agentAssets, 'bodies/planning-writer.md'), 'utf8');
  const orchestrator = readFileSync(resolve(agentAssets, 'bodies/orchestrator.md'), 'utf8');
  const routing = readFileSync(resolve(agentAssets, 'routing.md'), 'utf8');

  assert.match(planningWriter, /\.ai-work-flow\/plans\/<planId>\.md/);
  assert.match(planningWriter, /不得实施/);
  assert.match(routing, /\*\*Planning Writer\*\* 写入计划、ADR/);
  for (const content of [routing]) {
    assert.match(content, /可通过工作区探索确认的事实委派 \*\*File Explorer\*\*/);
    assert.match(content, /会实质影响目标、范围、行为、取舍、兼容性、风险或验收标准/);
    assert.match(content, /每次只询问一个决策/);
    assert.match(content, /等待用户的明确回答/);
    assert.match(content, /所有已确认决策必须随任务交接给 \*\*Planning Writer\*\*/);
    assert.match(content, /没有此类未决决策时无需提问/);
    assert.match(content, /kebab-case `planId`/);
    assert.match(content, /\.ai-work-flow\/plans\/<planId>\.md/);
    assert.match(content, /等待用户明确确认/);
    assert.match(content, /不得自动.*实施/);
  }

  assert.equal(
    readFileSync(resolve(paths.config, 'ai-work-flow/agent-assets/bodies/planning-writer.md'), 'utf8'),
    planningWriter
  );
  assert.equal(readFileSync(resolve(paths.config, 'ai-work-flow/routing.md'), 'utf8'), routing);
  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    const generatedPlanningWriter = readFileSync(agentPath(paths, platform, 'planning-writer', extension), 'utf8');
    const generatedOrchestrator = readFileSync(agentPath(paths, platform, 'orchestrator', extension), 'utf8');
    assert.match(generatedPlanningWriter, /\.ai-work-flow\/plans\/<planId>\.md/, platform);
    assert.match(generatedPlanningWriter, /不得实施/, platform);
    assert.match(generatedOrchestrator, /~\/\.config\/ai-work-flow\/routing\.md/, platform);
    assert.doesNotMatch(generatedOrchestrator, /每次只询问一个决策/, platform);
  }
  assert.match(orchestrator, /~\/\.config\/ai-work-flow\/routing\.md/);
  assert.doesNotMatch(orchestrator, /每次只询问一个决策/);
});

test('code review approval satisfies the final independent review', () => {
  const routing = readFileSync(resolve(agentAssets, 'routing.md'), 'utf8');
  const orchestrator = readFileSync(resolve(agentAssets, 'bodies/orchestrator.md'), 'utf8');
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);

  const assertions = [
    /每个阶段先完成实现和测试验证并创建 review commit/,
    /fixed point 到该 review commit 的已提交差异执行一次 Standards \+ Spec 双轴审查/,
    /绝不审查未提交内容/,
    /完成所需 Git 与测试命令验证的双轴审查才是最终独立审查/,
    /工具不可用或命令被拒绝导致的审查不算完成/,
    /审查能力基准恢复后可重新委派一次/,
    /同一会话中，同一稳定差异的已完成审查不得再次委派任何审查角色/,
    /用户确认的修复必须形成晚于 review commit 的追加提交/,
    /`complete-review-fix` 必须记录非空验证结果/,
    /验证后直接整合，不自动复审相同范围/,
    /只有用户明确要求新的独立审查，且代码、测试、规格或审查能力基准发生变化时，才可重新委派 \*\*Code Reviewer\*\*/,
  ];

  for (const content of [routing]) {
    for (const assertion of assertions) assert.match(content, assertion);
  }
  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    const generated = readFileSync(agentPath(paths, platform, 'orchestrator', extension), 'utf8');
    assert.match(generated, /~\/\.config\/ai-work-flow\/routing\.md/, platform);
    assert.doesNotMatch(generated, /同一稳定差异的已完成审查不得再次委派/, platform);
  }
  assert.match(orchestrator, /~\/\.config\/ai-work-flow\/routing\.md/);
  assert.doesNotMatch(orchestrator, /同一稳定差异的已完成审查不得再次委派/);
});

test('review agents preserve the Matt committed-range contract', () => {
  const routing = readFileSync(resolve(agentAssets, 'routing.md'), 'utf8');
  const bodies = Object.fromEntries(['code-reviewer', 'review-standards', 'review-spec'].map((role) => [
    role,
    readFileSync(resolve(agentAssets, 'bodies', `${role}.md`), 'utf8')
  ]));
  const commands = [
    'git rev-parse <fixed-point>',
    'git rev-parse <review-commit>',
    'git status --short',
    'git diff <fixed-point>...<review-commit>',
    'git log <fixed-point>..<review-commit> --oneline'
  ];

  for (const command of commands) assert.ok(routing.includes(command), command);
  for (const body of Object.values(bodies)) {
    assert.ok(body.includes('git diff <fixed-point>...<review-commit>'));
    assert.ok(body.includes('git log <fixed-point>..<review-commit> --oneline'));
  }
  assert.match(routing, /完全相同的两个完整 SHA、diff 命令和 commit list/);
  assert.match(routing, /禁止使用无参数 `git diff` 或 `git diff --cached`/);
  assert.match(bodies['code-reviewer'], /不得合并或跨轴重新排序/);
  assert.match(bodies['review-standards'], /缺少任一项时阻塞/);
  assert.match(bodies['review-spec'], /缺少任一项时阻塞/);

  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);
  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    for (const role of Object.keys(bodies)) {
      const generated = readFileSync(agentPath(paths, platform, role, extension), 'utf8');
      assert.ok(generated.includes('git diff <fixed-point>...<review-commit>'), `${platform}/${role}`);
    }
  }
});

test('routing is the sole source for retry and stop-lock governance', () => {
  const routing = readFileSync(resolve(agentAssets, 'routing.md'), 'utf8');
  const source = readFileSync(resolve(agentAssets, 'bodies/orchestrator.md'), 'utf8');
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);

  const assertions = [
    /最多重试 2 次，共 3 次/,
    /可恢复的 429、502\/503\/504、超时、连接重置或结果未知/,
    /硬配额或计费耗尽的 429 不可重试/,
    /400\/401\/403\/404、参数或模型配置错误、子代理正常任务失败或测试失败、需求不清均不可重试/,
    /`Retry-After`，否则等待 30 秒、60 秒/,
    /网关或连接错误等待 5 秒、15 秒；单次等待不超过 120 秒/,
    /不承诺平台未提供的原子性或精确计时/,
    /只有确认其已终止，才能用全新子会话重试/,
    /无法确认终止时必须停止，不得创建可能重复工作的替代会话/,
    /OpenCode 的重试必须新建 child session；复用 `task_id` 是恢复，不得用于重试/,
    /启动停止锁：禁止任何新委派、恢复或继续/,
    /主代理不得继续实施或将任务汇总为成功/,
    /等待用户明确“继续”或“重试”/,
    /确认没有持续运行的子代理后，才为该任务重置本轮预算/,
    /OpenCode 不得传入旧 `task_id`/
  ];

  for (const content of [routing]) {
    for (const assertion of assertions) assert.match(content, assertion);
  }
  assert.equal(
    readFileSync(resolve(paths.config, 'ai-work-flow/agent-assets/bodies/orchestrator.md'), 'utf8'),
    source
  );
  assert.equal(readFileSync(resolve(paths.config, 'ai-work-flow/routing.md'), 'utf8'), routing);
  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    const generated = readFileSync(agentPath(paths, platform, 'orchestrator', extension), 'utf8');
    assert.match(generated, /~\/\.config\/ai-work-flow\/routing\.md/, platform);
    assert.doesNotMatch(generated, /最多重试 2 次，共 3 次/, platform);
  }
  assert.match(source, /~\/\.config\/ai-work-flow\/routing\.md/);
  assert.doesNotMatch(source, /最多重试 2 次，共 3 次/);
});

test('platform generation enforces the declared workspace access where supported', () => {
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);
  const reviewerRoles = new Set(['code-reviewer', 'review-standards', 'review-spec']);

  for (const role of catalog.roles) {
    const codex = readFileSync(agentPath(paths, 'codex', role.id, 'toml'), 'utf8');
    const claude = readFileSync(agentPath(paths, 'claude', role.id, 'md'), 'utf8');
    const openCode = readFileSync(agentPath(paths, 'opencode', role.id, 'md'), 'utf8');
    const policy = policies[role.policy];
    if (policy.filesystem === 'none' || policy.filesystem === 'read') {
      assert.match(codex, /sandbox_mode = "read-only"/, role.id);
      assert.match(claude, /permissionMode: plan/, role.id);
    } else {
      assert.match(codex, /sandbox_mode = "workspace-write"/, role.id);
      assert.match(claude, /permissionMode: acceptEdits/, role.id);
      assert.match(openCode, /permission: \{"edit":"allow"\}/, role.id);
    }
    if (policy.filesystem === 'none') {
      assert.match(openCode, /permission: \{"read":"deny","edit":"deny","bash":"deny"\}/, role.id);
    }
    if (reviewerRoles.has(role.id)) {
      const expectedTaskPermission = role.id === 'code-reviewer' ? 'allow' : 'deny';
      assert.match(openCode, /"bash":\{"\*":"deny","git status\*":"allow","git diff\*":"allow","git show\*":"allow","git log\*":"allow","git rev-parse\*":"allow","git merge-base\*":"allow","git branch\*":"allow","git ls-files\*":"allow","node --test\*":"allow","npm test\*":"allow"\}/, role.id);
      assert.match(openCode, new RegExp(`"task":"${expectedTaskPermission}"`), role.id);
      assert.doesNotMatch(openCode, /"bash":"allow"/, role.id);
    } else if (policy.filesystem === 'read') {
      assert.match(openCode, /permission: \{"read":"allow","edit":"deny","bash":"deny"\}/, role.id);
    }
  }
});

test('capability reporting reflects adapter limits and rejects invalid policy catalogs before writing', () => {
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CAPABILITY codex\/orchestrator:.*filesystem=unsupported.*delegation=instruction-only/);
  assert.match(result.stderr, /WARNING codex\/orchestrator:.*delegation=instruction-only/);
  const status = run(paths, 'env', 'status');
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /CAPABILITY opencode\/full-stack-coder:.*filesystem=enforced/);

  for (const platform of ['codex', 'claude', 'opencode']) {
    for (const role of catalog.roles) {
      const matrix = capabilityMatrix(platform, role, policies[role.policy]);
      assert.deepEqual(Object.keys(matrix).sort(), ['browser', 'delegation', 'filesystem', 'git', 'network', 'shell', 'write_scope']);
      for (const [capability, level] of Object.entries(matrix)) {
        assert.ok(['enforced', 'instruction-only', 'unsupported'].includes(level), `${platform}/${role.id}/${capability}`);
        if (level !== 'enforced') assert.match(result.stderr, new RegExp(`WARNING ${platform}/${role.id}:[^\\n]*${capability}=${level}`));
      }
    }
  }
  assert.equal(capabilityMatrix('codex', catalog.roles[0], policies.orchestrate).delegation, 'instruction-only');
  assert.equal(capabilityMatrix('codex', catalog.roles[0], policies.orchestrate).filesystem, 'unsupported');
  assert.equal(capabilityMatrix('opencode', catalog.roles.find((role) => role.id === 'review-standards'), policies.review).shell, 'enforced');

  const generated = agentPath(paths, 'codex', 'orchestrator', 'toml');
  const before = readFileSync(generated, 'utf8');
  const policyPath = resolve(paths.config, 'ai-work-flow/agent-assets/policies.json');
  const invalid = JSON.parse(readFileSync(policyPath, 'utf8'));
  invalid.policies.orchestrate.unknown_capability = 'none';
  writeFileSync(policyPath, JSON.stringify(invalid));
  const failed = runInstalledWorkflow(paths, 'generate', '--platform', 'codex');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /unknown capability/);
  assert.equal(readFileSync(generated, 'utf8'), before);

  writeFileSync(policyPath, JSON.stringify({ version: 1, policies }));
  const invalidRoles = JSON.parse(readFileSync(resolve(paths.config, 'ai-work-flow/agent-assets/roles.json'), 'utf8'));
  invalidRoles.roles[0].delegates.push('missing-role');
  writeFileSync(resolve(paths.config, 'ai-work-flow/agent-assets/roles.json'), JSON.stringify(invalidRoles));
  const invalidDelegate = runInstalledWorkflow(paths, 'generate', '--platform', 'codex');
  assert.equal(invalidDelegate.status, 1);
  assert.match(invalidDelegate.stderr, /delegates to an unknown role/);
  assert.equal(readFileSync(generated, 'utf8'), before);
});

test('only writer bodies require git diff reporting', () => {
  const writers = new Set(['document-maintainer', 'planning-writer', 'full-stack-coder']);
  for (const role of catalog.roles) {
    const body = readFileSync(resolve(agentAssets, 'bodies', `${role.id}.md`), 'utf8');
    assert.equal(body.includes('git diff --name-only'), writers.has(role.id), role.id);
  }
});


test('generated agent descriptions prominently use their title-cased display names', () => {
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);
  const routing = readFileSync(resolve(agentAssets, 'routing.md'), 'utf8');

  for (const role of catalog.roles) {
    const displayName = role.id.split('-').map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
    assert.equal(role.name, displayName);
    const description = `**${displayName}**: ${role.description}`;
    assert.ok(readFileSync(agentPath(paths, 'codex', role.id, 'toml'), 'utf8').includes(`description = ${JSON.stringify(description)}`));
    assert.ok(readFileSync(agentPath(paths, 'claude', role.id, 'md'), 'utf8').includes(`description: ${JSON.stringify(description)}`));
    assert.ok(readFileSync(agentPath(paths, 'opencode', role.id, 'md'), 'utf8').includes(`description: ${JSON.stringify(description)}`));
    assert.ok(readFileSync(resolve(agentAssets, 'bodies', `${role.id}.md`), 'utf8').includes(`你是 **${displayName}**。`));
    assert.ok(routing.includes(`**${displayName}**`));
  }
});

test('generation preserves unrelated global configuration and agents', () => {
  const paths = environment();
  mkdirSync(resolve(paths.home, '.codex/agents'), { recursive: true });
  mkdirSync(resolve(paths.home, '.claude/agents'), { recursive: true });
  mkdirSync(resolve(paths.config, 'opencode/agents'), { recursive: true });
  writeFileSync(resolve(paths.home, '.codex/agents/custom.toml'), 'name = "custom"\n');
  writeFileSync(resolve(paths.home, '.claude/agents/custom.md'), 'custom\n');
  writeFileSync(resolve(paths.config, 'opencode/agents/custom.md'), 'custom\n');
  writeFileSync(resolve(paths.home, '.codex/config.toml'), 'model = "user-model"\n[agents]\nmax_depth = 1\n\n[projects."/user/project"]\ntrust_level = "trusted"\n');
  writeFileSync(resolve(paths.home, '.codex/AGENTS.md'), '# User instructions\n');
  writeFileSync(resolve(paths.home, '.claude/CLAUDE.md'), '# User instructions\n');
  mkdirSync(resolve(paths.config, 'opencode'), { recursive: true });
  writeFileSync(resolve(paths.config, 'opencode/opencode.json'), '{"theme":"user","subagent_depth":4,"agent":{"explore":false,"custom":{}}}\n');

  assert.equal(run(paths, 'init').status, 0);
  const result = run(paths, 'generate');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(resolve(paths.home, '.codex/agents/custom.toml'), 'utf8'), 'name = "custom"\n');
  assert.equal(readFileSync(resolve(paths.home, '.claude/agents/custom.md'), 'utf8'), 'custom\n');
  assert.equal(readFileSync(resolve(paths.config, 'opencode/agents/custom.md'), 'utf8'), 'custom\n');
  assert.match(readFileSync(resolve(paths.home, '.codex/config.toml'), 'utf8'), /^model = "user-model"/m);
  assert.match(readFileSync(resolve(paths.home, '.codex/config.toml'), 'utf8'), /^max_depth = 2$/m);
  assert.match(readFileSync(resolve(paths.home, '.codex/config.toml'), 'utf8'), /^\[projects\."\/user\/project"\]$/m);
  assert.match(readFileSync(resolve(paths.home, '.codex/AGENTS.md'), 'utf8'), /~\/\.config\/ai-work-flow\/routing\.md/);
  assert.match(readFileSync(resolve(paths.home, '.claude/CLAUDE.md'), 'utf8'), /`~\/\.config\/ai-work-flow\/routing\.md`/);
  const opencode = JSON.parse(readFileSync(resolve(paths.config, 'opencode/opencode.json'), 'utf8'));
  assert.equal(opencode.theme, 'user');
  assert.equal(opencode.agent.explore, undefined);
  assert.deepEqual(opencode.agent.custom, {});
  assert.equal(opencode.subagent_depth, 4);
  assert.equal(opencode.default_agent, 'orchestrator');
});

test('OpenCode uses subagent frontmatter for configured model constraints', () => {
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);

  const config = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  const guard = resolve(paths.config, 'opencode/plugins/ai-work-flow-subagent-model-guard.js');
  assert.ok(!existsSync(guard));

  for (const role of catalog.roles) {
    const settings = config.roles[role.id].opencode;
    const agent = readFileSync(agentPath(paths, 'opencode', role.id, 'md'), 'utf8');
    if (settings.model) assert.ok(agent.includes(`model: ${settings.model}\n`), role.id);
    if (settings.variant) assert.ok(agent.includes(`variant: ${JSON.stringify(settings.variant)}\n`), role.id);
    assert.doesNotMatch(agent, /^formatter:/m, role.id);
  }
  const opencode = JSON.parse(readFileSync(resolve(paths.config, 'opencode/opencode.json'), 'utf8'));
  assert.equal(opencode.plugin, undefined);
  assert.equal(opencode.subagent_depth, 2);
});

test('OpenCode generation removes the obsolete subagent model guard', () => {
  const paths = environment();
  assert.equal(run(paths, 'init').status, 0);
  const pluginPath = resolve(paths.config, 'opencode/plugins/ai-work-flow-subagent-model-guard.js');
  mkdirSync(resolve(paths.config, 'opencode/plugins'), { recursive: true });
  writeFileSync(pluginPath, 'obsolete plugin\n');

  const result = run(paths, 'generate', '--platform', 'opencode');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(pluginPath));
});

test('generation deletes obsolete primary agents on every platform', () => {
  const paths = environment();
  assert.equal(run(paths, 'init').status, 0);
  const obsoletePrimaryAgentId = ['coord', 'inator'].join('');
  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    const path = agentPath(paths, platform, obsoletePrimaryAgentId, extension);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, 'obsolete agent\n');
  }

  const result = run(paths, 'generate');
  assert.equal(result.status, 0, result.stderr);
  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    assert.ok(!existsSync(agentPath(paths, platform, obsoletePrimaryAgentId, extension)));
    assert.ok(existsSync(agentPath(paths, platform, 'orchestrator', extension)));
  }
});

test('installation removes obsolete managed templates and execution modules', () => {
  const paths = environment();
  assert.equal(install(paths).status, 0);
  const obsoletePrimaryAgentId = ['coord', 'inator'].join('');
  const obsoleteBody = resolve(paths.config, 'ai-work-flow/agent-assets/bodies', `${obsoletePrimaryAgentId}.md`);
  writeFileSync(obsoleteBody, 'obsolete body\n');
  for (const platformRoot of [resolve(paths.home, '.codex'), resolve(paths.home, '.claude'), resolve(paths.config, 'opencode')]) {
    const skillRoot = resolve(platformRoot, 'skills/run-matt-spec-to-completion');
    writeFileSync(resolve(skillRoot, 'lib', `execution-${obsoletePrimaryAgentId}.mjs`), 'obsolete module\n');
    writeFileSync(resolve(skillRoot, 'test', `execution-${obsoletePrimaryAgentId}.test.mjs`), 'obsolete test\n');
  }

  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(obsoleteBody));
  for (const platformRoot of [resolve(paths.home, '.codex'), resolve(paths.home, '.claude'), resolve(paths.config, 'opencode')]) {
    const skillRoot = resolve(platformRoot, 'skills/run-matt-spec-to-completion');
    assert.ok(!existsSync(resolve(skillRoot, 'lib', `execution-${obsoletePrimaryAgentId}.mjs`)));
    assert.ok(!existsSync(resolve(skillRoot, 'test', `execution-${obsoletePrimaryAgentId}.test.mjs`)));
    assert.ok(existsSync(resolve(skillRoot, 'lib/execution-orchestrator.mjs')));
  }
});

test('generate applies edited default environment configuration only to requested platforms', () => {
  const paths = environment();
  assert.equal(install(paths).status, 0);
  const claudeBefore = readFileSync(agentPath(paths, 'claude', 'full-stack-coder', 'md'), 'utf8');
  const config = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  config.roles['full-stack-coder'].codex = { model: 'local-codex', reasoning: 'low' };
  writeFileSync(defaultEnvironmentPath(paths), `${JSON.stringify(config, null, 2)}\n`);

  const result = runInstalledWorkflow(paths, 'generate', '--platform', 'codex');
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(agentPath(paths, 'codex', 'full-stack-coder', 'toml'), 'utf8'), /model = "local-codex"/);
  assert.match(readFileSync(agentPath(paths, 'codex', 'full-stack-coder', 'toml'), 'utf8'), /model_reasoning_effort = "low"/);
  assert.equal(readFileSync(agentPath(paths, 'claude', 'full-stack-coder', 'md'), 'utf8'), claudeBefore);
});

test('invalid configuration and dry runs never write global files', () => {
  const paths = environment();
  const dryInit = run(paths, 'init', '--dry-run');
  assert.equal(dryInit.status, 0, dryInit.stderr);
  assert.ok(!existsSync(defaultEnvironmentPath(paths)));
  assert.ok(!existsSync(legacyConfigPath(paths)));
  const dryInstall = run(paths, 'install', '--dry-run');
  assert.equal(dryInstall.status, 0, dryInstall.stderr);
  assert.ok(!existsSync(resolve(paths.home, '.codex')));
  assert.ok(!existsSync(resolve(paths.config, 'opencode')));

  assert.equal(run(paths, 'init').status, 0);
  const config = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  config.roles.researcher.codex.reasoning = '';
  writeFileSync(defaultEnvironmentPath(paths), `${JSON.stringify(config)}\n`);
  const invalid = run(paths, 'validate');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /researcher\.codex\.reasoning must be a non-empty string/);

  config.roles.researcher.codex.reasoning = 'xhigh';
  writeFileSync(defaultEnvironmentPath(paths), `${JSON.stringify(config)}\n`);
  const extended = run(paths, 'validate');
  assert.equal(extended.status, 0, extended.stderr);
  const dryGenerate = run(paths, 'generate', '--dry-run');
  assert.equal(dryGenerate.status, 0, dryGenerate.stderr);
  assert.ok(!existsSync(agentPath(paths, 'codex', 'orchestrator', 'toml')));

  const opencodeOnly = run(paths, 'generate', '--platform', 'opencode');
  assert.equal(opencodeOnly.status, 0, opencodeOnly.stderr);
  assert.ok(existsSync(agentPath(paths, 'opencode', 'orchestrator', 'md')));
  assert.ok(!existsSync(resolve(paths.home, '.codex')));
});

test('environment input rejects unsafe names, markers, and symbolic links before writing', () => {
  const paths = environment();
  assert.equal(install(paths).status, 0);
  const marker = resolve(paths.config, 'ai-work-flow/.environment');
  for (const name of ['../escape', '/absolute', 'bad\\path', '.', '..', 'line\nfeed']) {
    const result = run(paths, 'env', 'use', name);
    assert.equal(result.status, 1, name);
    assert.ok(!existsSync(marker), name);
  }

  const markerTarget = resolve(paths.base, 'marker-target');
  writeFileSync(markerTarget, 'default');
  symlinkSync(markerTarget, marker);
  const markerResult = run(paths, 'validate');
  assert.equal(markerResult.status, 1);
  assert.match(markerResult.stderr, /symbolic link/);
  assert.equal(readFileSync(markerTarget, 'utf8'), 'default');
  rmSync(marker);

  writeFileSync(marker, 'bad\nmarker');
  const malformedMarker = run(paths, 'env', 'use', 'default');
  assert.equal(malformedMarker.status, 1);
  assert.match(malformedMarker.stderr, /Environment name must be/);
  rmSync(marker);

  const environments = resolve(paths.config, 'ai-work-flow/environments');
  const outside = resolve(paths.base, 'outside-environments');
  mkdirSync(outside, { recursive: true });
  rmSync(environments, { recursive: true, force: true });
  symlinkSync(outside, environments);
  const createResult = run(paths, 'env', 'create', 'escaped');
  assert.equal(createResult.status, 1);
  assert.match(createResult.stderr, /symbolic link/);
  assert.ok(!existsSync(resolve(outside, 'escaped.json')));
});

test('sparse environments are safely merged and platform generation validates only its target', () => {
  const paths = environment();
  assert.equal(install(paths).status, 0);
  const config = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  const completeConfig = structuredClone(config);
  const codexAgent = agentPath(paths, 'codex', 'orchestrator', 'toml');
  const codexBefore = readFileSync(codexAgent, 'utf8');
  delete config.roles.researcher.claude;
  writeFileSync(defaultEnvironmentPath(paths), `${JSON.stringify(config)}\n`);
  const incompleteDefault = run(paths, 'generate', '--platform', 'codex');
  assert.equal(incompleteDefault.status, 1);
  assert.match(incompleteDefault.stderr, /researcher\.claude must be an object/);
  assert.equal(readFileSync(codexAgent, 'utf8'), codexBefore);

  Object.assign(config, completeConfig);
  config.roles.orchestrator.claude.model = 'unsafe\npermissionMode: acceptEdits';
  writeFileSync(defaultEnvironmentPath(paths), `${JSON.stringify(config)}\n`);
  const rejected = run(paths, 'generate', '--platform', 'claude');
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /control character/);

  config.roles.orchestrator.claude.model = 'safe-claude';
  config.roles.orchestrator.claude.effort = 'invalid';
  writeFileSync(defaultEnvironmentPath(paths), `${JSON.stringify(config)}\n`);
  const codexOnly = run(paths, 'generate', '--platform', 'codex');
  assert.equal(codexOnly.status, 0, codexOnly.stderr);
  assert.equal(run(paths, 'validate').status, 1);

  config.roles.orchestrator.claude.effort = 'medium';
  writeFileSync(defaultEnvironmentPath(paths), `${JSON.stringify(config)}\n`);
  writeFileSync(resolve(paths.config, 'ai-work-flow/environments/sparse.json'), JSON.stringify({
    version: 1,
    roles: { orchestrator: { codex: { reasoning: 'low' }, opencode: { model: null, options: { temperature: 0 } } } }
  }));
  assert.equal(run(paths, 'env', 'use', 'sparse').status, 0);
  assert.equal(run(paths, 'generate', '--platform', 'codex,opencode').status, 0);
  const codex = readFileSync(agentPath(paths, 'codex', 'orchestrator', 'toml'), 'utf8');
  const openCode = readFileSync(agentPath(paths, 'opencode', 'orchestrator', 'md'), 'utf8');
  assert.match(codex, /model_reasoning_effort = "low"/);
  assert.doesNotMatch(openCode, /^model:/m);
  assert.match(openCode, /options: \{"temperature":0\}/);
});

test('validation and generation reject the obsolete primary role configuration', () => {
  const paths = environment();
  assert.equal(run(paths, 'init').status, 0);
  const config = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  const obsoletePrimaryAgentId = ['coord', 'inator'].join('');
  config.roles[obsoletePrimaryAgentId] = config.roles.orchestrator;
  delete config.roles.orchestrator;
  writeFileSync(defaultEnvironmentPath(paths), `${JSON.stringify(config, null, 2)}\n`);

  const validation = run(paths, 'validate');
  assert.equal(validation.status, 1);
  assert.match(validation.stderr, new RegExp(`Unknown role: ${obsoletePrimaryAgentId}`));
  assert.match(validation.stderr, /Missing configuration for role: orchestrator/);
  const generation = run(paths, 'generate');
  assert.equal(generation.status, 1);
  assert.match(generation.stderr, new RegExp(`Unknown role: ${obsoletePrimaryAgentId}`));
  assert.ok(!existsSync(agentPath(paths, 'codex', 'orchestrator', 'toml')));
});

test('the installed asset catalog rejects inconsistent templates before generation writes', () => {
  const paths = environment();
  assert.equal(install(paths).status, 0);
  const generated = agentPath(paths, 'codex', 'orchestrator', 'toml');
  writeFileSync(generated, 'preserved agent\n');
  writeFileSync(resolve(paths.config, 'ai-work-flow/agent-assets/bodies/orchestrator.md'), '');

  const validation = runInstalledWorkflow(paths, 'validate');
  assert.equal(validation.status, 1);
  assert.match(validation.stderr, /Agent asset catalog is invalid:[\s\S]*Body template is empty: orchestrator\.md/);

  const generation = runInstalledWorkflow(paths, 'generate', '--platform', 'codex');
  assert.equal(generation.status, 1);
  assert.match(generation.stderr, /Body template is empty: orchestrator\.md/);
  assert.equal(readFileSync(generated, 'utf8'), 'preserved agent\n');
});

test('a platform planning failure prevents writes for every requested platform', () => {
  const paths = environment();
  assert.equal(run(paths, 'init').status, 0);
  mkdirSync(resolve(paths.home, '.claude'), { recursive: true });
  writeFileSync(
    resolve(paths.home, '.claude/CLAUDE.md'),
    '<!-- ai-work-flow:agents:begin -->\n<!-- ai-work-flow:agents:begin -->\n'
  );

  const result = run(paths, 'generate');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot safely update workflow marker/);
  assert.ok(!existsSync(agentPath(paths, 'codex', 'orchestrator', 'toml')));
  assert.ok(!existsSync(agentPath(paths, 'claude', 'orchestrator', 'md')));
  assert.ok(!existsSync(agentPath(paths, 'opencode', 'orchestrator', 'md')));
});

test('install completes lifecycle and platform planning before any global write', () => {
  const paths = environment();
  const claudeMarker = resolve(paths.home, '.claude/CLAUDE.md');
  const invalidMarker = '<!-- ai-work-flow:agents:begin -->\n<!-- ai-work-flow:agents:begin -->\n';
  mkdirSync(resolve(paths.home, '.claude'), { recursive: true });
  writeFileSync(claudeMarker, invalidMarker);

  const result = install(paths);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot safely update workflow marker/);
  assert.ok(!existsSync(resolve(paths.home, '.codex')));
  assert.ok(!existsSync(resolve(paths.home, '.claude/skills')));
  assert.ok(!existsSync(resolve(paths.config, 'opencode')));
  assert.ok(!existsSync(resolve(paths.config, 'ai-work-flow')));
  assert.equal(readFileSync(claudeMarker, 'utf8'), invalidMarker);
});

test("repeated installation is idempotent and the global workflow is independent from setup", () => {
  const paths = environment();
  assert.equal(install(paths).status, 0);
  const repeated = install(paths);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /Generated 0 file\(s\)\./);

  mkdirSync(paths.project, { recursive: true });
  const result = runInstalledWorkflow(paths, 'validate');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(paths.project), []);
});

test('environment merge overrides only specified roles from base config', () => {
  const paths = environment();
  assert.equal(install(paths).status, 0);

  const envDir = resolve(paths.config, 'ai-work-flow/environments');
  mkdirSync(envDir, { recursive: true });
  const envConfig = {
    version: 1,
    roles: {
      orchestrator: {
        codex: { model: 'env-codex', reasoning: 'low' },
        claude: { model: 'env-claude', effort: 'low' },
        opencode: { model: 'env-opencode', variant: 'low', options: {} }
      }
    }
  };
  writeFileSync(resolve(envDir, 'test.json'), `${JSON.stringify(envConfig, null, 2)}\n`);
  writeFileSync(resolve(paths.config, 'ai-work-flow/.environment'), 'test');

  const result = run(paths, 'generate', '--platform', 'codex');
  assert.equal(result.status, 0, result.stderr);
  
  const orchestratorAgent = readFileSync(agentPath(paths, 'codex', 'orchestrator', 'toml'), 'utf8');
  assert.match(orchestratorAgent, /model = "env-codex"/);
  assert.match(orchestratorAgent, /model_reasoning_effort = "low"/);
  
  const fileExplorerAgent = readFileSync(agentPath(paths, 'codex', 'file-explorer', 'toml'), 'utf8');
  const baseConfig = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  assert.match(fileExplorerAgent, new RegExp(`model = "${baseConfig.roles['file-explorer'].codex.model}"`));
});

test('env use default returns to the default environment without reading a legacy config', () => {
  const paths = environment();
  assert.equal(install(paths).status, 0);
  
  const envDir = resolve(paths.config, 'ai-work-flow/environments');
  mkdirSync(envDir, { recursive: true });
  writeFileSync(resolve(envDir, 'dev.json'), '{"version":1,"roles":{}}\n');
  
  const useResult = run(paths, 'env', 'use', 'dev');
  assert.equal(useResult.status, 0, useResult.stderr);
  assert.ok(existsSync(resolve(paths.config, 'ai-work-flow/.environment')));
  assert.equal(readFileSync(resolve(paths.config, 'ai-work-flow/.environment'), 'utf8'), 'dev');
  writeFileSync(legacyConfigPath(paths), '{"version":0}\n');
  
  const defaultResult = run(paths, 'env', 'use', 'default');
  assert.equal(defaultResult.status, 0, defaultResult.stderr);
  assert.ok(!existsSync(resolve(paths.config, 'ai-work-flow/.environment')));
  const validation = run(paths, 'validate');
  assert.equal(validation.status, 0, validation.stderr);
});

test('env create generates full copy of resolved config', () => {
  const paths = environment();
  assert.equal(install(paths).status, 0);
  
  const createResult = run(paths, 'env', 'create', 'production');
  assert.equal(createResult.status, 0, createResult.stderr);
  
  const envPath = resolve(paths.config, 'ai-work-flow/environments/production.json');
  assert.ok(existsSync(envPath));
  
  const baseConfig = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  const envConfig = JSON.parse(readFileSync(envPath, 'utf8'));
  assert.deepEqual(envConfig, baseConfig);
});

test('env delete removes environment file and clears marker if active', () => {
  const paths = environment();
  assert.equal(install(paths).status, 0);
  
  const envDir = resolve(paths.config, 'ai-work-flow/environments');
  mkdirSync(envDir, { recursive: true });
  writeFileSync(resolve(envDir, 'staging.json'), '{"version":1,"roles":{}}\n');
  writeFileSync(resolve(paths.config, 'ai-work-flow/.environment'), 'staging');
  
  const deleteResult = run(paths, 'env', 'delete', 'staging');
  assert.equal(deleteResult.status, 0, deleteResult.stderr);
  assert.ok(!existsSync(resolve(envDir, 'staging.json')));
  assert.ok(!existsSync(resolve(paths.config, 'ai-work-flow/.environment')));
});

test('env delete does not remove the default environment', () => {
  const paths = environment();
  assert.equal(install(paths).status, 0);

  const deleteResult = run(paths, 'env', 'delete', 'default');
  assert.equal(deleteResult.status, 1);
  assert.match(deleteResult.stderr, /default environment cannot be deleted/);
  assert.ok(existsSync(defaultEnvironmentPath(paths)));
});

test('env list shows all environments with current marked', () => {
  const paths = environment();
  assert.equal(install(paths).status, 0);
  
  const envDir = resolve(paths.config, 'ai-work-flow/environments');
  mkdirSync(envDir, { recursive: true });
  writeFileSync(resolve(envDir, 'dev.json'), '{"version":1,"roles":{}}\n');
  writeFileSync(resolve(envDir, 'prod.json'), '{"version":1,"roles":{}}\n');
  writeFileSync(resolve(paths.config, 'ai-work-flow/.environment'), 'dev');
  
  const listResult = run(paths, 'env');
  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /Available environments:/);
  assert.match(listResult.stdout, /\n    default/);
  assert.doesNotMatch(listResult.stdout, /\* default/);
  assert.match(listResult.stdout, /\* dev/);
  assert.match(listResult.stdout, /  prod/);
});

test('generation transaction rolls back failures and recovers interrupted writes', () => {
  const directory = fixture();
  const first = resolve(directory, 'first.txt');
  const second = resolve(directory, 'second.txt');
  const transaction = resolve(directory, 'transaction.json');
  writeFileSync(first, 'before\n');
  assert.throws(() => applyTransaction([
    { type: 'write', path: first, contents: 'after\n' },
    { type: 'write', path: second, contents: 'new\n' }
  ], { transactionPath: transaction, roots: [directory], failAfterStep: 1 }), /Injected transaction failure/);
  assert.equal(readFileSync(first, 'utf8'), 'before\n');
  assert.ok(!existsSync(second));
  assert.ok(!existsSync(transaction));

  assert.throws(() => applyTransaction([
    { type: 'write', path: first, contents: 'after\n' }
  ], { transactionPath: transaction, roots: [directory], interruptAfterRecord: 1 }), /Injected transaction interruption/);
  assert.equal(recoverTransaction(transaction, { roots: [directory] }), true);
  assert.equal(readFileSync(first, 'utf8'), 'before\n');
});

test('a forged transaction journal cannot write outside its trusted root', () => {
  const directory = fixture();
  const outside = resolve(tmpdir(), `outside-${Date.now()}.txt`);
  const transaction = resolve(directory, 'transaction.json');
  writeFileSync(outside, 'preserve\n');
  writeFileSync(transaction, JSON.stringify({
    version: 1,
    id: '123e4567-e89b-42d3-a456-426614174000',
    phase: 'applying',
    steps: [{ type: 'delete', path: outside, existed: false }]
  }));

  assert.throws(() => recoverTransaction(transaction, { roots: [directory] }), /outside trusted roots/);
  assert.equal(readFileSync(outside, 'utf8'), 'preserve\n');
  assert.ok(existsSync(transaction));
  rmSync(outside);
});

test('transaction recovery rejects malformed backups and non-file targets without mutation', () => {
  const directory = fixture();
  const target = resolve(directory, 'target.txt');
  const transaction = resolve(directory, 'transaction.json');
  writeFileSync(target, 'preserve\n');
  writeFileSync(transaction, JSON.stringify({
    version: 1,
    id: '123e4567-e89b-42d3-a456-426614174000',
    phase: 'applying',
    ignored: true,
    steps: [{ type: 'write', path: target, backup: resolve(directory, 'forged-backup'), existed: true }]
  }));
  assert.throws(() => recoverTransaction(transaction, { roots: [directory] }), /invalid identity|invalid backup/);
  assert.equal(readFileSync(target, 'utf8'), 'preserve\n');
  assert.ok(existsSync(transaction));

  rmSync(transaction);
  const directoryTarget = resolve(directory, 'directory-target');
  mkdirSync(directoryTarget);
  assert.throws(() => applyTransaction([
    { type: 'write', path: directoryTarget, contents: 'refuse\n' }
  ], { transactionPath: transaction, roots: [directory] }), /regular file/);
  assert.ok(existsSync(directoryTarget));
  assert.ok(!existsSync(transaction));
});

test('environment activation commits generated agents, marker, and managed platform manifest together', () => {
  const paths = environment();
  assert.equal(install(paths).status, 0);
  writeFileSync(resolve(paths.config, 'ai-work-flow/environments/staging.json'), JSON.stringify({
    version: 1,
    roles: { orchestrator: { codex: { reasoning: 'low' } } }
  }));
  const result = run(paths, 'env', 'use', 'staging');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(resolve(paths.config, 'ai-work-flow/.environment'), 'utf8'), 'staging');
  assert.deepEqual(JSON.parse(readFileSync(resolve(paths.config, 'ai-work-flow/.managed-platforms.json'), 'utf8')).platforms, ['claude', 'codex', 'opencode']);
  assert.match(readFileSync(agentPath(paths, 'codex', 'orchestrator', 'toml'), 'utf8'), /model_reasoning_effort = "low"/);
  assert.ok(!existsSync(resolve(paths.config, 'ai-work-flow/.generation-transaction.json')));
});

test('an already synchronized generation clears a committed transaction journal', () => {
  const paths = environment();
  assert.equal(install(paths).status, 0);
  const transaction = resolve(paths.config, 'ai-work-flow/.generation-transaction.json');
  const target = resolve(paths.config, 'ai-work-flow/.managed-platforms.json');
  const id = '123e4567-e89b-42d3-a456-426614174000';
  const backup = resolve(paths.config, 'ai-work-flow', `.${id}.0.ai-work-flow-backup`);
  writeFileSync(backup, 'old manifest\n');
  writeFileSync(transaction, JSON.stringify({
    version: 1,
    id,
    phase: 'committed',
    steps: [{ type: 'write', path: target, backup, existed: true }]
  }));

  const result = run(paths, 'generate');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(transaction));
  assert.ok(!existsSync(backup));
});

test('environment file not found gives clear error', () => {
  const paths = environment();
  assert.equal(install(paths).status, 0);

  writeFileSync(resolve(paths.config, 'ai-work-flow/.environment'), 'nonexistent');

  const result = run(paths, 'validate');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Environment file not found/);
});
