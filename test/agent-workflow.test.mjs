import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { parse as parseToml } from '@iarna/toml';
import YAML from 'yaml';

import { MARKER_END, MARKER_START, updateManagedMarker } from '../agent-build/runtime/managed-content.mjs';
import { loadAgentAssets } from '../agent-build/runtime/asset-catalog.mjs';
import { capabilityEvidence, capabilityMatrix, evaluateOpenCodePermission } from '../agent-build/runtime/platform-adapter.mjs';
import { applyTransaction, recoverTransaction } from '../agent-build/runtime/transaction.mjs';

const root = resolve(import.meta.dirname, '..');
const installer = resolve(root, 'agent-build/install.mjs');
const configDir = resolve(root, 'agent-build/config');
const templatesDir = resolve(root, 'agent-build/templates');
const executionSkill = `run-${['M', 'att'].join('').toLowerCase()}-spec-to-completion`;
const catalog = JSON.parse(readFileSync(resolve(configDir, 'roles.json'), 'utf8'));
const policies = JSON.parse(readFileSync(resolve(configDir, 'policies.json'), 'utf8')).policies;
const managedSkillDirectories = [
  'generate-ai-work-flow-agents',
  'switch-ai-work-flow-env',
  'project-code-navigation',
  'git-commit',
  'run-matt-spec-to-completion'
];
const defaultSkillPrompts = new Map([
  ['generate-ai-work-flow-agents', '使用 `$generate-ai-work-flow-agents` 验证全局配置并生成代理。'],
  ['switch-ai-work-flow-env', '使用 `$switch-ai-work-flow-env` 切换到指定环境并重新生成代理。'],
  ['project-code-navigation', '使用 `$project-code-navigation` 为当前项目创建或更新 `.ai-work-flow/index/` 代码导航索引。'],
  ['git-commit', '使用 `$git-commit` 生成中文 Conventional Commits 提交信息并创建受控本地提交。']
]);

function assertPromptLayout(source, name, { replyFormat = true } = {}) {
  const prose = source.replace(/^```[\s\S]*?^```$/gm, '');
  assert.equal((prose.match(/^# [^\n]+$/gm) ?? []).length, 1, `${name} needs one primary title`);
  if (replyFormat) {
    assert.match(prose, /^## 回复格式$/m, `${name} needs a reply format`);
    assert.match(prose, /\*\*(?:状态|结论|阻塞|结果|更新|注意|完成|发现|提交结果|严重)：\*\*/, `${name} needs a bold response label`);
  }
  assert.doesNotMatch(prose, /^#{1,3} [^\n]+\n(?!\n)/m, `${name} headings need a following blank line`);
}

function codexDeveloperInstructions(source) {
  const encoded = source.match(/^developer_instructions = (.+)$/m)?.[1];
  assert.ok(encoded, 'Codex agent needs developer instructions');
  return JSON.parse(encoded);
}

function generatedBody(paths, platform, roleId, extension) {
  const source = readFileSync(agentPath(paths, platform, roleId, extension), 'utf8');
  if (platform === 'codex') return codexDeveloperInstructions(source);
  return source.slice(source.indexOf('\n---\n', 4) + 5).trim();
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

function environmentPath(paths, name) {
  return resolve(paths.config, 'ai-work-flow/environments', `${name}.json`);
}

const legacyPrimaryAgentId = 'orchestrator';
const legacyGitOperatorAgentId = 'git-committer';
const gitOperatorAgentId = 'git-operator';

function agentPath(paths, platform, name, extension) {
  const base = platform === 'codex'
    ? resolve(paths.home, '.codex')
    : platform === 'claude'
      ? resolve(paths.home, '.claude')
      : resolve(paths.config, 'opencode');
  return resolve(base, 'agents', `${name}.${extension}`);
}

function repositoryOwnedArtifactPaths() {
  const tracked = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  assert.equal(tracked.status, 0, tracked.stderr);
  return tracked.stdout.split('\n')
    .filter(Boolean)
    .filter((path) => !/(^|\/)test(s)?\//.test(path))
    .filter((path) => existsSync(resolve(root, path)));
}

test('repository-owned artifacts use AI Work Flow terminology', () => {
  const borrowedBrand = ['M', 'att'].join('');
  const paths = repositoryOwnedArtifactPaths();
  const brandedPath = paths.find((path) => (
    new RegExp(`(^|[-_/])${borrowedBrand}([-_/]|$)`, 'i').test(path.replaceAll(executionSkill, ''))
  ));
  assert.equal(brandedPath, undefined, brandedPath);

  const brandedContent = paths.find((path) => {
    const contents = readFileSync(resolve(root, path));
    if (contents.includes(0)) return false;
    return new RegExp(`(^|[^a-z0-9_])${borrowedBrand}([^a-z0-9_]|$)|${borrowedBrand}pocock`, 'i').test(contents.toString('utf8').replaceAll(executionSkill, ''));
  });
  assert.equal(brandedContent, undefined, brandedContent);
});

test('terminology detection excludes test assertions but still scans managed artifacts', () => {
  const paths = repositoryOwnedArtifactPaths();
  assert.ok(!paths.includes('test/agent-workflow.test.mjs'));
  assert.ok(paths.includes('agent-build/config/routing.md'));
});

test('every role has one role-specific body template and a compiled governance body', () => {
  const expected = catalog.roles.map((role) => `${role.id}.md`).sort();
  const bodies = templatesDir;
  const assets = loadAgentAssets();
  assert.deepEqual(readdirSync(bodies).sort(), expected);
  for (const name of expected) {
    const body = readFileSync(resolve(bodies, name), 'utf8');
    assert.doesNotMatch(body, /^---$/m, name);
    assert.doesNotMatch(body, /ai-work-flow:routing-digest=/, name);
    assert.match(assets.compiledBodies.get(name.slice(0, -3)), /ai-work-flow:routing-digest=/, name);
  }
});

test('compiled governance is scoped to each role concern', () => {
  const assets = loadAgentAssets();
  const compiled = assets.compiledBodies;
  const expectedSections = {
    coding: ['browser-governance', 'retry-governance', 'implementation-governance'],
    planning: ['browser-governance', 'retry-governance'],
    'file-explorer': ['browser-governance'],
    researcher: ['browser-governance'],
    'document-maintainer': ['browser-governance', 'handoff-governance'],
    'planning-writer': ['browser-governance', 'handoff-governance'],
    'task-planner': ['browser-governance', 'handoff-governance'],
    'full-stack-coder': ['browser-governance', 'retry-governance', 'implementation-governance'],
    'bug-fixer': ['browser-governance', 'retry-governance', 'implementation-governance'],
    'git-operator': ['browser-governance', 'implementation-governance'],
    'code-reviewer': ['browser-governance', 'retry-governance', 'review-governance'],
    'review-standards': ['browser-governance', 'review-governance'],
    'review-spec': ['browser-governance', 'review-governance']
  };

  for (const role of assets.roles) {
    const prompt = compiled.get(role.id);
    assert.deepEqual(role.routing_sections, expectedSections[role.id], role.id);
    assert.match(prompt, /不得调用 Browser、Chrome DevTools 或 Playwright/, role.id);
    assert.doesNotMatch(prompt, /Policy 与能力边界|`delegation_targets` 单独表示/, role.id);
    assert.doesNotMatch(assets.bodies.get(role.id), /XDG_CONFIG_HOME.*routing\.md/, role.id);
  }

  const retryRoles = new Set(['coding', 'planning', 'full-stack-coder', 'bug-fixer', 'code-reviewer']);
  const implementationRoles = new Set(['coding', 'full-stack-coder', 'bug-fixer', 'git-operator']);
  const reviewRoles = new Set(['code-reviewer', 'review-standards', 'review-spec']);
  const handoffRoles = new Set(['document-maintainer', 'planning-writer', 'task-planner']);
  for (const role of assets.roles) {
    const prompt = compiled.get(role.id);
    assert.equal(prompt.includes('每个子任务的首次尝试最多重试 2 次'), retryRoles.has(role.id), `${role.id}: retry`);
    assert.equal(prompt.includes('确认方案后的实现阶段固定按以下顺序执行'), implementationRoles.has(role.id), `${role.id}: implementation`);
    assert.equal(prompt.includes('两个端点必须可解析'), reviewRoles.has(role.id), `${role.id}: review`);
    assert.equal(prompt.includes('需要未知路径、文件搜索或枚举时必须停止'), handoffRoles.has(role.id), `${role.id}: handoff`);
  }

  assert.doesNotMatch(compiled.get('coding'), /ReviewManifest|git diff --no-ext-diff/);
  assert.doesNotMatch(compiled.get('planning'), /review_commit|PathChange|ReviewManifest/);
  assert.doesNotMatch(compiled.get('researcher'), /review_commit|PathChange|ReviewManifest|每个子任务的首次尝试最多重试 2 次/);
  assert.match(assets.bodies.get('planning'), /编码、修改源码或实施请求.*拒绝/);
  assert.doesNotMatch(assets.routing, /planning-governance|Policy 与能力边界|^## 回复格式$/m);
  const totalCompiledLength = [...compiled.values()].reduce((total, prompt) => total + prompt.length, 0);
  assert.ok(totalCompiledLength < 52_500, `compiled prompts should stay focused, got ${totalCompiledLength} characters`);
});

test('managed prompt documents use the Markdown layout', () => {
  const entries = [
    ['docs/prompt-format.md', readFileSync(resolve(root, 'docs/prompt-format.md'), 'utf8')],
    ['routing.md', readFileSync(resolve(configDir, 'routing.md'), 'utf8')],
    ...managedSkillDirectories.map((directory) => [
      `skills/${directory}/SKILL.md`,
      readFileSync(resolve(root, 'skills', directory, 'SKILL.md'), 'utf8')
    ]),
    ...catalog.roles.map((role) => [
      `templates/${role.id}.md`,
      readFileSync(resolve(templatesDir, `${role.id}.md`), 'utf8')
    ])
  ];

  for (const [name, source] of entries) assertPromptLayout(source, name, { replyFormat: name !== 'routing.md' });
});

test('role bodies derive their common structure and reply sections from the catalog', () => {
  const replyLabels = {
    coding: ['协调状态', '已委派', '已收到', '结论', '阻塞'],
    planning: ['状态', '方案目录', '计划文件', '阻塞'],
    'file-explorer': ['发现', '代码地图', '交接', '阻塞'],
    researcher: ['发现', '来源', '交接', '阻塞'],
    'document-maintainer': ['完成', '变更', '验证', '阻塞'],
    'planning-writer': ['完成', '变更', '验证', '阻塞'],
    'task-planner': ['完成', '变更', '验证', '阻塞'],
    'full-stack-coder': ['完成', '变更', '验证', '阻塞'],
    'bug-fixer': ['完成', '变更', '验证', '阻塞'],
    'git-operator': ['提交结果'],
    'code-reviewer': ['Standards', 'Spec', '结论', '测试缺口', '阻塞'],
    'review-standards': ['结论', '发现', '测试缺口', '阻塞'],
    'review-spec': ['结论', '发现', '测试缺口', '阻塞']
  };

  for (const role of catalog.roles) {
    const body = readFileSync(resolve(templatesDir, `${role.id}.md`), 'utf8');
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

  assert.equal(readFileSync(resolve(paths.config, 'ai-work-flow/routing.md'), 'utf8'), readFileSync(resolve(configDir, 'routing.md'), 'utf8'));
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
    const compiled = loadAgentAssets().compiledBodies.get(role.id);
    assert.equal(generatedBody(paths, 'codex', role.id, 'toml'), compiled, role.id);
    assert.equal(generatedBody(paths, 'claude', role.id, 'md'), compiled, role.id);
    assert.equal(generatedBody(paths, 'opencode', role.id, 'md'), compiled, role.id);
  }
});

test('routing defines automatic scoped local commits after confirmed implementation', () => {
  const gitOperator = readFileSync(resolve(templatesDir, 'git-operator.md'), 'utf8');
  const coding = readFileSync(resolve(templatesDir, 'coding.md'), 'utf8');
  const routing = readFileSync(resolve(configDir, 'routing.md'), 'utf8');
  const compiled = loadAgentAssets().compiledBodies;
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);

  const sharedAssertions = [
    /确认方案或要求实施，即授权为该实现阶段创建仅本地的 review commit/,
    /不需要在首次暂存前再次逐项请求授权/,
    /base_commit/,
    /精确 `changed_paths: PathChange\[\]`/,
    /porcelain v2 `-z`/,
    /PathChange 集合与交接 `changed_paths` 全字段一致/,
    /工作树仍有 staged、unstaged 或 untracked 内容时，不能启动审查/,
    /该状态应作为范围或实现阻塞报告，而不是向用户重新请求同一实施阶段的提交授权/
  ];

  assert.match(gitOperator, /\$git-commit/);
  assert.match(compiled.get('git-operator'), /不得再次向用户请求/);
  for (const body of [gitOperator, coding]) {
    assert.doesNotMatch(body, /首次范围检查/);
    assert.doesNotMatch(body, /一次性白名单/);
    assert.doesNotMatch(body, /routing\.md/);
  }
  for (const assertion of sharedAssertions) assert.match(routing, assertion);
  assert.equal(readFileSync(resolve(paths.config, 'ai-work-flow/routing.md'), 'utf8'), routing);

  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    const generatedOperator = readFileSync(agentPath(paths, platform, 'git-operator', extension), 'utf8');
    const generatedCoding = readFileSync(agentPath(paths, platform, 'coding', extension), 'utf8');
    assert.match(platform === 'codex' ? codexDeveloperInstructions(generatedOperator) : generatedBody(paths, platform, 'git-operator', extension), /不得再次向用户请求/, platform);
    assert.match(platform === 'codex' ? codexDeveloperInstructions(generatedCoding) : generatedBody(paths, platform, 'coding', extension), /确认方案后的实现阶段固定/, platform);
  }
});

test('implementation commits precede the committed-range dual-axis review', () => {
  const routing = readFileSync(resolve(configDir, 'routing.md'), 'utf8');
  const coder = readFileSync(resolve(templatesDir, 'full-stack-coder.md'), 'utf8');
  const operator = readFileSync(resolve(templatesDir, 'git-operator.md'), 'utf8');
  const skill = readFileSync(resolve(root, 'skills/git-commit/SKILL.md'), 'utf8');
  const protocol = readFileSync(resolve(root, 'skills', executionSkill, 'references/completion-protocol.md'), 'utf8');
  const requiredScopeContract = [
    /初始状态必须为空/,
    /porcelain=v2 -z --untracked-files=all/,
    /changed_paths: PathChange\[\]/,
    /rename\/copy 必须保留两条 Git 原始路径/,
    /当前 `HEAD` 不等于 `base_commit`/,
    /当前结构化状态与交接不一致/
  ];

  assert.match(routing, /Full Stack Coder.*Git Operator.*Code Reviewer[\s\S]*Review Standards.*Review Spec/);
  assert.match(routing, /提交失败、工作树不干净或测试失败时不得启动审查/);
  for (const assertion of requiredScopeContract) assert.match(routing, assertion);
  for (const assertion of requiredScopeContract.slice(0, 5)) assert.match(loadAgentAssets().compiledBodies.get('full-stack-coder'), assertion);
  assert.match(loadAgentAssets().compiledBodies.get('git-operator'), /参数数组和 `--` 暂存/);
  assert.match(loadAgentAssets().compiledBodies.get('git-operator'), /当前 `HEAD` 精确等于 `base_commit`/);
  assert.match(skill, /<type>\[optional scope\]\[optional !\]: <description>/);
  assert.match(skill, /使用 `feat` 表示新增功能，使用 `fix` 表示修复 bug/);
  assert.match(skill, /`build`、`chore`、`ci`、`docs`、`style`、`refactor`、`perf` 或 `test`/);
  assert.match(skill, /描述、正文、破坏性变更说明和 trailer value 必须使用中文/);
  assert.match(skill, /BREAKING CHANGE:/);
  assert.match(skill, /Co-Authored-By/);
  assert.doesNotMatch(skill, /Gitmoji|:sparkles:/);
  assert.match(skill, /初始 `git status --short` 为空、当前 `HEAD` 精确等于 `base_commit`/);
  assert.match(skill, /git status --porcelain=v2 -z --untracked-files=all/);
  assert.match(skill, /PathChange/);
  assert.match(protocol, /implement` 与 `\$git-commit` skill/);
  assert.match(protocol, /空的 porcelain v2 状态/);
  assert.match(protocol, /PathChange/);
  assert.match(protocol, /当前 `HEAD` 仍精确等于 `base_commit`、结构化范围核对通过且验证成功/);
  assert.match(protocol, /不得等待额外的提交授权/);
  assert.match(skill, /\*\*结果：\*\*/);
  assert.match(skill, /\*\*状态：\*\*/);
  assert.doesNotMatch(skill, /\*\*提交结果：\*\*/);
});

test('generated implementation and review roles preserve their scoped contracts', () => {
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);

  const implementationAssertions = [
    /Git Operator prepare -> Full Stack Coder -> Git Operator commit\/sync -> Code Reviewer -> Review Standards \+ Review Spec/,
    /不等待新的提交授权/,
    /base_commit/
  ];
  const reviewAssertions = [
    /固定的 `fixed-point` 与 `review-commit`/,
    /固定行窗口/,
    /只重试未完成分片并保持相同 SHA/
  ];
  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    const coding = generatedBody(paths, platform, 'coding', extension);
    const reviewer = generatedBody(paths, platform, 'code-reviewer', extension);
    for (const assertion of implementationAssertions) assert.match(coding, assertion, `${platform}/coding`);
    for (const assertion of reviewAssertions) assert.match(reviewer, assertion, `${platform}/code-reviewer`);
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
  assert.match(generatedBody(paths, 'codex', 'coding', 'toml'), /ai-work-flow:routing-digest=/);
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
  const legacyConfig = JSON.parse(readFileSync(resolve(configDir, 'default-config.json'), 'utf8'));
  legacyConfig.roles.coding.codex.model = 'legacy-config-model';
  legacyConfig.version = 0;
  mkdirSync(resolve(paths.config, 'ai-work-flow'), { recursive: true });
  writeFileSync(legacyConfigPath(paths), `${JSON.stringify(legacyConfig, null, 2)}\n`);

  const result = run(paths, 'init');
  assert.equal(result.status, 0, result.stderr);

  const defaultConfig = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  assert.notEqual(defaultConfig.roles.coding.codex.model, 'legacy-config-model');
  assert.equal(readFileSync(legacyConfigPath(paths), 'utf8'), `${JSON.stringify(legacyConfig, null, 2)}\n`);
  const validation = run(paths, 'validate');
  assert.equal(validation.status, 0, validation.stderr);
});

test('validate does not migrate a default environment that lacks planning', () => {
  const paths = environment();
  assert.equal(run(paths, 'init').status, 0);
  const configuration = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  delete configuration.roles.planning;
  const before = `${JSON.stringify(configuration, null, 2)}\n`;
  writeFileSync(defaultEnvironmentPath(paths), before);

  const validation = run(paths, 'validate');
  assert.equal(validation.status, 1);
  assert.match(validation.stderr, /Missing configuration for role: planning/);
  assert.equal(readFileSync(defaultEnvironmentPath(paths), 'utf8'), before);
  assert.ok(!existsSync(agentPath(paths, 'codex', 'planning', 'toml')));
});

test('install migrates only a completely missing planning role and preserves sparse overlays', () => {
  const paths = environment();
  assert.equal(run(paths, 'init').status, 0);
  const configuration = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  configuration.roles.coding.codex.model = 'preserved-model';
  delete configuration.roles.planning;
  writeFileSync(defaultEnvironmentPath(paths), `${JSON.stringify(configuration, null, 2)}\n`);

  const overlayPath = resolve(paths.config, 'ai-work-flow/environments/sparse.json');
  const overlay = `${JSON.stringify({
    version: 1,
    roles: { coding: { codex: { reasoning: 'low' } } }
  }, null, 2)}\n`;
  writeFileSync(overlayPath, overlay);
  writeFileSync(resolve(paths.config, 'ai-work-flow/.environment'), 'sparse');

  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);
  const migrated = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  const defaults = JSON.parse(readFileSync(resolve(configDir, 'default-config.json'), 'utf8'));
  assert.deepEqual(migrated.roles.planning, defaults.roles.planning);
  assert.equal(migrated.roles.coding.codex.model, 'preserved-model');
  assert.equal(readFileSync(overlayPath, 'utf8'), overlay);
  assert.match(readFileSync(agentPath(paths, 'codex', 'planning', 'toml'), 'utf8'), /model = "gpt-5\.6-sol"/);
  assert.match(readFileSync(agentPath(paths, 'codex', 'coding', 'toml'), 'utf8'), /model = "preserved-model"/);
});

test('install atomically migrates the legacy primary role in default and sparse environments', () => {
  const paths = environment();
  assert.equal(run(paths, 'init').status, 0);
  const defaultConfig = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  defaultConfig.roles[legacyPrimaryAgentId] = defaultConfig.roles.coding;
  delete defaultConfig.roles.coding;
  defaultConfig.roles[legacyPrimaryAgentId].codex.model = 'migrated-default-model';
  writeFileSync(defaultEnvironmentPath(paths), `${JSON.stringify(defaultConfig, null, 2)}\n`);

  const sparseOverlay = {
    version: 1,
    roles: {
      [legacyPrimaryAgentId]: { codex: { reasoning: 'low' } },
      'full-stack-coder': { opencode: { model: null, options: { temperature: 0 } } }
    }
  };
  const overlayPath = environmentPath(paths, 'sparse');
  writeFileSync(overlayPath, `${JSON.stringify(sparseOverlay, null, 2)}\n`);
  writeFileSync(resolve(paths.config, 'ai-work-flow/.environment'), 'sparse');

  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);
  const migratedDefault = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  const migratedOverlay = JSON.parse(readFileSync(overlayPath, 'utf8'));
  assert.equal(migratedDefault.roles.coding.codex.model, 'migrated-default-model');
  assert.equal(migratedDefault.roles[legacyPrimaryAgentId], undefined);
  assert.deepEqual(migratedOverlay.roles.coding, sparseOverlay.roles[legacyPrimaryAgentId]);
  assert.deepEqual(migratedOverlay.roles['full-stack-coder'], sparseOverlay.roles['full-stack-coder']);
  assert.equal(migratedOverlay.roles[legacyPrimaryAgentId], undefined);
  assert.match(readFileSync(agentPath(paths, 'codex', 'coding', 'toml'), 'utf8'), /model_reasoning_effort = "low"/);
});

test('install atomically migrates the renamed Git Operator role in default and sparse environments', () => {
  const paths = environment();
  assert.equal(run(paths, 'init').status, 0);
  const defaultConfig = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  defaultConfig.roles[legacyGitOperatorAgentId] = defaultConfig.roles[gitOperatorAgentId];
  delete defaultConfig.roles[gitOperatorAgentId];
  defaultConfig.roles[legacyGitOperatorAgentId].codex.model = 'migrated-git-model';
  writeFileSync(defaultEnvironmentPath(paths), `${JSON.stringify(defaultConfig, null, 2)}\n`);

  const sparseOverlay = {
    version: 1,
    roles: {
      [legacyGitOperatorAgentId]: { codex: { reasoning: 'medium' } }
    }
  };
  const overlayPath = environmentPath(paths, 'sparse');
  writeFileSync(overlayPath, `${JSON.stringify(sparseOverlay, null, 2)}\n`);
  writeFileSync(resolve(paths.config, 'ai-work-flow/.environment'), 'sparse');

  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);
  const migratedDefault = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  const migratedOverlay = JSON.parse(readFileSync(overlayPath, 'utf8'));
  assert.equal(migratedDefault.roles[gitOperatorAgentId].codex.model, 'migrated-git-model');
  assert.equal(migratedDefault.roles[legacyGitOperatorAgentId], undefined);
  assert.deepEqual(migratedOverlay.roles[gitOperatorAgentId], sparseOverlay.roles[legacyGitOperatorAgentId]);
  assert.equal(migratedOverlay.roles[legacyGitOperatorAgentId], undefined);
  assert.match(readFileSync(agentPath(paths, 'codex', gitOperatorAgentId, 'toml'), 'utf8'), /model_reasoning_effort = "medium"/);
});

test('install atomically adds a completely missing task planner to default configuration', () => {
  const paths = environment();
  assert.equal(run(paths, 'init').status, 0);
  const configuration = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  delete configuration.roles['task-planner'];
  configuration.roles.coding.codex.model = 'preserved-model';
  writeFileSync(defaultEnvironmentPath(paths), `${JSON.stringify(configuration, null, 2)}\n`);

  const overlayPath = environmentPath(paths, 'sparse');
  const overlay = `${JSON.stringify({
    version: 1,
    roles: { coding: { codex: { reasoning: 'low' } } }
  }, null, 2)}\n`;
  writeFileSync(overlayPath, overlay);
  writeFileSync(resolve(paths.config, 'ai-work-flow/.environment'), 'sparse');

  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);
  const migrated = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  const defaults = JSON.parse(readFileSync(resolve(configDir, 'default-config.json'), 'utf8'));
  assert.deepEqual(migrated.roles['task-planner'], defaults.roles['task-planner']);
  assert.equal(migrated.roles.coding.codex.model, 'preserved-model');
  assert.equal(readFileSync(overlayPath, 'utf8'), overlay);
  assert.match(readFileSync(agentPath(paths, 'codex', 'task-planner', 'toml'), 'utf8'), /model = "gpt-5\.6-sol"/);
});

test('validate and install dry-run never write a missing task planner migration', () => {
  const paths = environment();
  assert.equal(run(paths, 'init').status, 0);
  const configuration = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  delete configuration.roles['task-planner'];
  const before = `${JSON.stringify(configuration, null, 2)}\n`;
  writeFileSync(defaultEnvironmentPath(paths), before);

  const validation = run(paths, 'validate');
  assert.equal(validation.status, 1);
  assert.match(validation.stderr, /Missing configuration for role: task-planner/);
  assert.equal(readFileSync(defaultEnvironmentPath(paths), 'utf8'), before);

  const dryRun = run(paths, '--dry-run');
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(readFileSync(defaultEnvironmentPath(paths), 'utf8'), before);
  assert.ok(!existsSync(agentPath(paths, 'codex', 'task-planner', 'toml')));
});

test('install atomically adds a completely missing bug fixer to default configuration', () => {
  const paths = environment();
  assert.equal(run(paths, 'init').status, 0);
  const configuration = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  delete configuration.roles['bug-fixer'];
  configuration.roles.coding.codex.model = 'preserved-model';
  writeFileSync(defaultEnvironmentPath(paths), `${JSON.stringify(configuration, null, 2)}\n`);

  const overlayPath = environmentPath(paths, 'sparse');
  const overlay = `${JSON.stringify({
    version: 1,
    roles: { coding: { codex: { reasoning: 'low' } } }
  }, null, 2)}\n`;
  writeFileSync(overlayPath, overlay);
  writeFileSync(resolve(paths.config, 'ai-work-flow/.environment'), 'sparse');

  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);
  const migrated = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  const defaults = JSON.parse(readFileSync(resolve(configDir, 'default-config.json'), 'utf8'));
  assert.deepEqual(migrated.roles['bug-fixer'], defaults.roles['bug-fixer']);
  assert.equal(migrated.roles.coding.codex.model, 'preserved-model');
  assert.equal(readFileSync(overlayPath, 'utf8'), overlay);
  assert.match(readFileSync(agentPath(paths, 'codex', 'bug-fixer', 'toml'), 'utf8'), /model = "gpt-5\.6-luna"/);
});

test('validate and generation use a missing bug fixer default without rewriting the environment', () => {
  const paths = environment();
  assert.equal(run(paths, 'init').status, 0);
  const configuration = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  delete configuration.roles['bug-fixer'];
  const before = `${JSON.stringify(configuration, null, 2)}\n`;
  writeFileSync(defaultEnvironmentPath(paths), before);

  const validation = run(paths, 'validate');
  assert.equal(validation.status, 0, validation.stderr);
  assert.match(validation.stdout, /Configuration is valid/);
  assert.equal(readFileSync(defaultEnvironmentPath(paths), 'utf8'), before);

  const generation = run(paths, 'generate');
  assert.equal(generation.status, 0, generation.stderr);
  assert.equal(readFileSync(defaultEnvironmentPath(paths), 'utf8'), before);
  assert.match(readFileSync(agentPath(paths, 'codex', 'bug-fixer', 'toml'), 'utf8'), /model = "gpt-5\.6-luna"/);
  assert.match(readFileSync(agentPath(paths, 'claude', 'bug-fixer', 'md'), 'utf8'), /model: "sonnet"/);
  assert.match(readFileSync(agentPath(paths, 'opencode', 'bug-fixer', 'md'), 'utf8'), /model: "baibai\/gpt-5\.6-luna"/);
});

test('validate rejects an existing partial bug fixer without rewriting the environment', () => {
  const paths = environment();
  assert.equal(run(paths, 'init').status, 0);
  const configuration = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  delete configuration.roles['bug-fixer'].claude;
  const before = `${JSON.stringify(configuration, null, 2)}\n`;
  writeFileSync(defaultEnvironmentPath(paths), before);

  const validation = run(paths, 'validate');
  assert.equal(validation.status, 1);
  assert.match(validation.stderr, /bug-fixer\.claude must be an object/);
  assert.equal(readFileSync(defaultEnvironmentPath(paths), 'utf8'), before);
});

test('install rejects a conflicting inactive environment without writing any file', () => {
  const paths = environment();
  assert.equal(run(paths, 'init').status, 0);
  const config = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  const overlay = {
    version: 1,
    roles: {
      coding: { codex: { reasoning: 'low' } },
      [legacyPrimaryAgentId]: { codex: { reasoning: 'high' } }
    }
  };
  const overlayPath = environmentPath(paths, 'inactive');
  const before = `${JSON.stringify(overlay, null, 2)}\n`;
  writeFileSync(overlayPath, before);
  const sentinel = resolve(paths.config, 'ai-work-flow/agent-workflow.mjs');
  const agent = agentPath(paths, 'codex', 'coding', 'toml');
  mkdirSync(resolve(sentinel, '..'), { recursive: true });
  writeFileSync(sentinel, 'preserved runtime\n');
  mkdirSync(resolve(agent, '..'), { recursive: true });
  writeFileSync(agent, 'preserved agent\n');

  const result = install(paths);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /contains both roles\.orchestrator and roles\.coding/);
  assert.equal(JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8')).roles[legacyPrimaryAgentId], undefined);
  assert.equal(readFileSync(overlayPath, 'utf8'), before);
  assert.equal(readFileSync(sentinel, 'utf8'), 'preserved runtime\n');
  assert.equal(readFileSync(agent, 'utf8'), 'preserved agent\n');
});

test('install dry-run plans legacy primary migration without modifying configuration', () => {
  const paths = environment();
  assert.equal(run(paths, 'init').status, 0);
  const config = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  config.roles[legacyPrimaryAgentId] = config.roles.coding;
  delete config.roles.coding;
  const before = `${JSON.stringify(config, null, 2)}\n`;
  writeFileSync(defaultEnvironmentPath(paths), before);

  const result = run(paths, '--dry-run');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(defaultEnvironmentPath(paths), 'utf8'), before);
  assert.ok(!existsSync(agentPath(paths, 'codex', 'coding', 'toml')));
});

test('install rejects an existing partial planning role without modifying global files', () => {
  const paths = environment();
  assert.equal(run(paths, 'init').status, 0);
  const configuration = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  delete configuration.roles.planning.claude;
  const before = `${JSON.stringify(configuration, null, 2)}\n`;
  writeFileSync(defaultEnvironmentPath(paths), before);
  const sentinel = agentPath(paths, 'codex', 'coding', 'toml');
  mkdirSync(resolve(sentinel, '..'), { recursive: true });
  writeFileSync(sentinel, 'preserved agent\n');

  const result = install(paths);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /planning\.claude must be an object/);
  assert.equal(readFileSync(defaultEnvironmentPath(paths), 'utf8'), before);
  assert.equal(readFileSync(sentinel, 'utf8'), 'preserved agent\n');
  assert.ok(!existsSync(agentPath(paths, 'claude', 'planning', 'md')));
});

test('install rejects an existing partial task planner without modifying global files', () => {
  const paths = environment();
  assert.equal(run(paths, 'init').status, 0);
  const configuration = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  delete configuration.roles['task-planner'].claude;
  const before = `${JSON.stringify(configuration, null, 2)}\n`;
  writeFileSync(defaultEnvironmentPath(paths), before);
  const sentinel = agentPath(paths, 'codex', 'coding', 'toml');
  mkdirSync(resolve(sentinel, '..'), { recursive: true });
  writeFileSync(sentinel, 'preserved agent\n');

  const result = install(paths);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /task-planner\.claude must be an object/);
  assert.equal(readFileSync(defaultEnvironmentPath(paths), 'utf8'), before);
  assert.equal(readFileSync(sentinel, 'utf8'), 'preserved agent\n');
  assert.ok(!existsSync(agentPath(paths, 'claude', 'task-planner', 'md')));
});

test('a failed install plan leaves planning migration, runtime, assets, and agents untouched', () => {
  const paths = environment();
  assert.equal(run(paths, 'init').status, 0);
  const configuration = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  delete configuration.roles.planning;
  delete configuration.roles['task-planner'];
  const before = `${JSON.stringify(configuration, null, 2)}\n`;
  writeFileSync(defaultEnvironmentPath(paths), before);

  const runtime = resolve(paths.config, 'ai-work-flow/agent-workflow.mjs');
  const installedRoles = resolve(paths.config, 'ai-work-flow/config/roles.json');
  mkdirSync(resolve(installedRoles, '..'), { recursive: true });
  writeFileSync(runtime, 'preserved runtime\n');
  writeFileSync(installedRoles, 'preserved assets\n');
  const claudeMarker = resolve(paths.home, '.claude/CLAUDE.md');
  const invalidMarker = '<!-- ai-work-flow:agents:begin -->\n<!-- ai-work-flow:agents:begin -->\n';
  mkdirSync(resolve(claudeMarker, '..'), { recursive: true });
  writeFileSync(claudeMarker, invalidMarker);

  const result = install(paths);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot safely update workflow marker/);
  assert.equal(readFileSync(defaultEnvironmentPath(paths), 'utf8'), before);
  assert.equal(readFileSync(runtime, 'utf8'), 'preserved runtime\n');
  assert.equal(readFileSync(installedRoles, 'utf8'), 'preserved assets\n');
  assert.equal(readFileSync(claudeMarker, 'utf8'), invalidMarker);
  assert.ok(!existsSync(agentPath(paths, 'codex', 'planning', 'toml')));
  assert.ok(!existsSync(agentPath(paths, 'codex', 'task-planner', 'toml')));
});

test('install validates managed skill trees before committing planning migration or agents', () => {
  const paths = environment();
  assert.equal(run(paths, 'init').status, 0);
  const configuration = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  delete configuration.roles.planning;
  const before = `${JSON.stringify(configuration, null, 2)}\n`;
  writeFileSync(defaultEnvironmentPath(paths), before);

  const outside = resolve(paths.base, 'not-a-directory');
  writeFileSync(outside, 'preserved\n');
  mkdirSync(resolve(paths.home, '.codex'), { recursive: true });
  symlinkSync(outside, resolve(paths.home, '.codex/skills'));

  const result = install(paths);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /symbolic link|not a directory/);
  assert.equal(readFileSync(defaultEnvironmentPath(paths), 'utf8'), before);
  assert.equal(readFileSync(outside, 'utf8'), 'preserved\n');
  assert.ok(!existsSync(resolve(paths.config, 'ai-work-flow/agent-workflow.mjs')));
  assert.ok(!existsSync(agentPath(paths, 'codex', 'planning', 'toml')));
});

test('coding owns discovery routing while generated prompts retain it', () => {
  const routing = readFileSync(resolve(configDir, 'routing.md'), 'utf8');
  const source = readFileSync(resolve(templatesDir, 'coding.md'), 'utf8');
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);

  for (const content of [source]) {
    assert.match(content, /未知本地路径、文件搜索或枚举、代码地图、现有惯例或集成发现/);
    assert.match(content, /先委派 \*\*File Explorer\*\* 并等待其交接/);
    assert.match(content, /已有交接时可复用/);
    assert.match(content, /用户给出精确路径/);
    assert.match(content, /不得将发现阶段.*后续执行角色/);
  }
  assert.equal(
    readFileSync(resolve(paths.config, 'ai-work-flow/templates/coding.md'), 'utf8'),
    source
  );
  assert.equal(readFileSync(resolve(paths.config, 'ai-work-flow/routing.md'), 'utf8'), routing);
  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    const generated = generatedBody(paths, platform, 'coding', extension);
    assert.match(generated, /未知本地路径、文件搜索或枚举、代码地图、现有惯例或集成发现/, platform);
    assert.match(generated, /ai-work-flow:routing-digest=/, platform);
  }
  assert.doesNotMatch(routing, /未知本地路径、文件搜索或枚举、代码地图、现有惯例或集成发现/);
});

test('project navigation is a managed global skill and stores indexes in the project workflow directory', () => {
  const skill = readFileSync(resolve(root, 'skills/project-code-navigation/SKILL.md'), 'utf8');
  const routing = readFileSync(resolve(configDir, 'routing.md'), 'utf8');
  const coding = readFileSync(resolve(templatesDir, 'coding.md'), 'utf8');
  const explorer = readFileSync(resolve(templatesDir, 'file-explorer.md'), 'utf8');
  const coder = readFileSync(resolve(templatesDir, 'full-stack-coder.md'), 'utf8');
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);

  assert.match(skill, /^name: project-code-navigation$/m);
  assert.match(skill, /\.ai-work-flow\/index\//);
  assert.doesNotMatch(skill, /\.agents\/skills\/project-code-navigation/);
  for (const source of [coding, explorer, coder]) assert.match(source, /\.ai-work-flow\/index\//);
  assert.match(coding, /不得写入 `\.agents\/skills\/project-code-navigation\/`/);
  assert.match(skill, /不得执行全局文件检索/);
  assert.match(skill, /同一轮改动中更新对应索引/);
  assert.match(skill, /新功能缺少导航索引视为未完成/);
  assert.match(coding, /索引命中时直接使用记录的代码，禁止全局搜索无关路径/);
  assert.match(coding, /缺少索引的新功能视为未完成/);
  assert.doesNotMatch(routing, /project-code-navigation|\.ai-work-flow\/index\//);
  assert.equal(readFileSync(resolve(paths.config, 'ai-work-flow/routing.md'), 'utf8'), routing);
  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    assert.match(generatedBody(paths, platform, 'file-explorer', extension), /索引命中时交接其中记录的路径/);
    assert.match(generatedBody(paths, platform, 'full-stack-coder', extension), /同一轮改动中更新对应索引/);
  }
});

test('full stack coder delegates unknown file discovery to file explorer', () => {
  const coderRole = catalog.roles.find((role) => role.id === 'full-stack-coder');
  const coder = readFileSync(resolve(templatesDir, 'full-stack-coder.md'), 'utf8');
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);

  assert.deepEqual(coderRole.delegates, ['file-explorer']);
  assert.ok(coderRole.tools.includes('Task'));
  assert.ok(!coderRole.tools.includes('Glob'));
  assert.ok(!coderRole.tools.includes('Grep'));
  assert.equal(policies[coderRole.policy].delegation, 'allowed');
  assert.match(coder, /必须委派 \*\*File Explorer\*\* 并等待其交接/);
  assert.match(coder, /不得自行使用 Glob、Grep、`find`、`rg` 或同类命令检索/);
  assert.match(coder, /目标功能或问题、已知索引或路径、需要返回的路径和直接依赖/);
  assert.match(coder, /只读取交接路径及其直接依赖/);

  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    assert.match(generatedBody(paths, platform, 'full-stack-coder', extension), /必须委派 \*\*File Explorer\*\* 并等待其交接/, platform);
  }

  const claude = parseFrontmatter(readFileSync(agentPath(paths, 'claude', 'full-stack-coder', 'md'), 'utf8'));
  const openCode = parseFrontmatter(readFileSync(agentPath(paths, 'opencode', 'full-stack-coder', 'md'), 'utf8'));
  assert.ok(claude.tools.includes('Task'));
  assert.ok(!claude.tools.includes('Glob'));
  assert.ok(!claude.tools.includes('Grep'));
  assert.equal(openCode.permission.task, 'allow');
  assert.equal(openCode.permission.glob, 'deny');
  assert.equal(openCode.permission.grep, 'deny');
});

test('bug fixer is a narrowly governed coding subagent on every platform', () => {
  const role = catalog.roles.find((candidate) => candidate.id === 'bug-fixer');
  const coding = catalog.roles.find((candidate) => candidate.id === 'coding');
  const defaults = JSON.parse(readFileSync(resolve(configDir, 'default-config.json'), 'utf8'));
  const body = readFileSync(resolve(templatesDir, 'bug-fixer.md'), 'utf8');

  assert.equal(catalog.roles.length, 13);
  assert.equal(role.kind, 'subagent');
  assert.equal(role.policy, 'write-code');
  assert.deepEqual(role.delegates, ['file-explorer', 'git-operator', 'researcher', 'document-maintainer']);
  assert.deepEqual(role.tools, ['Read', 'Edit', 'Write', 'Bash', 'Task']);
  assert.ok(coding.delegates.includes('bug-fixer'));
  assert.ok(!role.delegates.includes('code-reviewer'));
  assert.deepEqual(defaults.roles['bug-fixer'], {
    codex: { model: 'gpt-5.6-luna', reasoning: 'max' },
    claude: { model: 'sonnet', effort: 'high' },
    opencode: { model: 'baibai/gpt-5.6-luna', variant: 'max', options: {} }
  });
  assert.match(body, /可复现 bug.*复现方式、预期行为和实际行为/s);
  assert.match(body, /当前评审结果、`blocking` 分类和用户明确批准的具体 finding IDs/);
  assert.match(body, /只修复获批 IDs/);
  assert.match(body, /不得自行评审.*不得委派 \*\*Code Reviewer\*\*/s);
  assert.match(body, /不得执行 Git mutation/);
  assert.match(body, /必须委派 \*\*File Explorer\*\*/);
  assert.match(body, /委派 \*\*Git Operator\*\*/);
  assert.match(body, /新的完整 committed range/);
  assert.match(body, /旧 finding 不得自动触发复审/);

  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);
  const codex = parseToml(readFileSync(agentPath(paths, 'codex', 'bug-fixer', 'toml'), 'utf8'));
  const claude = parseFrontmatter(readFileSync(agentPath(paths, 'claude', 'bug-fixer', 'md'), 'utf8'));
  const openCode = parseFrontmatter(readFileSync(agentPath(paths, 'opencode', 'bug-fixer', 'md'), 'utf8'));
  assert.equal(codex.model, 'gpt-5.6-luna');
  assert.equal(codex.model_reasoning_effort, 'max');
  assert.equal(claude.model, 'sonnet');
  assert.equal(claude.effort, 'high');
  assert.equal(openCode.model, 'baibai/gpt-5.6-luna');
  assert.equal(openCode.variant, 'max');
  assert.equal(openCode.permission.task, 'allow');
  assert.equal(openCode.permission.glob, 'deny');
  assert.equal(openCode.permission.grep, 'deny');

  const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
  const navigation = readFileSync(resolve(root, '.ai-work-flow/index/feature-navigation.md'), 'utf8');
  assert.match(readme, /Bug Fixer.*gpt-5\.6-luna.*max.*baibai\/gpt-5\.6-luna.*max.*sonnet.*high/);
  assert.match(navigation, /13 个受管理角色.*Bug Fixer/);
  assert.match(navigation, /agent-build\/templates\/bug-fixer\.md/);
});

test('coding routes only reproducible bugs or explicitly approved current blocking findings to bug fixer', () => {
  const coding = loadAgentAssets().compiledBodies.get('coding');
  const routing = readFileSync(resolve(configDir, 'routing.md'), 'utf8');
  assert.match(coding, /可复现 bug.*复现方式、预期行为和实际行为/s);
  assert.match(coding, /当前评审结果、blocking 分类和用户明确批准的具体 finding IDs/);
  assert.match(coding, /任一 finding 条件缺失、授权含糊或 ID 不属于当前评审结果时保持等待/);
  assert.match(coding, /只能修复获批 IDs，不得扩大到未授权 finding/);
  assert.match(coding, /普通功能实现继续委派 Full Stack Coder/);
  assert.match(coding, /仅按用户确认的 finding IDs 委派 Bug Fixer 修复/);
  assert.match(routing, /Bug Fixer.*同一隔离 worktree.*结构化交接契约/s);
  assert.match(routing, /不自行评审或执行 Git mutation/);
  assert.match(routing, /Git Operator 创建后继提交并同步/);
});

test('review roles declare one non-recursive aggregation hop', () => {
  const byId = new Map(catalog.roles.map((role) => [role.id, role]));
  const reviewer = readFileSync(resolve(templatesDir, 'code-reviewer.md'), 'utf8');

  assert.match(byId.get('code-reviewer').description, /仅由 Coding 调用/);
  assert.match(byId.get('code-reviewer').description, /双轴审查编排/);
  for (const role of ['review-standards', 'review-spec']) {
    assert.match(byId.get(role).description, /仅由 Code Reviewer 调用/);
    assert.match(byId.get(role).description, /终端/);
  }
  assert.match(reviewer, /不得将整个双轴审查任务再次委派给另一个 Code Reviewer 或其他聚合审查角色/);
  assert.deepEqual(byId.get('code-reviewer').delegates, ['review-standards', 'review-spec']);
  assert.deepEqual(byId.get('review-standards').delegates, []);
  assert.deepEqual(byId.get('review-spec').delegates, []);
});

test('generated delegation contracts prevent same-role recursion', () => {
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);

  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    const reviewer = generatedBody(paths, platform, 'code-reviewer', extension);
    assert.match(reviewer, /当前角色 ID 是 `code-reviewer`/, platform);
    assert.match(reviewer, /只允许委派以下角色 ID：`review-standards`、`review-spec`/, platform);
    assert.match(reviewer, /禁止委派当前角色 `code-reviewer`/, platform);

    for (const role of ['review-standards', 'review-spec']) {
      const leaf = generatedBody(paths, platform, role, extension);
      assert.ok(leaf.includes(`当前角色 ID 是 \`${role}\``), `${platform}/${role}`);
      assert.match(leaf, /此角色不得委派任何子代理/, `${platform}/${role}`);
    }
  }
});

test('workflow browser automation requires an explicit user request', () => {
  const routing = readFileSync(resolve(configDir, 'routing.md'), 'utf8');
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
    const prompt = loadAgentAssets().compiledBodies.get(role.id);
    for (const assertion of assertions) assert.match(prompt, assertion, role.id);
  }
});

test('planning workflow resolves material user decisions before writing a plan and waits for implementation confirmation', () => {
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);

  const planningWriter = readFileSync(resolve(templatesDir, 'planning-writer.md'), 'utf8');
  const coding = readFileSync(resolve(templatesDir, 'coding.md'), 'utf8');
  const compiledCoding = loadAgentAssets().compiledBodies.get('coding');

  assert.match(planningWriter, /\.ai-work-flow\/plans\/<plan-id>\/plan\.md/);
  assert.match(planningWriter, /不得实施/);
  assert.match(compiledCoding, /\*\*Planning Writer\*\* 写入计划/);
  for (const content of [compiledCoding]) {
    assert.match(content, /可通过工作区探索确认的事实委派 \*\*File Explorer\*\*/);
    assert.match(content, /会实质影响目标、范围、行为、取舍、兼容性、风险或验收标准/);
    assert.match(content, /每次只询问一个决策/);
    assert.match(content, /等待用户的明确回答/);
    assert.match(content, /所有已确认决策必须随任务交接给 \*\*Planning Writer\*\*/);
    assert.match(content, /没有此类未决决策时无需提问/);
    assert.match(content, /kebab-case `plan-id`/);
    assert.match(content, /\.ai-work-flow\/plans\/<plan-id>\/plan\.md/);
    assert.match(content, /等待用户明确确认/);
    assert.match(content, /不得自动.*实施/);
  }

  assert.equal(
    readFileSync(resolve(paths.config, 'ai-work-flow/templates/planning-writer.md'), 'utf8'),
    planningWriter
  );
  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    const generatedPlanningWriter = readFileSync(agentPath(paths, platform, 'planning-writer', extension), 'utf8');
    const generatedCoding = generatedBody(paths, platform, 'coding', extension);
    assert.match(platform === 'codex' ? codexDeveloperInstructions(generatedPlanningWriter) : generatedBody(paths, platform, 'planning-writer', extension), /\.ai-work-flow\/plans\/<plan-id>\/plan\.md/, platform);
    assert.match(platform === 'codex' ? codexDeveloperInstructions(generatedPlanningWriter) : generatedBody(paths, platform, 'planning-writer', extension), /不得实施/, platform);
    assert.match(generatedCoding, /每次只询问一个决策/, platform);
  }
  assert.match(coding, /每次只询问一个决策/);
});

test('planning writer fixed template keeps a blank line after every section heading', () => {
  const body = readFileSync(resolve(templatesDir, 'planning-writer.md'), 'utf8');
  const template = body.match(/```markdown\n([\s\S]*?)\n```/)?.[1];
  assert.ok(template, 'planning writer fixed template');
  for (const heading of [
    'Plan Metadata', 'Problem Statement', 'Solution', 'Goals and Success Criteria',
    'User Stories', 'Scope', 'Implementation Decisions', 'Implementation Changes',
    'Public Interfaces', 'Data Flow and Failure Modes', 'Testing Decisions',
    'Rollout and Compatibility', 'Out of Scope', 'Assumptions', 'Further Notes'
  ]) {
    assert.match(template, new RegExp(`^## ${heading}\\n\\n`, 'm'), heading);
  }
});

test('coding treats a tracked legacy flat plan as single-task input only', () => {
  const prompt = loadAgentAssets().compiledBodies.get('coding');
  assert.match(prompt, /已被 Git 跟踪.*`\.ai-work-flow\/plans\/<plan-id>\.md`.*旧平铺.*单任务/s);
  assert.match(prompt, /旧平铺计划.*不得.*tasks.*拆分/s);
  assert.match(prompt, /Planning.*只生成.*目录式/s);
  assert.match(prompt, /不得批量迁移/);
});

test('coding validates non-empty checkbox acceptance criteria before split execution', () => {
  const prompt = loadAgentAssets().compiledBodies.get('coding');
  assert.match(prompt, /`Acceptance Criteria`.*非空.*至少一个.*复选框/s);
  assert.match(prompt, /`- \[ \]`.*`- \[[xX]\]`/s);
  assert.match(prompt, /checklist.*Verification/s);
});

test('coding stops implementation when an approved plan needs to change', () => {
  const prompt = loadAgentAssets().compiledBodies.get('coding');
  assert.match(prompt, /实施开始后.*不得.*已批准.*plan.*不得委派 \*\*Planning Writer\*\*/s);
  assert.match(prompt, /需求变化.*停止当前实施.*Planning.*重新生成.*确认.*planning commit/s);
});

test('git operator rejects completed checkboxes from a planning commit', () => {
  const prompt = loadAgentAssets().compiledBodies.get('git-operator');
  assert.match(prompt, /planning commit.*所有存在的 checkbox.*未勾选/s);
  assert.match(prompt, /`\[x\]`.*`\[X\]`.*阻塞/s);
});

test('planning writer catalog and prompt describe only directory implementation plans', () => {
  const role = catalog.roles.find((candidate) => candidate.id === 'planning-writer');
  const prompt = loadAgentAssets().compiledBodies.get('planning-writer');
  assert.equal(role.description, '只负责写入目录式完整实施计划。');
  assert.match(prompt, /你是 \*\*Planning Writer\*\*。只负责写入目录式完整实施计划。/);
  assert.doesNotMatch(role.description, /ADR|交接|跟踪器/);
});

test('planning is an opt-in primary that delegates discovery and plan writing', () => {
  const planning = catalog.roles.find((role) => role.id === 'planning');
  const coding = catalog.roles.find((role) => role.id === 'coding');
  assert.equal(planning.kind, 'primary');
  assert.equal(planning.default_primary, undefined);
  assert.equal(coding.kind, 'primary');
  assert.equal(coding.default_primary, true);
  assert.deepEqual(planning.delegates, ['file-explorer', 'planning-writer', 'task-planner', 'git-operator']);
  assert.deepEqual(planning.tools, ['Task']);
  assert.deepEqual(policies[planning.policy], {
    filesystem: 'none',
    shell: 'none',
    network: 'none',
    browser: 'none',
    git: 'none',
    write_scope: 'none',
    delegation: 'allowed'
  });

  const defaults = JSON.parse(readFileSync(resolve(configDir, 'default-config.json'), 'utf8'));
  assert.deepEqual(defaults.roles.planning, {
    codex: { model: 'gpt-5.6-sol', reasoning: 'high' },
    claude: { model: 'opus', effort: 'high' },
    opencode: { model: 'baibai/gpt-5.6-sol', variant: 'high', options: {} }
  });
  assert.deepEqual(defaults.roles['planning-writer'], {
    codex: { model: 'gpt-5.6-terra', reasoning: 'medium' },
    claude: { model: 'opus', effort: 'high' },
    opencode: { model: 'baibai/gpt-5.6-terra', variant: 'medium', options: {} }
  });
});

test('researcher stores Markdown reports in a narrow project research directory', () => {
  const researcher = catalog.roles.find((role) => role.id === 'researcher');
  const policy = policies[researcher.policy];
  const prompt = loadAgentAssets().compiledBodies.get('researcher');
  assert.deepEqual(researcher.tools, ['WebSearch', 'WebFetch', 'Write']);
  assert.deepEqual(policy, {
    filesystem: 'write',
    shell: 'none',
    network: 'official',
    browser: 'none',
    git: 'none',
    write_scope: 'research',
    delegation: 'none'
  });
  assert.match(prompt, /只使用外部官方来源/);
  assert.match(prompt, /不得读取或枚举本地项目内容/);
  assert.match(prompt, /`\.ai-work-flow\/research\/<research-topic>\.md`/);
  assert.match(prompt, /`\.ai-work-flow\/research\/` 不存在时可以创建该目录，但不得创建其子目录/);
  assert.match(prompt, /Markdown/);

  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);
  const openCode = parseFrontmatter(readFileSync(agentPath(paths, 'opencode', 'researcher', 'md'), 'utf8'));
  assert.deepEqual(openCode.permission.edit, {
    '*': 'deny',
    '.ai-work-flow/research/*.md': 'allow',
    '.ai-work-flow/research/*/*.md': 'deny'
  });
  for (const key of ['read', 'glob', 'grep', 'bash']) assert.equal(openCode.permission[key], 'deny', key);
  for (const path of ['src/report.md', '.ai-work-flow/research/topic.txt', '.ai-work-flow/research/nested/topic.md']) {
    assert.equal(evaluateOpenCodePermission(researcher, policy, 'edit', path), 'deny', path);
  }
  assert.equal(evaluateOpenCodePermission(researcher, policy, 'edit', '.ai-work-flow/research/official-api.md'), 'allow');
});

test('install generates the task planner subagent on every platform', () => {
  const taskPlanner = catalog.roles.find((role) => role.id === 'task-planner');
  assert.equal(catalog.roles.length, 13);
  assert.equal(taskPlanner.kind, 'subagent');
  assert.deepEqual(taskPlanner.delegates, []);
  assert.equal(taskPlanner.policy, 'write-tasks');

  const defaults = JSON.parse(readFileSync(resolve(configDir, 'default-config.json'), 'utf8'));
  assert.ok(defaults.roles['task-planner']);

  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);
  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    assert.ok(existsSync(agentPath(paths, platform, 'task-planner', extension)), platform);
  }
});

test('task planning delegation and generated permissions stay narrowly scoped', () => {
  const planning = catalog.roles.find((role) => role.id === 'planning');
  const coding = catalog.roles.find((role) => role.id === 'coding');
  const taskPlanner = catalog.roles.find((role) => role.id === 'task-planner');
  assert.deepEqual(planning.delegates, ['file-explorer', 'planning-writer', 'task-planner', 'git-operator']);
  assert.ok(!coding.delegates.includes('task-planner'));
  assert.deepEqual(policies[taskPlanner.policy], {
    filesystem: 'write',
    shell: 'write',
    network: 'none',
    browser: 'none',
    git: 'none',
    write_scope: 'tasks',
    delegation: 'none'
  });

  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);
  const openCode = parseFrontmatter(readFileSync(agentPath(paths, 'opencode', 'task-planner', 'md'), 'utf8'));
  assert.deepEqual(openCode.permission.edit, {
    '*': 'deny',
    '.ai-work-flow/plans/*/tasks/??-*.md': 'allow',
    '.ai-work-flow/plans/*/tasks/*/*': 'deny'
  });
  assert.equal(openCode.permission.task, 'deny');
  assert.equal(capabilityMatrix('opencode', taskPlanner, policies[taskPlanner.policy]).write_scope, 'instruction-only');
});

test('planning prompt converges one decision at a time and writes the complete fixed plan template', () => {
  const body = readFileSync(resolve(templatesDir, 'planning.md'), 'utf8');
  const prompt = loadAgentAssets().compiledBodies.get('planning');
  const expectedSections = [
    'Plan Metadata',
    'Problem Statement',
    'Solution',
    'Goals and Success Criteria',
    'User Stories',
    'Scope',
    'Implementation Decisions',
    'Implementation Changes',
    'Public Interfaces',
    'Data Flow and Failure Modes',
    'Testing Decisions',
    'Rollout and Compatibility',
    'Out of Scope',
    'Assumptions',
    'Further Notes'
  ];
  const sectionPositions = expectedSections.map((heading) => body.indexOf(`## ${heading}`));

  assert.ok(sectionPositions.every((position) => position >= 0));
  assert.deepEqual([...sectionPositions].sort((left, right) => left - right), sectionPositions);
  assert.match(body, /status: `ready-for-implementation`/);
  assert.match(body, /不适用.*`N\/A`.*原因/);
  assert.match(body, /每次只询问一个/);
  assert.match(body, /每个 Planning 会话从 `问题 1：` 开始/);
  assert.match(body, /上一个问题的序号加一/);
  assert.match(body, /序号不得复用、跳号或重置/);
  assert.match(body, /共享理解确认、同名方案冲突等后续问题也必须延续当前序号/);
  assert.match(body, /推荐答案.*理由.*取舍/);
  assert.match(body, /目标、成功标准、受众、范围、约束、现状、接口、数据流、失败处理、测试、兼容、迁移和发布策略/);
  assert.match(body, /具体场景.*边界/);
  assert.match(prompt, /仓库事实.*委派 \*\*File Explorer\*\*/);
  assert.match(prompt, /可通过文件检索回答的问题不得转问用户/);
  assert.match(body, /用户明确确认.*共享理解/);
  assert.match(body, /\.ai-work-flow\/plans\/<plan-id>\/plan\.md/);
  assert.match(body, /同名.*完整更新.*更换 ID/);
  assert.match(body, /未经.*确认.*覆盖/);
  assert.match(body, /所有方案创建、覆盖、更新和保存/);
  assert.match(body, /Planning Writer/);
  assert.match(body, /不得直接写入任何文件/);
  assert.match(body, /只报告方案目录和计划文件路径/);
  assert.match(body, /提示用户打开文件查看/);
  assert.match(body, /不得输出完整计划正文/);
  assert.doesNotMatch(body, /\*\*计划内容：\*\*/);
  assert.match(prompt, /编码、修改源码或实施请求.*拒绝/);
  assert.match(prompt, /每个 Planning 会话从 `问题 1：` 开始/);
  assert.match(prompt, /同名方案冲突等后续问题也必须延续当前序号/);
  assert.match(prompt, /\*\*Planning Writer\*\* 不向用户提问/);
  assert.match(prompt, /Coding/);
  assert.doesNotMatch(prompt, /https?:\/\/|github\.com/i);
});

test('planning confirms plan splitting and commits only final planning artifacts', () => {
  const planning = readFileSync(resolve(templatesDir, 'planning.md'), 'utf8');
  const planningWriter = readFileSync(resolve(templatesDir, 'planning-writer.md'), 'utf8');
  const taskPlanner = readFileSync(resolve(templatesDir, 'task-planner.md'), 'utf8');

  assert.match(planning, /\.ai-work-flow\/plans\/<plan-id>\/plan\.md/);
  assert.match(planning, /只报告方案目录.*计划文件.*提示用户打开.*不得.*输出完整计划正文.*随后询问.*拆分.*不拆分/s);
  assert.match(planning, /不拆分.*不得创建 `tasks\/`.*一个 \*\*Full Stack Coder\*\*/s);
  assert.match(planning, /outcome.*blocked_by.*acceptance/s);
  assert.match(planning, /合并、拆细、调整依赖或验收/);
  assert.match(planning, /只生成完整任务草案.*不得创建、修改或删除任何 task 文件/s);
  assert.match(planning, /用户明确确认当前展示的完整任务草案后.*写入 `tasks\/`/s);
  assert.match(planning, /沉默、继续讨论、选择拆分或只确认收到草案.*不构成颗粒度确认/s);
  assert.match(planning, /plan.*digest.*全部失效.*重新生成/s);
  assert.match(planning, /main.*仅规划工件.*Git Operator/s);
  assert.match(planning, /planning commit.*SHA/);
  assert.match(planning, /不得实施/);

  assert.match(planningWriter, /\.ai-work-flow\/plans\/<plan-id>\/plan\.md/);
  assert.match(planningWriter, /唯一允许写入/);
  assert.match(planningWriter, /不得.*tasks\//s);
  assert.match(planningWriter, /ready-for-implementation/);
  assert.match(taskPlanner, /plan\.md.*File Explorer.*交接/s);
  assert.match(taskPlanner, /获准写入时.*只能写入.*\.ai-work-flow\/plans\/<plan-id>\/tasks\//s);
  assert.match(taskPlanner, /草案阶段.*不得创建、修改或删除任何 task 文件/s);
  assert.match(taskPlanner, /写入阶段.*完整任务草案.*用户已明确确认.*颗粒度/s);
  assert.match(taskPlanner, /校验待写内容与已确认草案完全一致/s);
});

test('task planner emits a deterministic dependency-safe task artifact contract', () => {
  const body = readFileSync(resolve(templatesDir, 'task-planner.md'), 'utf8');
  for (const field of ['task_id:', 'order:', 'blocked_by:', 'source_plan:', 'source_plan_digest:', 'write_scope:']) {
    assert.match(body, new RegExp(field), field);
  }
  for (const heading of ['Outcome', 'Implementation Checklist', 'Acceptance Criteria', 'Verification Steps', 'Out of Scope']) {
    assert.match(body, new RegExp(`^## ${heading}$`, 'm'), heading);
  }
  assert.match(body, /`NN-<short-name>\.md`/);
  assert.match(body, /`01`.*`99`/);
  assert.match(body, /short name.*lowercase kebab/);
  assert.match(body, /唯一且连续/);
  assert.match(body, /`task_id`.*唯一/);
  assert.match(body, /`blocked_by`.*较早.*task ID.*`none`.*不得成环/s);
  assert.match(body, /同一 frontier.*`write_scope`.*互斥/s);
  assert.match(body, /一个 \*\*Full Stack Coder\*\*.*一个上下文/s);
  assert.match(body, /expand.*migrate.*contract/s);
  assert.match(body, /source_plan: `\.\.\/plan\.md`/);
  assert.match(body, /`source_plan_digest`.*完整字节.*SHA-256/s);
  assert.match(body, /`tasks\/`.*只包含.*`NN-<short-name>\.md`/s);
  assert.match(body, /不得创建 `index\.md` 或其他文件/);
  assert.doesNotMatch(body, /^- plan_id:/m);
  assert.doesNotMatch(body, /^- plan_digest:/m);
  assert.doesNotMatch(body, /^---$/m);
});

test('task planner wraps each complete task artifact in a markdown fenced code block', () => {
  const source = readFileSync(resolve(templatesDir, 'task-planner.md'), 'utf8');
  const completeTaskFence = /```markdown\n# NN - <Task title>\n\n- task_id:[\s\S]*- order:[\s\S]*- blocked_by: `<task IDs or none>`\n- source_plan: `\.\.\/plan\.md`[\s\S]*- source_plan_digest:[\s\S]*- write_scope: `<exclusive paths or modules>`\n\n## Outcome[\s\S]*## Implementation Checklist\n\n- \[ \] 实施项[\s\S]*## Acceptance Criteria\n\n- \[ \][\s\S]*## Verification Steps\n\n- \[ \][\s\S]*## Out of Scope[\s\S]*```/;
  assert.match(source, completeTaskFence);
  assert.match(source, /不得在 fenced code block 外输出 task 文件正文/);

  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);
  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    const generated = generatedBody(paths, platform, 'task-planner', extension);
    assert.match(generated, completeTaskFence, platform);
    assert.match(generated, /不得在 fenced code block 外输出 task 文件正文/, platform);
  }
});

test('coding executes single or split plans through validated task frontiers', () => {
  const coding = readFileSync(resolve(templatesDir, 'coding.md'), 'utf8');
  const assertions = [
    /File Explorer.*plan\.md.*已被 Git 跟踪.*planning commit.*digest.*干净/s,
    /\$project-code-navigation/,
    /`tasks\/` 不存在.*单任务.*一个 \*\*Full Stack Coder\*\*/s,
    /`tasks\/` 存在但.*无效.*阻塞/s,
    /`blocked_by`.*frontier.*编号.*平台并发容量/s,
    /所有 Git 操作.*串行/,
    /同一 frontier.*相同的 feature HEAD/s,
    /`write_scope`.*导航索引.*自己的 task/s,
    /逐项证据.*checklist/s,
    /代码、测试、必要配置和 task checkbox.*同一 review commit/s,
    /task base.*task review.*父 `plan\.md`.*task.*spec/s,
    /勾选.*没有证据.*阻塞/s,
    /通过审查.*按编号.*汇入 feature/s,
    /用户确认的 finding IDs/,
    /阻塞修复后用户按统一门禁明确选择继续后续流程.*汇入 feature/s,
    /同一批.*结束.*不得启动新的依赖 task/s,
    /冲突.*一个 \*\*Full Stack Coder\*\*.*feature worktree.*验证.*评审/s,
    /最终.*同步.*main.*聚合.*双轴审查/s,
    /main.*未前进.*任一评审条件.*阻塞修复后用户按统一门禁明确选择继续后续流程/s,
    /main.*未前进.*--ff-only/s
  ];
  for (const assertion of assertions) assert.match(coding, assertion);
});

test('implementation roles preserve planning and task commit boundaries', () => {
  const coder = readFileSync(resolve(templatesDir, 'full-stack-coder.md'), 'utf8');
  const operator = readFileSync(resolve(templatesDir, 'git-operator.md'), 'utf8');
  const reviewer = readFileSync(resolve(templatesDir, 'code-reviewer.md'), 'utf8');
  const routing = readFileSync(resolve(configDir, 'routing.md'), 'utf8');

  assert.match(coder, /task 模式.*`write_scope`.*自己的 task checkbox/s);
  assert.match(coder, /不得.*其他 task/s);
  assert.match(coder, /逐项.*acceptance.*证据/s);

  assert.match(operator, /planning commit.*直接在 `main`/s);
  assert.match(operator, /仅规划工件.*精确 PathChange/s);
  assert.match(operator, /Planning Writer.*Task Planner.*交接.*一致/s);
  assert.match(operator, /task worktree.*task review commit.*按编号.*汇入/s);
  assert.match(operator, /所有 Git 操作.*串行/);
  assert.match(operator, /不得.*push.*amend.*reset.*clean.*隐式 stash.*跳过.*hook/s);

  assert.match(reviewer, /task base.*task review commit/s);
  assert.match(reviewer, /父 `plan\.md`.*当前 task.*spec/s);
  assert.match(reviewer, /checkbox.*逐项证据.*阻塞/s);
  assert.match(reviewer, /最终聚合.*feature.*完整 committed range/s);
  assert.match(routing, /所有 Git 操作.*串行/);
});

test('planning assets and generated prompts contain no outside planning references', () => {
  const restrictedTerms = [
    ['gr', 'ill-me'].join(''),
    ['gr', 'ill-with-docs'].join(''),
    ['writing-', 'great-skills'].join('')
  ];
  const paths = environment();
  assert.equal(install(paths).status, 0);
  const sourcePaths = repositoryOwnedArtifactPaths().filter((path) => (
    path.startsWith('agent-build/config/')
    || path.startsWith('agent-build/templates/')
    || path.startsWith('agent-build/runtime/')
    || path === 'README.md'
    || path === '.ai-work-flow/index/feature-navigation.md'
  ));
  const sources = sourcePaths.map((path) => readFileSync(resolve(root, path), 'utf8'));
  sources.push(readFileSync(resolve(root, 'test/agent-workflow.test.mjs'), 'utf8'));
  for (const role of catalog.roles) {
    for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
      sources.push(generatedBody(paths, platform, role.id, extension));
    }
  }

  for (const source of sources) {
    assert.doesNotMatch(source, /https?:\/\/|github\.com/i);
    for (const term of restrictedTerms) assert.ok(!source.toLowerCase().includes(term.toLowerCase()), term);
  }
});

test('all platforms generate a non-writing planning coordinator without changing the default primary', () => {
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);

  assert.ok(existsSync(agentPath(paths, 'codex', 'planning', 'toml')));
  assert.ok(existsSync(agentPath(paths, 'claude', 'planning', 'md')));
  const openCodePlanning = parseFrontmatter(readFileSync(agentPath(paths, 'opencode', 'planning', 'md'), 'utf8'));
  assert.equal(openCodePlanning.mode, 'primary');
  assert.equal(openCodePlanning.permission.read, 'deny');
  assert.equal(openCodePlanning.permission.glob, 'deny');
  assert.equal(openCodePlanning.permission.grep, 'deny');
  assert.equal(openCodePlanning.permission.bash, 'deny');
  assert.equal(openCodePlanning.permission.edit, 'deny');
  assert.equal(openCodePlanning.permission.task, 'allow');
  const planning = catalog.roles.find((role) => role.id === 'planning');
  for (const filePath of ['src/app.js', '.ai-work-flow/plans/ready-plan.md', '.ai-work-flow/plans/.md', '.ai-work-flow/plans/not valid.md', '.ai-work-flow/plans/nested/plan.md', '.ai-work-flow/plans/../../src/app.md']) {
    assert.equal(evaluateOpenCodePermission(planning, policies[planning.policy], 'edit', filePath), 'deny', filePath);
  }

  const claudePlanning = parseFrontmatter(readFileSync(agentPath(paths, 'claude', 'planning', 'md'), 'utf8'));
  assert.deepEqual(claudePlanning.tools, ['Task']);
  assert.equal(Object.hasOwn(claudePlanning, 'hooks'), false);
  assert.equal(capabilityMatrix('codex', planning, policies[planning.policy]).write_scope, 'instruction-only');
  assert.equal(capabilityMatrix('claude', planning, policies[planning.policy]).write_scope, 'instruction-only');
  assert.equal(capabilityMatrix('opencode', planning, policies[planning.policy]).write_scope, 'instruction-only');

  const planningWriter = catalog.roles.find((role) => role.id === 'planning-writer');
  assert.equal(capabilityMatrix('claude', planningWriter, policies[planningWriter.policy]).write_scope, 'instruction-only');
  assert.equal(capabilityMatrix('opencode', planningWriter, policies[planningWriter.policy]).write_scope, 'instruction-only');
  const claudePlanningWriter = parseFrontmatter(readFileSync(agentPath(paths, 'claude', 'planning-writer', 'md'), 'utf8'));
  const openCodePlanningWriter = parseFrontmatter(readFileSync(agentPath(paths, 'opencode', 'planning-writer', 'md'), 'utf8'));
  assert.equal(Object.hasOwn(claudePlanningWriter, 'hooks'), false);
  assert.equal(openCodePlanningWriter.permission.edit, 'allow');

  const openCode = JSON.parse(readFileSync(resolve(paths.config, 'opencode/opencode.json'), 'utf8'));
  assert.equal(openCode.default_agent, 'coding');
});

test('OpenCode derives its default agent from the role catalog', () => {
  const paths = environment();
  assert.equal(install(paths).status, 0);
  const rolePath = resolve(paths.config, 'ai-work-flow/config/roles.json');
  const installedCatalog = JSON.parse(readFileSync(rolePath, 'utf8'));
  installedCatalog.roles.find((role) => role.id === 'coding').default_primary = false;
  installedCatalog.roles.find((role) => role.id === 'planning').default_primary = true;
  writeFileSync(rolePath, `${JSON.stringify(installedCatalog, null, 2)}\n`);

  const generated = runInstalledWorkflow(paths, 'generate', '--platform', 'opencode');
  assert.equal(generated.status, 0, generated.stderr);
  const openCode = JSON.parse(readFileSync(resolve(paths.config, 'opencode/opencode.json'), 'utf8'));
  assert.equal(openCode.default_agent, 'planning');
});

test('structured dual-axis review controls the final integration gate', () => {
  const routing = readFileSync(resolve(configDir, 'routing.md'), 'utf8');
  const coding = readFileSync(resolve(templatesDir, 'coding.md'), 'utf8');
  const operator = readFileSync(resolve(templatesDir, 'git-operator.md'), 'utf8');
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);

  const assertions = [
    /最近同步的 `main_commit` 作为 fixed point/,
    /review commit 必须精确等于 feature HEAD/,
    /绝不审查未提交内容/,
    /blocking_findings/,
    /用户只能用确认的 finding IDs 选择修复/,
    /修复完成后必须再次同步并进入新的 `awaiting_user` 决策点/,
    /选择“再次执行 Code Reviewer 双轴评审”或“继续执行后续流程”/,
    /只有用户明确选择再次评审才能委派同一实施流程中的第二次 Code Reviewer/,
    /选择继续后续流程时直接进入后续阶段，不得因第一次评审遗留的 blocking findings 自动再次评审/,
    /基于修复后的干净 worktree 创建新的本地 review commit/,
    /新的 `review_commit` 必须不同于且后继于首次被拒的 `review_commit`/,
    /新的 `review_commit` 必须精确等于 feature 或 task HEAD/,
    /缺少新的完整 SHA、复用旧 SHA、不是旧 SHA 的后继或不等于当前 HEAD 时均阻塞/,
    /第二次完整双轴评审覆盖新的 committed range，不得限制为只复核旧 finding IDs/,
    /`git merge --ff-only <review_commit>`/,
  ];

  for (const content of [routing]) {
    for (const assertion of assertions) assert.match(content, assertion);
  }
  assert.doesNotMatch(routing, /修复完成后必须再次同步并自动最终复审一次/);
  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    const generated = generatedBody(paths, platform, 'coding', extension);
    assert.match(generated, /仅按用户确认的 finding IDs 委派 Bug Fixer 修复/, platform);
    assert.match(generated, /选择“再次执行 Code Reviewer 双轴评审”或“继续执行后续流程”/, platform);
    assert.match(generated, /只有用户明确选择再次评审才能委派同一实施流程中的第二次 Code Reviewer/, platform);
    assert.match(generated, /不得因第一次评审遗留的 blocking findings 自动再次评审/, platform);
    assert.match(generated, /新的 `review_commit` 必须不同于且后继于首次被拒的 `review_commit`/, platform);
    assert.match(generated, /缺少新的完整 SHA、复用旧 SHA、不是旧 SHA 的后继或不等于当前 HEAD 时均阻塞/, platform);
    assert.match(generated, /不得限制为只复核旧 finding IDs/, platform);
    assert.doesNotMatch(generated, /修复后重新同步并自动最终复审一次/, platform);
  }
  assert.match(coding, /仅按用户确认的 finding IDs 委派 Bug Fixer 修复/);
  assert.match(coding, /选择“再次执行 Code Reviewer 双轴评审”或“继续执行后续流程”/);
  assert.match(coding, /新的 `review_commit` 必须不同于且后继于首次被拒的 `review_commit`/);
  assert.match(coding, /缺少新的完整 SHA、复用旧 SHA、不是旧 SHA 的后继或不等于当前 HEAD 时均阻塞/);
  assert.match(coding, /不得限制为只复核旧 finding IDs/);
  assert.match(operator, /修复后的干净 feature 或 task worktree 创建新的本地 review commit/);
  assert.match(operator, /不得把旧 SHA 交给第二次 Code Reviewer/);
  assert.doesNotMatch(coding, /修复后重新同步并自动最终复审一次/);
  assert.doesNotMatch(coding, /ReviewManifest|git diff --no-ext-diff/);
});

test('review agents preserve the AI Work Flow committed-range contract', () => {
  const routing = readFileSync(resolve(configDir, 'routing.md'), 'utf8');
  const bodies = Object.fromEntries(['code-reviewer', 'review-standards', 'review-spec'].map((role) => [
    role,
    readFileSync(resolve(templatesDir, `${role}.md`), 'utf8')
  ]));
  const commands = [
    'git rev-parse <fixed-point>',
    'git rev-parse <review-commit>',
    'git status --short',
    'git diff <fixed-point>...<review-commit>',
    'git log <fixed-point>..<review-commit> --oneline'
  ];

  for (const command of commands) assert.ok(routing.includes(command), command);
  const compiledBodies = loadAgentAssets().compiledBodies;
  for (const [role, body] of Object.entries(bodies)) {
    const compiled = compiledBodies.get(role);
    assert.ok(compiled.includes('git diff <fixed-point>...<review-commit>'));
    assert.ok(compiled.includes('git log <fixed-point>..<review-commit> --oneline'));
    assert.match(body, /ReviewManifest/);
  }
  assert.match(routing, /完全相同的两个完整 SHA、diff 命令、commit list、规格来源、标准来源和完整文件\/窗口分片清单/);
  assert.match(routing, /禁止使用无参数 `git diff` 或 `git diff --cached`/);
  assert.match(routing, /审查目标 worktree 的 `HEAD` 必须精确等于 `review-commit`/);
  assert.match(routing, /输入 prompt 中的 range、commit list 或 changed paths 与 ReviewManifest 任一不一致时预检阻塞/);
  assert.match(routing, /不得使用工作树文件读取命令或工具作为 finding 证据/);
  assert.match(routing, /每项 finding 必须引用 ReviewManifest shard ID/);
  assert.match(routing, /引用 `git diff --no-ext-diff <fixed-point>\.\.\.<review-commit> -- <paths>` 的 hunk/);
  assert.match(routing, /只能使用 `git show <review-commit>:<path>`/);
  assert.match(routing, /不得基于 committed diff 之外的上下文新增 finding/);
  assert.match(bodies['code-reviewer'], /不得合并或跨轴重新排序/);
  assert.match(bodies['code-reviewer'], /工作树文件读取命令或工具/);
  assert.match(bodies['code-reviewer'], /ReviewManifest shard ID/);
  assert.match(bodies['code-reviewer'], /git show <review-commit>:<path>/);
  assert.match(compiledBodies.get('code-reviewer'), /只根据不可变 `ReviewManifest` 调度审查/);
  assert.match(compiledBodies.get('code-reviewer'), /在全新子会话中只重新发起被阻塞的评审一次/);
  assert.match(compiledBodies.get('code-reviewer'), /无需改变 ReviewManifest、digest、固定 SHA、分片范围、规格来源或标准来源/);
  assert.match(compiledBodies.get('code-reviewer'), /该次重试仍阻塞、失败或结果未知时，立即报告用户/);
  assert.doesNotMatch(bodies['code-reviewer'], /git rev-parse/);
  assert.doesNotMatch(bodies['code-reviewer'], /\$code-review|已安装时|未安装时|Matt/);
  assert.match(bodies['review-standards'], /缺少任一项时阻塞/);
  assert.match(bodies['review-standards'], /ReviewManifest shard ID/);
  assert.match(bodies['review-standards'], /git diff --no-ext-diff <fixed-point>\.\.\.<review-commit> -- <paths>/);
  assert.match(bodies['review-standards'], /git show <review-commit>:<path>/);
  assert.match(bodies['review-spec'], /缺少任一项时阻塞/);
  assert.match(bodies['review-spec'], /ReviewManifest shard ID/);
  assert.match(bodies['review-spec'], /git diff --no-ext-diff <fixed-point>\.\.\.<review-commit> -- <paths>/);
  assert.match(bodies['review-spec'], /git show <review-commit>:<path>/);

  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);
  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    const generatedOperator = generatedBody(paths, platform, 'git-operator', extension);
    assert.match(generatedOperator, /新的 `review_commit` 必须不同于且后继于首次被拒的 `review_commit`/, platform);
    assert.match(generatedOperator, /缺少新的完整 SHA、复用旧 SHA、不是旧 SHA 的后继或不等于当前 HEAD 时均阻塞/, platform);
    for (const role of Object.keys(bodies)) {
      const generated = generatedBody(paths, platform, role, extension);
      assert.ok(generated.includes('git diff <fixed-point>...<review-commit>'), `${platform}/${role}`);
      if (role === 'code-reviewer') {
        assert.match(generated, /在全新子会话中只重新发起被阻塞的评审一次/, platform);
        assert.match(generated, /该次重试仍阻塞、失败或结果未知时，立即报告用户/, platform);
      }
      assert.match(generated, /不得使用工作树文件读取命令或工具作为 finding 证据/, `${platform}/${role}`);
      assert.match(generated, /每项 finding 必须引用 ReviewManifest shard ID/, `${platform}/${role}`);
      assert.match(generated, /只能使用 `git show <review-commit>:<path>`/, `${platform}/${role}`);
      assert.match(generated, /审查目标 worktree 的 `HEAD` 必须精确等于 `review-commit`/, `${platform}/${role}`);
      assert.match(generated, /输入 prompt 中的 range、commit list 或 changed paths 与 ReviewManifest 任一不一致时预检阻塞/, `${platform}/${role}`);
    }
  }
});

test('routing is the sole source for retry and stop-lock governance', () => {
  const routing = readFileSync(resolve(configDir, 'routing.md'), 'utf8');
  const source = readFileSync(resolve(templatesDir, 'coding.md'), 'utf8');
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);

  const assertions = [
    /最多重试 2 次，共 3 次/,
    /可恢复的 429、502\/503\/504、超时、连接重置或结果未知/,
    /硬配额或计费耗尽的 429 不可重试/,
    /400\/401\/403\/404、参数或模型配置错误、子代理正常任务失败或测试失败、需求不清均不可重试/,
    /Code Reviewer 裁决后重试一次的叶子评审阻塞除外/,
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
    readFileSync(resolve(paths.config, 'ai-work-flow/templates/coding.md'), 'utf8'),
    source
  );
  assert.equal(readFileSync(resolve(paths.config, 'ai-work-flow/routing.md'), 'utf8'), routing);
  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    const generated = generatedBody(paths, platform, 'coding', extension);
    assert.match(generated, /最多重试 2 次，共 3 次/, platform);
  }
  assert.doesNotMatch(source, /最多重试 2 次，共 3 次/);
});

test('platform generation enforces the declared workspace access where supported', () => {
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);
  const reviewerRoles = new Set(['code-reviewer', 'review-standards', 'review-spec']);

  for (const role of catalog.roles) {
    const codex = readFileSync(agentPath(paths, 'codex', role.id, 'toml'), 'utf8');
    const claude = parseFrontmatter(readFileSync(agentPath(paths, 'claude', role.id, 'md'), 'utf8'));
    const openCode = parseFrontmatter(readFileSync(agentPath(paths, 'opencode', role.id, 'md'), 'utf8'));
    const policy = policies[role.policy];
    if (policy.filesystem === 'none' || policy.filesystem === 'read') {
      assert.match(codex, /sandbox_mode = "read-only"/, role.id);
      assert.equal(claude.permissionMode, 'plan', role.id);
    } else {
      assert.match(codex, /sandbox_mode = "workspace-write"/, role.id);
      assert.equal(claude.permissionMode, 'acceptEdits', role.id);
      if (role.id === 'task-planner') {
        assert.deepEqual(openCode.permission.edit, {
          '*': 'deny',
          '.ai-work-flow/plans/*/tasks/??-*.md': 'allow',
          '.ai-work-flow/plans/*/tasks/*/*': 'deny'
        }, role.id);
      } else if (role.id === 'researcher') {
        assert.deepEqual(openCode.permission.edit, {
          '*': 'deny',
          '.ai-work-flow/research/*.md': 'allow',
          '.ai-work-flow/research/*/*.md': 'deny'
        }, role.id);
      } else {
        assert.equal(openCode.permission.edit, role.tools.some((tool) => tool === 'Edit' || tool === 'Write') ? 'allow' : 'deny', role.id);
      }
    }
    if (policy.filesystem === 'none') {
      assert.equal(openCode.permission.read, 'deny', role.id);
      assert.equal(openCode.permission.edit, 'deny', role.id);
      assert.equal(openCode.permission.bash, 'deny', role.id);
    }
    if (reviewerRoles.has(role.id)) {
      const expectedTaskPermission = role.id === 'code-reviewer' ? 'allow' : 'deny';
      assert.equal(openCode.permission.bash, 'allow', role.id);
      assert.equal(openCode.permission.task, expectedTaskPermission, role.id);
    } else if (role.id === 'git-operator') {
      assert.deepEqual(openCode.permission.skill, { '*': 'deny', 'git-commit': 'allow' }, role.id);
    } else if (policy.filesystem === 'read') {
      assert.equal(openCode.permission.read, 'allow', role.id);
      assert.equal(openCode.permission.edit, 'deny', role.id);
      assert.equal(openCode.permission.bash, role.tools.includes('Bash') ? 'allow' : 'deny', role.id);
    }
  }
});

test('capability reporting reflects adapter limits and rejects invalid policy catalogs before writing', () => {
  const routing = readFileSync(resolve(configDir, 'routing.md'), 'utf8');
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(routing, /Policy 与能力边界|`delegation_targets` 单独表示|不得用 Task 开关代替/);
  assert.match(result.stdout, /CAPABILITY codex\/coding:.*filesystem=unsupported.*delegation=instruction-only/);
  assert.match(result.stderr, /WARNING codex\/coding:.*delegation=instruction-only/);
  const status = run(paths, 'env', 'status');
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /CAPABILITY opencode\/full-stack-coder:.*filesystem=enforced/);

  for (const platform of ['codex', 'claude', 'opencode']) {
    for (const role of catalog.roles) {
      const matrix = capabilityMatrix(platform, role, policies[role.policy]);
      assert.deepEqual(Object.keys(matrix).sort(), ['browser', 'delegation', 'delegation_targets', 'filesystem', 'git', 'network', 'shell', 'write_scope']);
      for (const [capability, level] of Object.entries(matrix)) {
        assert.ok(['enforced', 'instruction-only', 'unsupported'].includes(level), `${platform}/${role.id}/${capability}`);
        if (level !== 'enforced') assert.match(result.stderr, new RegExp(`WARNING ${platform}/${role.id}:[^\\n]*${capability}=${level}`));
      }
    }
  }
  assert.equal(capabilityMatrix('codex', catalog.roles[0], policies.coding).delegation, 'instruction-only');
  assert.equal(capabilityMatrix('codex', catalog.roles[0], policies.coding).delegation_targets, 'instruction-only');
  assert.equal(capabilityMatrix('codex', catalog.roles[0], policies.coding).filesystem, 'unsupported');
  const openCodeReviewer = capabilityMatrix('opencode', catalog.roles.find((role) => role.id === 'code-reviewer'), policies.review);
  assert.equal(openCodeReviewer.delegation, 'enforced');
  assert.equal(openCodeReviewer.delegation_targets, 'instruction-only');
  const targetEvidence = capabilityEvidence('opencode', catalog.roles.find((role) => role.id === 'code-reviewer'), policies.review).delegation_targets;
  assert.deepEqual(targetEvidence.requested, ['review-standards', 'review-spec']);
  assert.equal(targetEvidence.level, 'instruction-only');
  const openCodeLeaf = capabilityMatrix('opencode', catalog.roles.find((role) => role.id === 'review-standards'), policies.review);
  assert.equal(openCodeLeaf.delegation_targets, 'enforced');
  assert.equal(openCodeLeaf.shell, 'instruction-only');

  const generated = agentPath(paths, 'codex', 'coding', 'toml');
  const before = readFileSync(generated, 'utf8');
  const policyPath = resolve(paths.config, 'ai-work-flow/config/policies.json');
  const invalid = JSON.parse(readFileSync(policyPath, 'utf8'));
  invalid.policies.coding.unknown_capability = 'none';
  writeFileSync(policyPath, JSON.stringify(invalid));
  const failed = runInstalledWorkflow(paths, 'generate', '--platform', 'codex');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /unknown capability/);
  assert.equal(readFileSync(generated, 'utf8'), before);

  writeFileSync(policyPath, JSON.stringify({ version: 1, policies }));
  const invalidRoles = JSON.parse(readFileSync(resolve(paths.config, 'ai-work-flow/config/roles.json'), 'utf8'));
  invalidRoles.roles[0].delegates.push('missing-role');
  writeFileSync(resolve(paths.config, 'ai-work-flow/config/roles.json'), JSON.stringify(invalidRoles));
  const invalidDelegate = runInstalledWorkflow(paths, 'generate', '--platform', 'codex');
  assert.equal(invalidDelegate.status, 1);
  assert.match(invalidDelegate.stderr, /delegates to an unknown role/);
  assert.equal(readFileSync(generated, 'utf8'), before);
});

test('only writer bodies require git diff reporting', () => {
  const writers = new Set(['document-maintainer', 'planning-writer', 'task-planner', 'full-stack-coder', 'bug-fixer']);
  for (const role of catalog.roles) {
    const body = readFileSync(resolve(templatesDir, `${role.id}.md`), 'utf8');
    assert.equal(body.includes('git diff --name-only'), writers.has(role.id), role.id);
  }
});


test('generated agent descriptions prominently use their title-cased display names', () => {
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);
  const compiled = loadAgentAssets().compiledBodies;

  for (const role of catalog.roles) {
    const displayName = role.id.split('-').map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
    assert.equal(role.name, displayName);
    const description = `**${displayName}**: ${role.description}`;
    assert.ok(readFileSync(agentPath(paths, 'codex', role.id, 'toml'), 'utf8').includes(`description = ${JSON.stringify(description)}`));
    assert.ok(readFileSync(agentPath(paths, 'claude', role.id, 'md'), 'utf8').includes(`description: ${JSON.stringify(description)}`));
    assert.ok(readFileSync(agentPath(paths, 'opencode', role.id, 'md'), 'utf8').includes(`description: ${JSON.stringify(description)}`));
    assert.ok(readFileSync(resolve(templatesDir, `${role.id}.md`), 'utf8').includes(`你是 **${displayName}**。`));
    assert.ok(compiled.get(role.id).includes(`你是 **${displayName}**。`));
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
  assert.equal(opencode.default_agent, 'coding');
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
    const agent = parseFrontmatter(readFileSync(agentPath(paths, 'opencode', role.id, 'md'), 'utf8'));
    if (settings.model) assert.equal(agent.model, settings.model, role.id);
    if (settings.variant) assert.equal(agent.variant, settings.variant, role.id);
    assert.equal(Object.hasOwn(agent, 'formatter'), false, role.id);
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

test('generation removes only managed legacy primary agents on every platform', () => {
  const paths = environment();
  assert.equal(run(paths, 'init').status, 0);
  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    const path = agentPath(paths, platform, legacyPrimaryAgentId, extension);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, '<!-- ai-work-flow:routing-digest=legacy -->\nmanaged agent\n');
  }

  const result = run(paths, 'generate');
  assert.equal(result.status, 0, result.stderr);
  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    assert.ok(!existsSync(agentPath(paths, platform, legacyPrimaryAgentId, extension)));
    assert.ok(existsSync(agentPath(paths, platform, 'coding', extension)));
  }

  const custom = agentPath(paths, 'codex', legacyPrimaryAgentId, 'toml');
  writeFileSync(custom, 'custom agent\n');
  assert.equal(run(paths, 'generate', '--platform', 'codex').status, 0);
  assert.equal(readFileSync(custom, 'utf8'), 'custom agent\n');
});

test('Codex generation transaction removes only the legacy reviewer file and rejects symbolic links', () => {
  const paths = environment();
  assert.equal(run(paths, 'init').status, 0);
  const legacyDirectory = resolve(paths.home, '.codex/agents/code-reviewer');
  const legacyAgent = resolve(legacyDirectory, 'AGENT.md');
  const transaction = resolve(paths.home, '.codex/.legacy-reviewer-transaction.json');

  assert.equal(run(paths, 'generate', '--platform', 'codex').status, 0);
  assert.ok(!existsSync(legacyAgent));
  assert.ok(existsSync(agentPath(paths, 'codex', 'code-reviewer', 'toml')));

  mkdirSync(legacyDirectory, { recursive: true });
  writeFileSync(legacyAgent, 'legacy reviewer\n');
  const generated = run(paths, 'generate', '--platform', 'codex');
  assert.equal(generated.status, 0, generated.stderr);
  assert.ok(!existsSync(legacyAgent));
  assert.ok(existsSync(agentPath(paths, 'codex', 'code-reviewer', 'toml')));

  writeFileSync(legacyAgent, 'restore after rollback\n');
  assert.throws(() => applyTransaction([
    { type: 'delete', path: legacyAgent },
    { type: 'write', path: resolve(paths.home, '.codex/agents/rollback.txt'), contents: 'never committed\n' }
  ], { transactionPath: transaction, roots: [paths.home], failAfterStep: 1 }), /Injected transaction failure/);
  assert.equal(readFileSync(legacyAgent, 'utf8'), 'restore after rollback\n');
  assert.ok(!existsSync(transaction));

  const outside = resolve(paths.base, 'legacy-reviewer-target');
  writeFileSync(outside, 'preserve\n');
  rmSync(legacyAgent);
  symlinkSync(outside, legacyAgent);
  const rejected = run(paths, 'generate', '--platform', 'codex');
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Legacy reviewer path must not contain a symbolic link/);
  assert.equal(readFileSync(outside, 'utf8'), 'preserve\n');
  assert.ok(existsSync(agentPath(paths, 'codex', 'code-reviewer', 'toml')));

  rmSync(legacyAgent);
  rmSync(legacyDirectory, { recursive: true, force: true });
  const outsideDirectory = resolve(paths.base, 'legacy-reviewer-directory');
  mkdirSync(outsideDirectory);
  symlinkSync(outsideDirectory, legacyDirectory);
  const parentRejected = run(paths, 'generate', '--platform', 'codex');
  assert.equal(parentRejected.status, 1);
  assert.match(parentRejected.stderr, /Legacy reviewer path must not contain a symbolic link/);
  assert.ok(existsSync(agentPath(paths, 'codex', 'code-reviewer', 'toml')));
});

test('installation removes obsolete managed templates and execution modules', () => {
  const paths = environment();
  assert.equal(install(paths).status, 0);
  const obsoleteBody = resolve(paths.config, 'ai-work-flow/templates', `${legacyPrimaryAgentId}.md`);
  writeFileSync(obsoleteBody, 'obsolete body\n');
  for (const platformRoot of [resolve(paths.home, '.codex'), resolve(paths.home, '.claude'), resolve(paths.config, 'opencode')]) {
    const skillRoot = resolve(platformRoot, 'skills/run-matt-spec-to-completion');
    writeFileSync(resolve(skillRoot, 'lib', `execution-${legacyPrimaryAgentId}.mjs`), 'obsolete module\n');
    writeFileSync(resolve(skillRoot, 'test', `execution-${legacyPrimaryAgentId}.test.mjs`), 'obsolete test\n');
  }

  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(obsoleteBody));
  for (const platformRoot of [resolve(paths.home, '.codex'), resolve(paths.home, '.claude'), resolve(paths.config, 'opencode')]) {
    const skillRoot = resolve(platformRoot, 'skills/run-matt-spec-to-completion');
    assert.ok(!existsSync(resolve(skillRoot, 'lib', `execution-${legacyPrimaryAgentId}.mjs`)));
    assert.ok(!existsSync(resolve(skillRoot, 'test', `execution-${legacyPrimaryAgentId}.test.mjs`)));
    assert.ok(existsSync(resolve(skillRoot, 'lib/execution-coding.mjs')));
  }
});

test('installation removes obsolete managed Git Committer templates and generated agents', () => {
  const paths = environment();
  assert.equal(install(paths).status, 0);
  const obsoleteTemplate = resolve(paths.config, 'ai-work-flow/templates', `${legacyGitOperatorAgentId}.md`);
  writeFileSync(obsoleteTemplate, 'obsolete template\n');
  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    const currentAgent = agentPath(paths, platform, gitOperatorAgentId, extension);
    writeFileSync(agentPath(paths, platform, legacyGitOperatorAgentId, extension), readFileSync(currentAgent, 'utf8'));
  }

  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(obsoleteTemplate));
  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    assert.ok(!existsSync(agentPath(paths, platform, legacyGitOperatorAgentId, extension)), platform);
    assert.ok(existsSync(agentPath(paths, platform, gitOperatorAgentId, extension)), platform);
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
  assert.ok(!existsSync(agentPath(paths, 'codex', 'coding', 'toml')));

  const opencodeOnly = run(paths, 'generate', '--platform', 'opencode');
  assert.equal(opencodeOnly.status, 0, opencodeOnly.stderr);
  assert.ok(existsSync(agentPath(paths, 'opencode', 'coding', 'md')));
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
  const codexAgent = agentPath(paths, 'codex', 'coding', 'toml');
  const codexBefore = readFileSync(codexAgent, 'utf8');
  delete config.roles.researcher.claude;
  writeFileSync(defaultEnvironmentPath(paths), `${JSON.stringify(config)}\n`);
  const incompleteDefault = run(paths, 'generate', '--platform', 'codex');
  assert.equal(incompleteDefault.status, 1);
  assert.match(incompleteDefault.stderr, /researcher\.claude must be an object/);
  assert.equal(readFileSync(codexAgent, 'utf8'), codexBefore);

  Object.assign(config, completeConfig);
  config.roles.coding.claude.model = 'unsafe\npermissionMode: acceptEdits';
  writeFileSync(defaultEnvironmentPath(paths), `${JSON.stringify(config)}\n`);
  const rejected = run(paths, 'generate', '--platform', 'claude');
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /control character/);

  config.roles.coding.claude.model = 'safe-claude';
  config.roles.coding.claude.effort = 'invalid';
  writeFileSync(defaultEnvironmentPath(paths), `${JSON.stringify(config)}\n`);
  const codexOnly = run(paths, 'generate', '--platform', 'codex');
  assert.equal(codexOnly.status, 0, codexOnly.stderr);
  assert.equal(run(paths, 'validate').status, 1);

  config.roles.coding.claude.effort = 'medium';
  writeFileSync(defaultEnvironmentPath(paths), `${JSON.stringify(config)}\n`);
  writeFileSync(resolve(paths.config, 'ai-work-flow/environments/sparse.json'), JSON.stringify({
    version: 1,
    roles: { coding: { codex: { reasoning: 'low' }, opencode: { model: null, options: { temperature: 0 } } } }
  }));
  assert.equal(run(paths, 'env', 'use', 'sparse').status, 0);
  assert.equal(run(paths, 'generate', '--platform', 'codex,opencode').status, 0);
  const codex = readFileSync(agentPath(paths, 'codex', 'coding', 'toml'), 'utf8');
  const openCode = readFileSync(agentPath(paths, 'opencode', 'coding', 'md'), 'utf8');
  assert.match(codex, /model_reasoning_effort = "low"/);
  assert.doesNotMatch(openCode, /^model:/m);
  assert.match(openCode, /options: \{"temperature":0\}/);
});

test('validation and generation reject the obsolete primary role configuration', () => {
  const paths = environment();
  assert.equal(run(paths, 'init').status, 0);
  const config = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  config.roles[legacyPrimaryAgentId] = config.roles.coding;
  delete config.roles.coding;
  const before = `${JSON.stringify(config, null, 2)}\n`;
  writeFileSync(defaultEnvironmentPath(paths), before);

  const validation = run(paths, 'validate');
  assert.equal(validation.status, 1);
  assert.match(validation.stderr, new RegExp(`Unknown role: ${legacyPrimaryAgentId}`));
  assert.match(validation.stderr, /Missing configuration for role: coding/);
  assert.equal(readFileSync(defaultEnvironmentPath(paths), 'utf8'), before);
  const generation = run(paths, 'generate');
  assert.equal(generation.status, 1);
  assert.match(generation.stderr, new RegExp(`Unknown role: ${legacyPrimaryAgentId}`));
  assert.ok(!existsSync(agentPath(paths, 'codex', 'coding', 'toml')));
});

test('the installed asset catalog rejects inconsistent templates before generation writes', () => {
  const paths = environment();
  assert.equal(install(paths).status, 0);
  const generated = agentPath(paths, 'codex', 'coding', 'toml');
  writeFileSync(generated, 'preserved agent\n');
  writeFileSync(resolve(paths.config, 'ai-work-flow/templates/coding.md'), '');

  const validation = runInstalledWorkflow(paths, 'validate');
  assert.equal(validation.status, 1);
  assert.match(validation.stderr, /Agent asset catalog is invalid:[\s\S]*Template is empty: coding\.md/);

  const generation = runInstalledWorkflow(paths, 'generate', '--platform', 'codex');
  assert.equal(generation.status, 1);
  assert.match(generation.stderr, /Template is empty: coding\.md/);
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
  assert.ok(!existsSync(agentPath(paths, 'codex', 'coding', 'toml')));
  assert.ok(!existsSync(agentPath(paths, 'claude', 'coding', 'md')));
  assert.ok(!existsSync(agentPath(paths, 'opencode', 'coding', 'md')));
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
      coding: {
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
  
  const codingAgent = readFileSync(agentPath(paths, 'codex', 'coding', 'toml'), 'utf8');
  assert.match(codingAgent, /model = "env-codex"/);
  assert.match(codingAgent, /model_reasoning_effort = "low"/);
  
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

test('generation transaction restores a managed directory when a later step fails', () => {
  const directory = fixture();
  const managed = resolve(directory, 'managed-skill');
  const transaction = resolve(directory, 'transaction.json');
  mkdirSync(managed);
  writeFileSync(resolve(managed, 'old.txt'), 'old\n');

  assert.throws(() => applyTransaction([
    {
      type: 'tree',
      path: managed,
      entries: [
        { path: 'nested/new.txt', contents: 'new\n' },
        { path: 'SKILL.md', contents: 'managed\n' }
      ]
    },
    { type: 'write', path: resolve(directory, 'later.txt'), contents: 'later\n' }
  ], { transactionPath: transaction, roots: [directory], failAfterStep: 1 }), /Injected transaction failure/);

  assert.equal(readFileSync(resolve(managed, 'old.txt'), 'utf8'), 'old\n');
  assert.ok(!existsSync(resolve(managed, 'SKILL.md')));
  assert.ok(!existsSync(resolve(directory, 'later.txt')));
  assert.ok(!existsSync(transaction));
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
    roles: { coding: { codex: { reasoning: 'low' } } }
  }));
  const result = run(paths, 'env', 'use', 'staging');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(resolve(paths.config, 'ai-work-flow/.environment'), 'utf8'), 'staging');
  assert.deepEqual(JSON.parse(readFileSync(resolve(paths.config, 'ai-work-flow/.managed-platforms.json'), 'utf8')).platforms, ['claude', 'codex', 'opencode']);
  assert.match(readFileSync(agentPath(paths, 'codex', 'coding', 'toml'), 'utf8'), /model_reasoning_effort = "low"/);
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

function copiedAssets() {
  const dest = resolve(fixture(), 'agent-assets');
  cpSync(configDir, dest, { recursive: true });
  const templatesDest = resolve(fixture(), 'agent-assets-templates');
  cpSync(templatesDir, templatesDest, { recursive: true });
  return { config: dest, templates: templatesDest };
}

test('catalog compiles referenced routing sections and rejects invalid governance relationships', () => {
  const assets = loadAgentAssets();
  const compiled = assets.compiledBodies.get('coding');
  assert.match(compiled, /ai-work-flow:routing-digest=/);
  assert.match(compiled, /\*\*Coding\*\* 是默认的面向用户入口/);
  assert.match(assets.bodies.get('coding'), /\*\*Coding\*\* 是默认的面向用户入口/);

  for (const mutate of [
    (catalog) => { for (const role of catalog.roles) role.kind = 'subagent'; },
    (catalog) => { delete catalog.roles.find((role) => role.id === 'coding').default_primary; },
    (catalog) => { catalog.roles.find((role) => role.id === 'planning').default_primary = true; },
    (catalog) => {
      catalog.roles.find((role) => role.id === 'coding').default_primary = false;
      catalog.roles.find((role) => role.id === 'file-explorer').default_primary = true;
    },
    (catalog) => { catalog.roles.find((role) => role.id === 'file-explorer').delegates = ['coding']; },
    (catalog) => { catalog.roles.find((role) => role.id === 'researcher').tools = ['Bash']; },
    (catalog) => { catalog.roles[0].routing_sections = ['missing-section']; }
  ]) {
    const root = copiedAssets();
    const path = resolve(root.config, 'roles.json');
    const catalog = JSON.parse(readFileSync(path, 'utf8'));
    mutate(catalog);
    writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`);
    assert.throws(() => loadAgentAssets(root.config, root.templates), /Agent asset catalog is invalid/);
  }
});

test('catalog rejects declared delegation paths deeper than the platform limit', () => {
  const root = copiedAssets();
  const path = resolve(root.config, 'roles.json');
  const catalog = JSON.parse(readFileSync(path, 'utf8'));
  const standards = catalog.roles.find((role) => role.id === 'review-standards');
  standards.delegates = ['review-spec'];
  standards.tools.push('Task');
  writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`);

  assert.throws(
    () => loadAgentAssets(root.config, root.templates),
    /Role delegation exceeds max depth 2: coding -> code-reviewer -> review-standards -> review-spec/
  );
});

function parseFrontmatter(source) {
  const end = source.indexOf('\n---\n', 4);
  assert.ok(end > 4, 'frontmatter must end with a YAML delimiter');
  return YAML.parse(source.slice(4, end));
}

test('three platform renderers round-trip dynamic metadata and compiled bodies', () => {
  const paths = environment();
  assert.equal(run(paths, 'init').status, 0);
  const configuration = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  const role = configuration.roles.coding;
  role.codex.model = 'provider/quo"te:中文';
  role.claude.model = 'provider/quo"te:中文';
  role.opencode = {
    model: 'provider/quo"te:中文',
    variant: 'line: value',
    options: { nested: { values: ['a:b', '"quoted"'] } }
  };
  writeFileSync(defaultEnvironmentPath(paths), `${JSON.stringify(configuration, null, 2)}\n`);
  const result = run(paths, 'generate');
  assert.equal(result.status, 0, result.stderr);

  const assets = loadAgentAssets();
  const compiled = assets.compiledBodies.get('coding');
  const codex = parseToml(readFileSync(agentPath(paths, 'codex', 'coding', 'toml'), 'utf8'));
  const claude = parseFrontmatter(readFileSync(agentPath(paths, 'claude', 'coding', 'md'), 'utf8'));
  const opencode = parseFrontmatter(readFileSync(agentPath(paths, 'opencode', 'coding', 'md'), 'utf8'));
  assert.equal(codex.model, role.codex.model);
  assert.equal(codex.developer_instructions, compiled);
  assert.equal(claude.model, role.claude.model);
  assert.equal(opencode.model, role.opencode.model);
  assert.deepEqual(opencode.options, role.opencode.options);
  assert.equal(readFileSync(agentPath(paths, 'codex', 'coding', 'toml'), 'utf8').includes('\\\\n'), false);
});

test('OpenCode permissions deny every ungranted independent key', () => {
  const byId = new Map(catalog.roles.map((role) => [role.id, role]));
  const coding = byId.get('coding');
  const gitOperator = byId.get('git-operator');
  const reviewer = byId.get('review-standards');
  assert.equal(evaluateOpenCodePermission(coding, policies[coding.policy], 'task'), 'allow');
  for (const key of ['read', 'edit', 'glob', 'grep', 'bash', 'skill', 'webfetch', 'websearch', 'question', 'external_directory', 'unknown']) {
    assert.equal(evaluateOpenCodePermission(coding, policies[coding.policy], key), 'deny', key);
  }
  assert.equal(evaluateOpenCodePermission(gitOperator, policies[gitOperator.policy], 'skill', 'git-commit'), 'allow');
  assert.equal(evaluateOpenCodePermission(gitOperator, policies[gitOperator.policy], 'skill', 'unrelated-skill'), 'deny');
  assert.equal(evaluateOpenCodePermission(reviewer, policies[reviewer.policy], 'task'), 'deny');
  assert.equal(evaluateOpenCodePermission(reviewer, policies[reviewer.policy], 'bash'), 'allow');
  assert.equal(capabilityMatrix('opencode', reviewer, policies.review).shell, 'instruction-only');
});

test('OpenCode reviewer configuration permits the fixed git diff command declared by each role', () => {
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);
  const reviewers = catalog.roles.filter((role) => ['code-reviewer', 'review-standards', 'review-spec'].includes(role.id));

  for (const role of reviewers) {
    const agent = parseFrontmatter(readFileSync(agentPath(paths, 'opencode', role.id, 'md'), 'utf8'));
    assert.equal(agent.permission.bash, 'allow', role.id);
  }
  const diff = spawnSync('git', ['diff', '--no-ext-diff', 'HEAD...HEAD', '--', 'agent-build/runtime/platform-adapter.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(diff.status, 0, diff.stderr);
});

test('environment status compares planned bytes, detects drift and shadows, and never prints fixture secrets', () => {
  const paths = environment();
  assert.equal(install(paths).status, 0);
  const initial = run(paths, 'env', 'status');
  assert.equal(initial.status, 0, initial.stderr);
  assert.match(initial.stdout, /STATUS codex\/coding: in-sync reasons=none planned_digest=[0-9a-f]{64} installed_digest=[0-9a-f]{64}/);

  writeFileSync(agentPath(paths, 'claude', 'researcher', 'md'), 'tampered\n');
  rmSync(agentPath(paths, 'opencode', 'researcher', 'md'));
  mkdirSync(resolve(paths.project, '.codex/agents'), { recursive: true });
  writeFileSync(resolve(paths.project, '.codex/agents/coding.toml'), 'project shadow\n');
  mkdirSync(resolve(paths.project, '.opencode'), { recursive: true });
  writeFileSync(resolve(paths.project, '.opencode/opencode.json'), JSON.stringify({
    agent: { 'full-stack-coder': { token: 'fixture-secret-must-not-leak' } }
  }));
  writeFileSync(resolve(paths.config, 'ai-work-flow/.managed-platforms.json'), JSON.stringify({ version: 1, platforms: ['codex', 'claude'] }));
  writeFileSync(resolve(paths.home, '.codex/AGENTS.md'), '# User instructions without managed marker\n');
  writeFileSync(resolve(paths.home, '.codex/config.toml'), 'model = "user-model"\n[agents]\nmax_depth = 1\n');
  mkdirSync(resolve(paths.home, '.codex/agents/code-reviewer'), { recursive: true });
  writeFileSync(resolve(paths.home, '.codex/agents/code-reviewer/AGENT.md'), 'legacy reviewer override\n');
  const openCodeConfig = JSON.parse(readFileSync(resolve(paths.config, 'opencode/opencode.json'), 'utf8'));
  openCodeConfig.agent = { ...(openCodeConfig.agent ?? {}), researcher: { token: 'fixture-secret-must-not-leak' } };
  writeFileSync(resolve(paths.config, 'opencode/opencode.json'), `${JSON.stringify(openCodeConfig, null, 2)}\n`);

  const status = run(paths, 'env', 'status');
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /STATUS claude\/researcher: drifted reasons=bytes/);
  assert.match(status.stdout, /STATUS opencode\/researcher: shadowed reasons=manifest,missing,user-inline-agent/);
  assert.match(status.stdout, /STATUS codex\/coding: shadowed reasons=marker,config,project-agent/);
  assert.match(status.stdout, /STATUS codex\/code-reviewer: shadowed reasons=marker,config,legacy-reviewer-agent/);
  assert.match(status.stdout, /STATUS opencode\/full-stack-coder: shadowed reasons=manifest,project-inline-agent/);
  assert.match(status.stdout, /STATUS opencode\/researcher: shadowed reasons=manifest,missing,user-inline-agent/);
  assert.doesNotMatch(`${status.stdout}\n${status.stderr}`, /fixture-secret-must-not-leak/);
});
