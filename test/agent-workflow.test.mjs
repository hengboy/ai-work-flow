import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
import test from 'node:test';
import { parse as parseToml } from '@iarna/toml';
import YAML from 'yaml';

import { MARKER_END, MARKER_START, updateManagedMarker } from '../agent-build/runtime/managed-content.mjs';
import { loadAgentAssets } from '../agent-build/runtime/asset-catalog.mjs';
import { capabilityEvidence, capabilityMatrix, controlMatrix, evaluateOpenCodePermission } from '../agent-build/runtime/platform-adapter.mjs';
import { applyTransaction, recoverTransaction } from '../agent-build/runtime/transaction.mjs';
import { createRuntimeProvenance } from '../execution-runtime/lib/runtime-provenance.mjs';

const root = resolve(import.meta.dirname, '..');
const installer = resolve(root, 'agent-build/install.mjs');
const configDir = resolve(root, 'agent-build/config');
const templatesDir = resolve(root, 'agent-build/templates');
const executionSkill = `run-${['M', 'att'].join('').toLowerCase()}-spec-to-completion`;
const catalog = JSON.parse(readFileSync(resolve(configDir, 'roles.json'), 'utf8'));
const controls = JSON.parse(readFileSync(resolve(configDir, 'controls.json'), 'utf8')).controls;
const policies = JSON.parse(readFileSync(resolve(configDir, 'policies.json'), 'utf8')).policies;
const managedSkillDirectories = [
  'generate-ai-work-flow-agents',
  'switch-ai-work-flow-env',
  'project-code-navigation',
  'git-commit'
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
    assert.match(prose, /^## (?:交接格式|回复格式)$/m, `${name} needs an output format`);
    assert.match(prose, /\*\*(?:状态|阻塞|结果|更新|注意|需要你决定|实施结果)：\*\*|"status"|共享 JSON/, `${name} needs an output contract`);
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

function snapshotTree(path, root = path) {
  const entry = lstatSync(path);
  const relativePath = relative(root, path) || '.';
  if (entry.isSymbolicLink()) return [[relativePath, 'symbolic-link', readlinkSync(path)]];
  if (entry.isFile()) return [[relativePath, 'file', readFileSync(path, 'utf8')]];
  if (!entry.isDirectory()) return [[relativePath, 'other']];
  return [
    [relativePath, 'directory'],
    ...readdirSync(path).sort().flatMap((name) => snapshotTree(resolve(path, name), root))
  ];
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

test('every role compiles one ordered non-violation section from declared controls', () => {
  const assets = loadAgentAssets();
  assert.equal(catalog.version, 2);
  for (const role of catalog.roles) {
    assert.ok(role.controls.length > 0, role.id);
    assert.equal(new Set(role.controls).size, role.controls.length, role.id);
    const template = assets.bodies.get(role.id);
    const compiled = assets.compiledBodies.get(role.id);
    assert.equal((template.match(/^## 不可违反约束$/gm) ?? []).length, 1, role.id);
    assert.equal((template.match(/<!-- ai-work-flow:controls -->/g) ?? []).length, 1, role.id);
    assert.equal((compiled.match(/^## 不可违反约束$/gm) ?? []).length, 1, role.id);
    assert.ok(compiled.indexOf('## 职责结果') < compiled.indexOf('## 不可违反约束'), role.id);
    assert.ok(compiled.indexOf('## 不可违反约束') < compiled.indexOf('## 输入前置条件'), role.id);
    assert.match(compiled, new RegExp(`<!-- ai-work-flow:control-ids=${role.controls.join(',')} -->`), role.id);
    for (const controlId of role.controls) {
      const instruction = controls[controlId].instruction;
      assert.equal(compiled.split(instruction).length - 1, 1, `${role.id}/${controlId}`);
    }
  }
});

test('control matrix reports the weakest platform enforcement level', () => {
  const researcher = catalog.roles.find((role) => role.id === 'researcher');
  const researcherMatrix = controlMatrix('opencode', researcher, policies.research, controls);
  assert.equal(researcherMatrix['research-report-path-only'], 'enforced');
  assert.equal(researcherMatrix['official-research-only'], 'unsupported');
  assert.equal(researcherMatrix['single-research-report-only'], 'instruction-only');

  const reviewer = catalog.roles.find((role) => role.id === 'review-standards');
  const reviewerMatrix = controlMatrix('opencode', reviewer, policies.review, controls);
  assert.equal(reviewerMatrix['review-read-only'], 'instruction-only');
  assert.equal(reviewerMatrix['review-leaf-no-delegation'], 'enforced');
});

test('compiled governance is scoped to each role concern', () => {
  const assets = loadAgentAssets();
  const compiled = assets.compiledBodies;
  const expectedSections = {
    coding: ['browser-governance', 'retry-governance', 'planning-governance', 'orchestration-governance', 'change-handoff-governance', 'git-lifecycle-governance', 'review-orchestration-governance'],
    planning: ['browser-governance', 'retry-governance', 'planning-governance'],
    'file-explorer': ['browser-governance', 'handoff-governance'],
    researcher: ['browser-governance', 'handoff-governance'],
    'document-maintainer': ['browser-governance', 'handoff-governance'],
    'planning-writer': ['browser-governance', 'handoff-governance', 'planning-governance'],
    'task-planner': ['browser-governance', 'handoff-governance', 'planning-governance'],
    'full-stack-coder': ['browser-governance', 'retry-governance', 'handoff-governance', 'change-handoff-governance'],
    'bug-fixer': ['browser-governance', 'retry-governance', 'handoff-governance', 'change-handoff-governance'],
    'git-operator': ['browser-governance', 'planning-governance', 'handoff-governance', 'change-handoff-governance', 'git-lifecycle-governance'],
    'code-reviewer': ['browser-governance', 'retry-governance', 'handoff-governance', 'review-evidence-governance', 'review-orchestration-governance'],
    'review-standards': ['browser-governance', 'handoff-governance', 'review-evidence-governance'],
    'review-spec': ['browser-governance', 'handoff-governance', 'review-evidence-governance']
  };

  for (const role of assets.roles) {
    const prompt = compiled.get(role.id);
    assert.deepEqual(role.routing_sections, expectedSections[role.id], role.id);
    assert.match(prompt, /只有用户.*明确要求浏览器自动化.*E2E 测试.*视觉验证.*才能调用 Browser、Chrome DevTools、Playwright CLI/s, role.id);
    assert.doesNotMatch(prompt, /Playwright(?! CLI)/, role.id);
    assert.doesNotMatch(prompt, /Policy 与能力边界|`delegation_targets` 单独表示/, role.id);
    assert.doesNotMatch(assets.bodies.get(role.id), /XDG_CONFIG_HOME.*routing\.md/, role.id);
  }

  const retryRoles = new Set(['coding', 'planning', 'full-stack-coder', 'bug-fixer', 'code-reviewer']);
  const changeHandoffRoles = new Set(['coding', 'full-stack-coder', 'bug-fixer', 'git-operator']);
  const gitLifecycleRoles = new Set(['coding', 'git-operator']);
  const reviewRoles = new Set(['code-reviewer', 'review-standards', 'review-spec']);
  const handoffRoles = new Set(assets.roles.filter((role) => role.kind !== 'primary').map((role) => role.id));
  for (const role of assets.roles) {
    const prompt = compiled.get(role.id);
    assert.equal(prompt.includes('每个子任务的首次尝试最多重试 2 次'), retryRoles.has(role.id), `${role.id}: retry`);
    assert.equal(prompt.includes('初始状态必须为空'), changeHandoffRoles.has(role.id), `${role.id}: change handoff`);
    assert.equal(prompt.includes('Git mutation 必须串行'), gitLifecycleRoles.has(role.id), `${role.id}: git lifecycle`);
    assert.equal(prompt.includes('两个端点必须可解析'), reviewRoles.has(role.id), `${role.id}: review`);
    assert.equal(prompt.includes('"status": "done|blocked"'), handoffRoles.has(role.id), `${role.id}: handoff`);
  }

  assert.match(compiled.get('coding'), /只根据不可变 ReviewManifest 调度/);
  assert.doesNotMatch(compiled.get('coding'), /git diff --no-ext-diff/);
  assert.doesNotMatch(compiled.get('planning'), /review_commit|PathChange|ReviewManifest/);
  assert.doesNotMatch(compiled.get('researcher'), /review_commit|PathChange|ReviewManifest|每个子任务的首次尝试最多重试 2 次/);
  assert.match(assets.bodies.get('planning'), /收到编码或实施请求时引导用户在新会话使用 Coding/);
  assert.match(assets.routing, /section id="planning-governance"/);
  assert.doesNotMatch(assets.routing, /Policy 与能力边界|^## 回复格式$/m);
  const totalCompiledLength = [...compiled.values()].reduce((total, prompt) => total + prompt.length, 0);
  assert.ok(totalCompiledLength <= 53_000, `compiled prompts should stay focused, got ${totalCompiledLength} characters`);
});

test('coding has one deterministic transition for every implementation state', () => {
  const coding = readFileSync(resolve(templatesDir, 'coding.md'), 'utf8');
  const rows = [...coding.matchAll(/^\| `([^`]+)` \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)]
    .map((match) => ({ state: match[1], input: match[2].trim(), role: match[3].trim(), next: match[4].trim(), pause: match[5].trim() }));
  const expectedStates = [
    'discovery', 'ready_to_implement', 'implementing', 'ready_to_commit', 'ready_to_review',
    'review_passed', 'awaiting_finding_ids', 'fixing_findings', 'resync_required', 'complete'
  ];
  assert.deepEqual(rows.map((row) => row.state), expectedStates);
  assert.equal(new Set(rows.map((row) => row.state)).size, rows.length);
  for (const row of rows) {
    assert.ok(row.input.length > 0, `${row.state}: input`);
    assert.ok(row.role.length > 0, `${row.state}: role`);
    assert.ok(row.next.length > 0, `${row.state}: next`);
    assert.ok(row.pause.length > 0, `${row.state}: pause`);
  }
  assert.match(coding, /发现、委派、等待、验证、受控本地提交、同步、评审、整合和清理.*自动完成/s);
  assert.match(coding, /不得询问是否继续、是否提交或是否评审/);
  assert.doesNotMatch(coding, /请问是否继续|请问是否提交|请问是否评审/);
});

test('subagents return one JSON handoff envelope with role-specific details', () => {
  const compiled = loadAgentAssets().compiledBodies;
  for (const role of catalog.roles.filter((candidate) => candidate.kind !== 'primary')) {
    const prompt = compiled.get(role.id);
    for (const field of ['status', 'summary', 'artifacts', 'checks', 'details', 'blocking_reason']) {
      assert.match(prompt, new RegExp(`"${field}"`), `${role.id}: ${field}`);
    }
    assert.match(prompt, /仅供主代理消费的 JSON/, role.id);
  }
  assert.match(compiled.get('file-explorer'), /entry_paths.*direct_dependencies/s);
  for (const role of ['document-maintainer', 'planning-writer', 'task-planner']) {
    assert.match(compiled.get(role), /target.*changed_paths/s, role);
  }
  for (const role of ['full-stack-coder', 'bug-fixer']) {
    assert.match(compiled.get(role), /base_commit.*initial_status.*changed_paths.*acceptance_evidence/s, role);
  }
  assert.match(compiled.get('git-operator'), /full_commit_sha.*worktree_clean.*review_manifest.*manifest_digest.*bundle_digest/s);
  for (const role of ['review-standards', 'review-spec']) assert.match(compiled.get(role), /review_result/s, role);
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

  for (const [name, source] of entries) {
    assertPromptLayout(source, name, { replyFormat: !['docs/prompt-format.md', 'routing.md'].includes(name) });
  }
});

test('role bodies derive their common structure and reply sections from the catalog', () => {
  for (const role of catalog.roles) {
    const body = readFileSync(resolve(templatesDir, `${role.id}.md`), 'utf8');
    assert.match(body, new RegExp(`^# ${role.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), role.id);
    assert.match(body, new RegExp(`你是 \\*\\*${role.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*\\*。`), role.id);
    const positions = ['职责结果', '不可违反约束', '输入前置条件', '确定性工作流', '暂停条件', '交接格式']
      .map((heading) => body.indexOf(`## ${heading}`));
    assert.ok(positions.every((position) => position >= 0), `${role.id}: role interface headings`);
    assert.deepEqual(positions, [...positions].sort((left, right) => left - right), `${role.id}: role interface order`);
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
  }

  for (const [directory, prompt] of defaultSkillPrompts) {
    const source = readFileSync(resolve(root, 'skills', directory, 'agents/openai.yaml'), 'utf8');
    assert.ok(source.includes(`  default_prompt: ${JSON.stringify(prompt)}\n`), directory);
  }
  assert.equal(readFileSync(resolve(paths.config, 'ai-work-flow/routing.md'), 'utf8'), readFileSync(resolve(configDir, 'routing.md'), 'utf8'));
  assert.ok(existsSync(resolve(paths.config, 'ai-work-flow/execution-runtime/review-manifest-cli.mjs')));
  assert.ok(existsSync(resolve(paths.config, 'ai-work-flow/execution-runtime/lib/directory-review-manifest.mjs')));
  assert.ok(existsSync(resolve(paths.config, 'ai-work-flow/execution-runtime/lib/git.mjs')));
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
    /确认方案或要求实施即授权当前实现阶段创建仅本地 review commit/,
    /不需要首次暂存前再次授权/,
    /base_commit/,
    /`changed_paths: PathChange\[\]`/,
    /porcelain v2 `-z`/,
    /PathChange 全字段/,
    /同步、提交或验证失败时不启动审查/
  ];

  assert.match(gitOperator, /\$git-commit/);
  assert.match(compiled.get('git-operator'), /不再次请求授权/);
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
    assert.match(platform === 'codex' ? codexDeveloperInstructions(generatedOperator) : generatedBody(paths, platform, 'git-operator', extension), /不再次请求授权/, platform);
    assert.match(platform === 'codex' ? codexDeveloperInstructions(generatedCoding) : generatedBody(paths, platform, 'coding', extension), /普通目录式流程为/, platform);
  }
});

test('implementation commits precede the committed-range dual-axis review', () => {
  const routing = readFileSync(resolve(configDir, 'routing.md'), 'utf8');
  const coder = readFileSync(resolve(templatesDir, 'full-stack-coder.md'), 'utf8');
  const operator = readFileSync(resolve(templatesDir, 'git-operator.md'), 'utf8');
  const skill = readFileSync(resolve(root, 'skills/git-commit/SKILL.md'), 'utf8');
  const requiredScopeContract = [
    /初始状态必须为空/,
    /porcelain=v2 -z --untracked-files=all/,
    /changed_paths: PathChange\[\]/,
    /rename\/copy 必须保留两条 Git 原始路径/,
    /HEAD 变化/,
    /状态与交接不一致/
  ];

  assert.match(routing, /Full Stack Coder.*Git Operator.*Code Reviewer[\s\S]*Review Standards.*Review Spec/);
  assert.match(routing, /同步、提交或验证失败时不启动审查/);
  for (const assertion of requiredScopeContract) assert.match(routing, assertion);
  for (const assertion of requiredScopeContract.slice(0, 5)) assert.match(loadAgentAssets().compiledBodies.get('full-stack-coder'), assertion);
  assert.match(loadAgentAssets().compiledBodies.get('git-operator'), /参数数组与 `--` 暂存/);
  assert.match(loadAgentAssets().compiledBodies.get('git-operator'), /HEAD == base_commit/);
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
  assert.match(skill, /\*\*结果：\*\*/);
  assert.match(skill, /\*\*状态：\*\*/);
  assert.doesNotMatch(skill, /\*\*提交结果：\*\*/);
});

test('generated implementation and review roles preserve their scoped contracts', () => {
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);

  const implementationAssertions = [
    /Git Operator prepare -> Full Stack Coder -> Git Operator commit\/sync\/prepare\+verify -> Coding 验证原样交接 -> Code Reviewer independent verify -> Review Standards \+ Review Spec/,
    /不需要首次暂存前再次授权/,
    /base_commit/
  ];
  const reviewAssertions = [
    /fixed-point.*review-commit/s,
    /ReviewManifest shard ID/,
    /新会话重试一次/
  ];
  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    const coding = generatedBody(paths, platform, 'coding', extension);
    const reviewer = generatedBody(paths, platform, 'code-reviewer', extension);
    assert.match(coding, /absent 不含这些路径/, `${platform}/coding`);
    for (const assertion of implementationAssertions) assert.match(coding, assertion, `${platform}/coding`);
    for (const assertion of reviewAssertions) assert.match(reviewer, assertion, `${platform}/code-reviewer`);
  }
});

test('completed review findings keep blocking items and advice in separate user-facing sections', () => {
  const reviewerSource = readFileSync(resolve(templatesDir, 'code-reviewer.md'), 'utf8');
  const codingSource = readFileSync(resolve(templatesDir, 'coding.md'), 'utf8');
  const routing = readFileSync(resolve(configDir, 'routing.md'), 'utf8');
  const compiled = loadAgentAssets().compiledBodies;
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);

  assert.match(reviewerSource, /blocking_findings/);
  assert.match(reviewerSource, /advisory_findings/);
  assert.match(reviewerSource, /Standards、Spec 来源顺序/);
  assert.match(codingSource, /\*\*阻塞项：\*\*/);
  assert.match(codingSource, /\*\*建议：\*\*/);
  assert.match(codingSource, /保留 Standards、Spec 原顺序/);
  assert.match(routing, /advisory findings 只报告/);
  assert.match(routing, /不跨轴合并或重排/);

  assert.match(compiled.get('code-reviewer'), /blocking_findings/);
  assert.match(compiled.get('code-reviewer'), /advisory_findings/);
  assert.match(compiled.get('coding'), /\*\*阻塞项：\*\*/);
  assert.match(compiled.get('coding'), /\*\*建议：\*\*/);

  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    const reviewer = generatedBody(paths, platform, 'code-reviewer', extension);
    const coding = generatedBody(paths, platform, 'coding', extension);
    assert.match(reviewer, /blocking_findings/, `${platform}/code-reviewer`);
    assert.match(reviewer, /advisory_findings/, `${platform}/code-reviewer`);
    assert.match(coding, /\*\*阻塞项：\*\*/, `${platform}/coding`);
    assert.match(coding, /\*\*建议：\*\*/, `${platform}/coding`);
  }
});

test('completed plan implementation uses the fixed user-facing completion summary', () => {
  const codingSource = readFileSync(resolve(templatesDir, 'coding.md'), 'utf8');
  const compiled = loadAgentAssets().compiledBodies.get('coding');
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);

  const completionLabels = ['实施结果', '完成内容', '验证结果', '变更范围', '遗留事项'];
  const assertCompletionContract = (source, name) => {
    assert.match(source, /目录式 plan\/task 完成最终整合与清理且没有 blocking finding/, name);
    assert.match(source, /明确写“已经全部完成”/, name);
    assert.match(source, /实施结果.*plan 路径与最终提交/s, name);
    assert.match(source, /完成内容.*按 task 或能力汇总/s, name);
    assert.match(source, /验证结果.*测试、检查和双轴审查/s, name);
    assert.match(source, /变更范围.*关键路径或模块/s, name);
    assert.match(source, /遗留事项.*建议和未覆盖风险.*没有则写“无”/s, name);
    const positions = completionLabels.map((label) => source.indexOf(`**${label}：**`));
    assert.ok(positions.every((position) => position >= 0), `${name}: missing completion label`);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, `${name}: completion labels must keep fixed order`);
  };

  assertCompletionContract(codingSource, 'source');
  assertCompletionContract(compiled, 'compiled');
  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    assertCompletionContract(generatedBody(paths, platform, 'coding', extension), platform);
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
      if (entry.isDirectory() && existsSync(resolve(root, 'skills', entry.name, 'SKILL.md'))) {
        assert.ok(existsSync(resolve(platformRoot, 'skills', entry.name, 'SKILL.md')), entry.name);
      }
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

test('generation refreshes the shared review runtime with generated agents', () => {
  const paths = environment();
  assert.equal(install(paths).status, 0);
  const relativeCli = 'execution-runtime/review-manifest-cli.mjs';
  const installedCli = resolve(paths.config, 'ai-work-flow', relativeCli);
  const sourceCli = resolve(root, 'execution-runtime/review-manifest-cli.mjs');
  writeFileSync(installedCli, 'stale runtime\n');

  const generation = run(paths, 'generate');
  assert.equal(generation.status, 0, generation.stderr);
  assert.equal(readFileSync(installedCli, 'utf8'), readFileSync(sourceCli, 'utf8'));
});

test('runtime provenance installs atomically, detects drift and unknown legacy installs, and regenerates idempotently', () => {
  const paths = environment();
  const first = install(paths);
  assert.equal(first.status, 0, first.stderr);
  const runtimeRoot = resolve(paths.config, 'ai-work-flow/execution-runtime');
  const provenancePath = resolve(runtimeRoot, 'runtime-provenance.json');
  const sourceProvenance = readFileSync(resolve(root, 'execution-runtime/runtime-provenance.json'), 'utf8');
  assert.equal(readFileSync(provenancePath, 'utf8'), sourceProvenance);

  const installedCli = resolve(runtimeRoot, 'review-manifest-cli.mjs');
  mkdirSync(resolve(runtimeRoot, 'node_modules/cache'), { recursive: true });
  writeFileSync(resolve(runtimeRoot, 'node_modules/cache/package.json'), '{"name":"runtime-cache"}\n');
  const dependencyOnly = spawnSync(process.execPath, [installedCli, '--help'], {
    input: '', encoding: 'utf8', env: env(paths)
  });
  assert.equal(dependencyOnly.status, 0, dependencyOnly.stderr);

  const runtimeFile = resolve(runtimeRoot, 'lib/git.mjs');
  writeFileSync(runtimeFile, `${readFileSync(runtimeFile, 'utf8')}\n// drift\n`);
  const drifted = spawnSync(process.execPath, [installedCli, 'prepare', '--repository', paths.project], {
    input: '{}', encoding: 'utf8', env: env(paths)
  });
  assert.equal(drifted.status, 1);
  assert.match(drifted.stderr, /runtime files.*installed provenance/i);
  assert.match(drifted.stderr, /agent-build\/install\.mjs generate/);

  const repaired = run(paths, 'generate');
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.equal(readFileSync(provenancePath, 'utf8'), sourceProvenance);

  rmSync(provenancePath);
  const legacy = spawnSync(process.execPath, [installedCli, 'prepare', '--repository', paths.project], {
    input: '{}', encoding: 'utf8', env: env(paths)
  });
  assert.equal(legacy.status, 1);
  assert.match(legacy.stderr, /provenance is missing or unreadable/i);
  assert.equal(run(paths, 'generate').status, 0);

  const before = snapshotTree(resolve(paths.config, 'ai-work-flow'));
  const repeated = run(paths, 'generate');
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(snapshotTree(resolve(paths.config, 'ai-work-flow')), before);
});

test('runtime installation preserves a managed file named node_modules', () => {
  const sourceRoot = mkdtempSync(resolve(tmpdir(), 'agent-workflow-runtime-source-'));
  cpSync(resolve(root, 'agent-build'), resolve(sourceRoot, 'agent-build'), { recursive: true });
  cpSync(resolve(root, 'execution-runtime'), resolve(sourceRoot, 'execution-runtime'), { recursive: true });
  cpSync(resolve(root, 'skills'), resolve(sourceRoot, 'skills'), { recursive: true });
  symlinkSync(resolve(root, 'node_modules'), resolve(sourceRoot, 'node_modules'), 'dir');

  const sourceRuntime = resolve(sourceRoot, 'execution-runtime');
  writeFileSync(resolve(sourceRuntime, 'node_modules'), 'managed runtime entry\n');
  writeFileSync(resolve(sourceRuntime, 'runtime-provenance.json'), `${JSON.stringify(createRuntimeProvenance(sourceRuntime), null, 2)}\n`);

  const paths = environment();
  const result = spawnSync(process.execPath, [resolve(sourceRoot, 'agent-build/install.mjs')], {
    cwd: sourceRoot,
    encoding: 'utf8',
    env: env(paths)
  });
  assert.equal(result.status, 0, result.stderr);

  const installedRuntime = resolve(paths.config, 'ai-work-flow/execution-runtime');
  assert.equal(readFileSync(resolve(installedRuntime, 'node_modules'), 'utf8'), 'managed runtime entry\n');
  const runtimeCheck = spawnSync(process.execPath, [resolve(installedRuntime, 'review-manifest-cli.mjs'), '--help'], {
    encoding: 'utf8',
    env: env(paths)
  });
  assert.equal(runtimeCheck.status, 0, runtimeCheck.stderr);
});

test('generated roles preserve the one-envelope prepare verify handoff and semantic retry gates on all platforms', () => {
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);
  const explorer = loadAgentAssets().compiledBodies.get('file-explorer');
  assert.match(explorer, /不得 prepare、verify、构造、修改或转交 ReviewManifest envelope/);

  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    const operator = generatedBody(paths, platform, 'git-operator', extension);
    const coding = generatedBody(paths, platform, 'coding', extension);
    const reviewer = generatedBody(paths, platform, 'code-reviewer', extension);
    assert.match(operator, /保存 stdout.*verify --repository <review-worktree>/s, platform);
    assert.match(operator, /禁摘要\/删改\/重建\/fallback/, platform);
    assert.match(coding, /唯一机器 envelope.*runtime_provenance.*prepare_verification/s, platform);
    assert.match(coding, /只核对交接完整自洽.*原样交 Code Reviewer/s, platform);
    assert.match(reviewer, /逐项对应用户需求\/批准标准.*acceptance_evidence.*verification/s, platform);
    assert.match(reviewer, /“CLI 能运行”等无关证据.*blocking_reason/s, platform);
    assert.match(reviewer, /结构\/协议\/provenance.*语义失败不重试/s, platform);
    assert.match(reviewer, /瞬时错误.*停止旧会话后重试/s, platform);
  }
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

test('install atomically adds a completely missing planning writer with spec-first defaults', () => {
  const paths = environment();
  assert.equal(run(paths, 'init').status, 0);
  const configuration = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  delete configuration.roles['planning-writer'];
  writeFileSync(defaultEnvironmentPath(paths), `${JSON.stringify(configuration, null, 2)}\n`);

  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);
  const migrated = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  const defaults = JSON.parse(readFileSync(resolve(configDir, 'default-config.json'), 'utf8'));
  assert.deepEqual(migrated.roles['planning-writer'], defaults.roles['planning-writer']);
  assert.match(readFileSync(agentPath(paths, 'codex', 'planning-writer', 'toml'), 'utf8'), /source_spec_digest/);
  assert.match(readFileSync(agentPath(paths, 'claude', 'planning-writer', 'md'), 'utf8'), /规格元数据/);
  assert.match(readFileSync(agentPath(paths, 'opencode', 'planning-writer', 'md'), 'utf8'), /开放问题/);
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
  assert.ok(!existsSync(resolve(paths.config, 'ai-work-flow/execution-runtime/runtime-provenance.json')));
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

  assert.match(source, /`discovery`.*File Explorer.*返回入口后分类请求/s);
  assert.match(source, /File Explorer 读取 `\.ai-work-flow\/index\/` 并聚焦发现/);
  assert.match(source, /Full Stack Coder.*随实现维护索引/);
  assert.equal(
    readFileSync(resolve(paths.config, 'ai-work-flow/templates/coding.md'), 'utf8'),
    source
  );
  assert.equal(readFileSync(resolve(paths.config, 'ai-work-flow/routing.md'), 'utf8'), routing);
  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    const generated = generatedBody(paths, platform, 'coding', extension);
    assert.match(generated, /File Explorer 读取 `\.ai-work-flow\/index\/` 并聚焦发现/, platform);
    assert.match(generated, /ai-work-flow:routing-digest=/, platform);
  }
  assert.match(routing, /所有文件检索、未知路径定位和代码导航索引读取必须交由 File Explorer 执行/);
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
  assert.match(skill, /只读定位模式/);
  assert.match(skill, /所有文件检索必须交由 File Explorer 执行/);
  assert.doesNotMatch(skill, /其他发现角色/);
  assert.match(skill, /随实现维护模式/);
  assert.match(skill, /不得执行全局文件检索/);
  assert.match(skill, /同一轮改动中更新对应索引/);
  assert.match(skill, /新功能缺少导航索引视为未完成/);
  assert.match(explorer, /索引命中时直接验证记录路径，不扩大搜索/);
  assert.match(coder, /新功能缺少索引视为未完成/);
  assert.match(routing, /所有文件检索、未知路径定位和代码导航索引读取必须交由 File Explorer 执行/);
  assert.equal(readFileSync(resolve(paths.config, 'ai-work-flow/routing.md'), 'utf8'), routing);
  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    assert.match(generatedBody(paths, platform, 'file-explorer', extension), /索引命中时直接验证记录路径/);
    assert.match(generatedBody(paths, platform, 'full-stack-coder', extension), /同步更新 `\.ai-work-flow\/index\/`/);
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
  assert.match(coder, /未知路径先委派 File Explorer/);
  assert.match(coder, /先读 `\.ai-work-flow\/index\/`.*聚焦发现/s);
  assert.match(coder, /返回入口与直接依赖/);
  assert.match(coder, /只读取上游精确路径、File Explorer 返回路径及直接依赖/);

  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    assert.match(generatedBody(paths, platform, 'full-stack-coder', extension), /未知路径先委派 File Explorer/, platform);
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
  const compiled = loadAgentAssets().compiledBodies.get('bug-fixer');

  assert.equal(catalog.roles.length, 13);
  assert.equal(role.kind, 'subagent');
  assert.equal(role.policy, 'write-code');
  assert.ok(role.controls.includes('authorized-bug-or-finding-only'));
  assert.ok(!role.controls.includes('approved-findings-only'));
  assert.deepEqual(role.delegates, ['file-explorer', 'git-operator', 'researcher', 'document-maintainer']);
  assert.deepEqual(role.tools, ['Read', 'Edit', 'Write', 'Bash', 'Task']);
  assert.ok(coding.delegates.includes('bug-fixer'));
  assert.ok(!role.delegates.includes('code-reviewer'));
  assert.deepEqual(defaults.roles['bug-fixer'], {
    codex: { model: 'gpt-5.6-luna', reasoning: 'max' },
    claude: { model: 'sonnet', effort: 'high' },
    opencode: { model: 'baibai/gpt-5.6-luna', variant: 'max', options: {} }
  });
  assert.match(body, /bug 必须有复现方式、预期和实际行为/);
  assert.match(body, /当前审查结果、blocking 分类和获批 IDs/);
  assert.match(compiled, /Bug Fixer 只修复用户直接给出的 bug 或获批 blocking finding IDs/);
  assert.match(body, /未知路径委派 File Explorer/);
  assert.match(body, /Git Operator 执行/);
  assert.match(body, /普通目录式 finding 修复.*不执行第二次评审/s);

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
  assert.match(navigation, /13 个角色.*JSON handoff/);
  assert.match(navigation, /agent-build\/templates\/bug-fixer\.md/);
});

test('coding routes user-reported bugs or explicitly approved current blocking findings to bug fixer', () => {
  const coding = loadAgentAssets().compiledBodies.get('coding');
  const routing = readFileSync(resolve(configDir, 'routing.md'), 'utf8');
  assert.match(coding, /bug 需要可执行复现、预期与实际行为/);
  assert.match(coding, /finding 修复需要当前审查结果、blocking 分类和用户批准的具体 finding IDs/);
  assert.match(coding, /Bug Fixer 只处理用户直接给出的 bug 或获批 finding IDs/);
  assert.match(coding, /用户在 Coding 中直接给出 bug.*必须委派 Bug Fixer.*不得改派 Full Stack Coder.*输入不足.*Bug Fixer.*blocked/s);
  assert.match(coding, /`ready_to_implement`.*用户直接给出的 bug 授权.*bug 委派 Bug Fixer/s);
  assert.match(coding, /`implementing`.*Full Stack Coder 或 Bug Fixer/s);
  assert.match(coding, /`fixing_findings`.*Bug Fixer/s);
  assert.match(routing, /blocking finding.*用户必须确认具体 finding IDs/s);
  assert.match(routing, /Git Operator.*Git mutation/s);
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
  assert.match(loadAgentAssets().compiledBodies.get('code-reviewer'), /Code Reviewer 只能委派 Review Standards 和 Review Spec/);
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
    /只有用户在当前请求中明确要求浏览器自动化、E2E 测试或视觉验证时.*才能调用 Browser、Chrome DevTools、Playwright CLI 或操作可见浏览器/s,
    /仓库存在前端或 E2E 配置不构成授权/,
    /获准后默认使用无头模式/
  ];

  for (const assertion of assertions) assert.match(routing, assertion);
  assert.equal(readFileSync(resolve(paths.config, 'ai-work-flow/routing.md'), 'utf8'), routing);
  for (const role of catalog.roles) {
    const prompt = loadAgentAssets().compiledBodies.get(role.id);
    for (const assertion of assertions) assert.match(prompt, assertion, role.id);
    assert.doesNotMatch(prompt, /Playwright(?! CLI)/, role.id);
  }
});

test('planning workflow persists an approved spec before its digest-bound plan', () => {
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);

  const planningWriter = readFileSync(resolve(templatesDir, 'planning-writer.md'), 'utf8');
  const coding = readFileSync(resolve(templatesDir, 'coding.md'), 'utf8');
  const compiledCoding = loadAgentAssets().compiledBodies.get('coding');

  assert.match(planningWriter, /\.ai-work-flow\/plans\/<plan-id>\/spec\.md.*同目录 `plan\.md`/s);
  assert.match(planningWriter, /不得执行 Git mutation/);
  assert.match(planningWriter, /## Spec 模板/);
  assert.match(planningWriter, /## Plan 模板/);
  assert.match(compiledCoding, /`source_spec_digest`/);
  assert.match(compiledCoding, /规划或需求变化转交 Planning/);
  assert.match(compiledCoding, /有效 planning commit 加实施授权/);

  assert.equal(
    readFileSync(resolve(paths.config, 'ai-work-flow/templates/planning-writer.md'), 'utf8'),
    planningWriter
  );
  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    const generatedPlanningWriter = readFileSync(agentPath(paths, platform, 'planning-writer', extension), 'utf8');
    const generatedCoding = generatedBody(paths, platform, 'coding', extension);
    assert.match(platform === 'codex' ? codexDeveloperInstructions(generatedPlanningWriter) : generatedBody(paths, platform, 'planning-writer', extension), /source_spec_digest/, platform);
    assert.match(platform === 'codex' ? codexDeveloperInstructions(generatedPlanningWriter) : generatedBody(paths, platform, 'planning-writer', extension), /禁止 Git mutation/, platform);
    assert.match(generatedCoding, /旧平铺计划.*一律拒绝/s, platform);
  }
  assert.match(coding, /原始完整字节.*SHA-256/s);
});

test('planning writer fixed spec and plan templates keep ordered sections and blank lines', () => {
  const body = readFileSync(resolve(templatesDir, 'planning-writer.md'), 'utf8');
  const templates = [...body.matchAll(/```markdown\n([\s\S]*?)\n```/g)].map((match) => match[1]);
  assert.equal(templates.length, 2);
  const [specTemplate, planTemplate] = templates;
  const specSections = [
    '规格元数据', '问题陈述', '目标与成功标准', '用户与用户故事',
    '功能需求', '非功能需求', '范围', '接口与数据',
    '失败模式', '验收标准', '兼容性与迁移', '范围外事项',
    '假设', '开放问题'
  ];
  const planSections = [
    '计划元数据', '技术与代码上下文', '实施方案', '顺序执行步骤',
    '任务边界与依赖', '具体改动', '接口与数据流', '失败处理',
    '测试与验证', '兼容、迁移与发布'
  ];
  for (const [template, sections] of [[specTemplate, specSections], [planTemplate, planSections]]) {
    const positions = sections.map((heading) => template.indexOf(`## ${heading}`));
    assert.ok(positions.every((position) => position >= 0));
    assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
    for (const heading of sections.slice(0, -1)) assert.match(template, new RegExp(`^## ${heading}\\n\\n`, 'm'));
    assert.match(template, new RegExp(`^## ${sections.at(-1)}(?:\\n\\n|\\n?$)`, 'm'));
  }
  assert.match(specTemplate, /- status: `approved`[\s\S]*## 开放问题\n\nN\/A$/);
  assert.match(planTemplate, /source_spec: `\.ai-work-flow\/plans\/<plan-id>\/spec\.md`/);
  assert.match(planTemplate, /source_spec_digest: `<sha256-lowercase-hex>`/);
  assert.match(planTemplate, /task_mode: `<split\|single>`/);
  for (const duplicatedSection of ['问题陈述', '目标与成功标准', '用户故事', '范围', '范围外事项', '假设']) {
    assert.doesNotMatch(planTemplate, new RegExp(`^## ${duplicatedSection}$`, 'm'), duplicatedSection);
  }
});

test('coding rejects legacy flat and plan-only planning artifacts', () => {
  const prompt = loadAgentAssets().compiledBodies.get('coding');
  assert.match(prompt, /`\.ai-work-flow\/plans\/<plan-id>\.md` 旧平铺计划/);
  assert.match(prompt, /plan-only/);
  assert.match(prompt, /一律拒绝；不迁移、不兼容、不得作为单任务输入/);
  assert.match(prompt, /反向生成 spec|不反向生成规格/);
});

test('coding validates non-empty checkbox acceptance criteria before split execution', () => {
  const prompt = loadAgentAssets().compiledBodies.get('coding');
  assert.match(prompt, /空 `验收标准`.*没有 `- \[ \]`\/`- \[x\]` checklist.*阻塞/s);
  assert.match(prompt, /acceptance evidence 与 Verification.*逐项对应/s);
});

test('coding stops implementation when an approved plan needs to change', () => {
  const prompt = loadAgentAssets().compiledBodies.get('coding');
  assert.match(prompt, /实施开始后需求变化.*不得修改已批准的 spec、plan 或 tasks.*不得委派 Planning Writer/s);
  assert.match(prompt, /返回 Planning.*创建 planning commit/s);
});

test('git operator rejects completed checkboxes from a planning commit', () => {
  const prompt = loadAgentAssets().compiledBodies.get('git-operator');
  assert.match(prompt, /planning commit.*所有 checkbox 必须未勾选/s);
});

test('planning writer catalog and prompt describe one exact spec or plan target', () => {
  const role = catalog.roles.find((candidate) => candidate.id === 'planning-writer');
  const prompt = loadAgentAssets().compiledBodies.get('planning-writer');
  assert.equal(role.description, '单次只负责完整写入一个目录式规格或实施计划。');
  assert.match(prompt, /一次只写一个指定的 spec 或 plan/);
  assert.match(prompt, /目标缺失、同时给出两个目标.*必须阻塞/);
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

  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);
  const generatedCodex = parseToml(readFileSync(agentPath(paths, 'codex', 'planning-writer', 'toml'), 'utf8'));
  const generatedClaude = parseFrontmatter(readFileSync(agentPath(paths, 'claude', 'planning-writer', 'md'), 'utf8'));
  const generatedOpenCode = parseFrontmatter(readFileSync(agentPath(paths, 'opencode', 'planning-writer', 'md'), 'utf8'));
  assert.equal(generatedCodex.model_reasoning_effort, 'medium');
  assert.equal(generatedClaude.effort, 'high');
  assert.equal(generatedOpenCode.variant, 'medium');
});

test('spec-first planning binds the plan to raw saved bytes and short-circuits failures', () => {
  const planning = readFileSync(resolve(templatesDir, 'planning.md'), 'utf8');
  const routing = readFileSync(resolve(configDir, 'routing.md'), 'utf8');
  const bytes = Buffer.from('# Spec\n\nexact bytes\n');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const normalizedDigest = createHash('sha256').update(bytes.toString('utf8').trim()).digest('hex');

  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.notEqual(digest, normalizedDigest);
  const orderedMarkers = [
    '**冲突门禁**', '**需求确认**', '**规格写入或复用**', '**规格摘要**',
    '**任务模式选择**', '**计划写入与绑定**', '**拆分模式**', '**单任务模式**', '**规划提交**'
  ];
  const positions = orderedMarkers.map((marker) => planning.indexOf(marker));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
  assert.match(planning, /原始完整字节.*不得规范化文本/s);
  assert.match(planning, /读取或摘要失败时停止，不得写 plan/);
  assert.match(planning, /用户明确确认前必须停下.*不得委派 Planning Writer 写 plan.*不得委派 Task Planner.*不得创建、修改或删除 plan\/tasks/s);
  assert.match(planning, /写入、校验、摘要、模式绑定或全量替换失败时 fail closed/);
  assert.match(planning, /需求未变化.*校验现有 spec.*再次取得批准.*不重写/s);
  assert.match(routing, /确认前不得写 plan、生成 task 草案或修改 tasks/);
  assert.match(routing, /缺失、格式非法、模式、路径或摘要不匹配时 fail closed/);
});

test('spec-first validation and task replacement contracts reject partial state', () => {
  const planning = readFileSync(resolve(templatesDir, 'planning.md'), 'utf8');
  const writer = readFileSync(resolve(templatesDir, 'planning-writer.md'), 'utf8');
  const taskPlanner = readFileSync(resolve(templatesDir, 'task-planner.md'), 'utf8');
  const fileExplorer = readFileSync(resolve(templatesDir, 'file-explorer.md'), 'utf8');
  const coding = readFileSync(resolve(templatesDir, 'coding.md'), 'utf8');

  for (const source of [planning, writer, coding]) {
    assert.match(source, /status: `approved`|`status: approved`/);
    assert.match(source, /开放问题/);
  }
  assert.match(writer, /不得包含文件改动清单、实施步骤、技术方案或任务拆分/);
  assert.match(coding, /摘要错误一律拒绝/);
  assert.match(taskPlanner, /一次性全量替换完整任务集/);
  assert.match(taskPlanner, /不得局部保留旧任务/);
  assert.match(taskPlanner, /明确确认删除全部旧 tasks/);
  assert.match(taskPlanner, /删除不完整.*不得降级声明单任务模式/s);
  assert.match(planning, /Planning 校验摘要.*`task_mode`/s);
  assert.match(fileExplorer, /`task_mode` 精确为 `split` 或 `single`.*Planning 交接的已确认模式一致/s);
  assert.match(writer, /写 plan 还必须收到用户已明确确认的 `task_mode: split\|single`/);
  assert.match(taskPlanner, /草案或写入只接受 `task_mode: split`/);
  assert.match(taskPlanner, /`task_mode: single`.*不得生成草案或 task 文件/s);
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
  assert.match(prompt, /只使用获准的官方来源，不读取本地项目/);
  assert.match(prompt, /只写 `\.ai-work-flow\/research\/\*\.md`，不得创建子目录/);
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
  assert.equal(openCode.permission.bash, 'allow');
  assert.equal(capabilityMatrix('opencode', taskPlanner, policies[taskPlanner.policy]).write_scope, 'instruction-only');
});

test('planning prompt converges one decision at a time while planning writer owns fixed templates', () => {
  const body = readFileSync(resolve(templatesDir, 'planning.md'), 'utf8');
  const prompt = loadAgentAssets().compiledBodies.get('planning');
  const writer = readFileSync(resolve(templatesDir, 'planning-writer.md'), 'utf8');
  const routing = readFileSync(resolve(configDir, 'routing.md'), 'utf8');

  assert.doesNotMatch(body, /```markdown/);
  assert.match(body, /完整固定模板只由 Planning Writer 拥有/);
  assert.equal([...writer.matchAll(/```markdown\n([\s\S]*?)\n```/g)].length, 2);
  assert.match(body, /一次只问一个/);
  assert.match(body, /每个会话从 `问题 1：` 开始/);
  assert.match(body, /后续问题连续递增.*不复用、跳号或重置/s);
  assert.match(body, /同名冲突、共享理解、任务模式、颗粒度和删除确认沿用序号/);
  assert.match(body, /推荐答案、理由与主要取舍/);
  assert.match(body, /目标、成功标准、受众、范围、约束、现状、接口、数据流、失败处理、测试、兼容、迁移和发布策略/);
  assert.match(body, /沿每个会影响结果的设计分支持续追问.*依赖顺序逐一解决/s);
  assert.match(body, /含糊、矛盾、把决定推回给 Planning.*继续追问/s);
  assert.match(body, /事实已查清.*关键决策及其依赖已解决.*可验证场景.*范围外边界.*未决问题为零/s);
  assert.match(body, /门禁通过前.*不得委派 Planning Writer、Task Planner 或 Git Operator/s);
  assert.match(body, /新信息或需求变化.*重新打开问询门禁/s);
  assert.match(body, /用户明确批准共享理解/);
  assert.match(body, /未选择不覆盖/);
  assert.match(body, /只报告目录与 spec 路径.*不输出完整正文/s);
  assert.match(routing, /持续问询.*共享理解门禁.*Planning Writer、Task Planner 或 Git Operator/s);
  assert.match(prompt, /收到编码或实施请求时引导用户.*Coding/s);
  assert.match(prompt, /Coding/);
  assert.doesNotMatch(prompt, /https?:\/\/|github\.com/i);
});

test('planning confirms plan splitting and commits only final planning artifacts', () => {
  const planning = readFileSync(resolve(templatesDir, 'planning.md'), 'utf8');
  const planningWriter = readFileSync(resolve(templatesDir, 'planning-writer.md'), 'utf8');
  const taskPlanner = readFileSync(resolve(templatesDir, 'task-planner.md'), 'utf8');
  const compiledTaskPlanner = loadAgentAssets().compiledBodies.get('task-planner');
  const gitOperator = readFileSync(resolve(templatesDir, 'git-operator.md'), 'utf8');

  assert.match(planning, /\.ai-work-flow\/plans\/<plan-id>\/spec\.md/);
  assert.match(planning, /source_spec_digest/);
  assert.match(planning, /只报告目录与 spec 路径.*提示用户打开查看.*不输出完整正文.*“拆分”或“不拆分”/s);
  assert.ok(planning.indexOf('**任务模式选择**') < planning.indexOf('**计划写入与绑定**'));
  assert.match(planning, /收到明确任务模式后.*只写同目录 `plan\.md`.*`task_mode: split\|single`/s);
  assert.match(planning, /单任务模式.*“删除全部旧 tasks”.*移除 `tasks\/` 目录.*目录不存在/s);
  assert.match(planning, /outcome.*blocked_by.*acceptance/s);
  assert.match(planning, /合并、拆细、调整依赖或验收/);
  assert.match(planning, /返回完整草案/);
  assert.match(planning, /确认颗粒度后才全量替换 tasks/);
  assert.match(planning, /旧 tasks 立即失效/);
  assert.match(planning, /`main`.*仅当前规划工件.*Git Operator/s);
  assert.match(planning, /planning commit.*SHA/);
  assert.match(planning, /不得自动进入实施/);

  assert.match(planningWriter, /\.ai-work-flow\/plans\/<plan-id>\/spec\.md.*同目录 `plan\.md`/s);
  assert.match(planningWriter, /预先指定的精确目标/);
  assert.match(planningWriter, /写 spec 时不创建或修改 plan\/tasks.*写 plan 时不创建或修改 spec\/tasks/s);
  assert.match(planningWriter, /ready-for-implementation/);
  assert.match(planningWriter, /plan 缺少明确任务模式.*必须阻塞/s);
  assert.match(taskPlanner, /spec\.md.*plan\.md.*File Explorer.*代码地图/s);
  assert.match(compiledTaskPlanner, /只维护当前 plan 的 `tasks\/NN-\*\.md`/);
  assert.match(taskPlanner, /草案阶段.*不得创建、修改或删除任何 task 文件/s);
  assert.match(taskPlanner, /写入阶段.*完整任务草案.*用户已明确确认.*颗粒度/s);
  assert.match(taskPlanner, /校验每项 `source_plan_digest`.*待写内容与已确认草案完全一致/s);
  assert.match(taskPlanner, /删除阶段.*删除目标 `tasks\/` 下全部 task 文件并移除 `tasks\/` 目录本身.*目录仍存在.*阻塞/s);
  assert.match(taskPlanner, /草案阶段.*`task_mode: split`/s);
  assert.match(taskPlanner, /删除阶段.*`task_mode: single`/s);
  assert.match(gitOperator, /不拆分时 `tasks\/` 目录必须不存在/);
  assert.match(taskPlanner, /默认采用较粗颗粒度并优先减少 task 数量/);
});

test('task planner emits a deterministic dependency-safe task artifact contract', () => {
  const body = readFileSync(resolve(templatesDir, 'task-planner.md'), 'utf8');
  const compiled = loadAgentAssets().compiledBodies.get('task-planner');
  for (const field of ['task_id:', 'order:', 'blocked_by:', 'source_plan:', 'source_plan_digest:', 'write_scope:']) {
    assert.match(body, new RegExp(field), field);
  }
  for (const heading of ['预期结果', '实施清单', '验收标准', '验证步骤', '范围外事项']) {
    assert.match(body, new RegExp(`^## ${heading}$`, 'm'), heading);
  }
  assert.match(body, /`NN-<short-name>\.md`/);
  assert.match(body, /`01`.*`99`/);
  assert.match(body, /short name.*lowercase kebab/);
  assert.match(body, /唯一且连续/);
  assert.match(body, /`task_id`.*唯一/);
  assert.match(body, /`blocked_by`.*较早.*task ID.*`none`.*不得成环/s);
  assert.match(body, /`write_scope`.*粗粒度.*非穷举提示.*不是.*写入授权边界/s);
  assert.match(body, /计划并发执行.*`write_scope`.*互斥/s);
  assert.match(body, /未列出的文件.*不构成计划或 task 变更.*不得据此修订/s);
  assert.match(body, /依赖变更.*lockfile.*`Cargo\.lock`/s);
  assert.match(body, /一个 \*\*Full Stack Coder\*\*.*一个上下文/s);
  assert.match(body, /默认采用较粗颗粒度.*优先减少 task 数量/s);
  assert.match(body, /完整、可独立验证的行为或能力/);
  assert.match(body, /不得仅按文件、目录、技术层、函数、实现步骤.*测试、文档、配置.*机械拆成不同 task/s);
  assert.match(body, /拿不准是否需要拆分时优先合并/);
  assert.match(body, /expand.*migrate.*contract/s);
  assert.match(body, /source_plan: `\.\.\/plan\.md`/);
  assert.match(body, /`source_plan_digest`.*完整字节.*SHA-256/s);
  assert.match(body, /`tasks\/`.*只包含.*`NN-<short-name>\.md`/s);
  assert.match(compiled, /只维护当前 plan 的 `tasks\/NN-\*\.md`，不修改其他内容或 Git 状态/);
  assert.doesNotMatch(body, /^- plan_id:/m);
  assert.doesNotMatch(body, /^- plan_digest:/m);
  assert.doesNotMatch(body, /^---$/m);
});

test('task planner wraps each complete task artifact in a markdown fenced code block', () => {
  const source = readFileSync(resolve(templatesDir, 'task-planner.md'), 'utf8');
  const completeTaskFence = /```markdown\n# NN - <任务标题>\n\n- task_id:[\s\S]*- order:[\s\S]*- blocked_by: `<task IDs or none>`\n- source_plan: `\.\.\/plan\.md`[\s\S]*- source_plan_digest:[\s\S]*- write_scope: `<expected primary paths or modules; non-exhaustive>`\n\n## 预期结果[\s\S]*## 实施清单\n\n- \[ \] 实施项[\s\S]*## 验收标准\n\n- \[ \][\s\S]*## 验证步骤\n\n- \[ \][\s\S]*## 范围外事项[\s\S]*```/;
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
    /有效 planning commit 加实施授权/,
    /`tasks\/` 不存在表示单任务/,
    /空目录.*阻塞/s,
    /`blocked_by` frontier/,
    /同一 frontier.*`write_scope` 互斥/s,
    /task worktree 从同一 feature HEAD 创建/,
    /acceptance evidence 与 Verification.*逐项对应/s,
    /同一 review commit/,
    /通过后按编号汇入并清理.*下一 frontier/s,
    /完整 committed range.*聚合审查/s,
    /不执行第二次评审.*自动继续 task 汇入或最终整合与清理/s
  ];
  for (const assertion of assertions) assert.match(coding, assertion);
  assert.doesNotMatch(coding, /选择“再次执行 Code Reviewer 双轴评审”或“继续执行后续流程”/);
  assert.doesNotMatch(coding, /只有用户明确选择再次评审/);
});

test('implementation roles preserve planning and task commit boundaries', () => {
  const coder = readFileSync(resolve(templatesDir, 'full-stack-coder.md'), 'utf8');
  const operator = readFileSync(resolve(templatesDir, 'git-operator.md'), 'utf8');
  const reviewer = readFileSync(resolve(templatesDir, 'code-reviewer.md'), 'utf8');
  const routing = readFileSync(resolve(configDir, 'routing.md'), 'utf8');
  const compiled = loadAgentAssets().compiledBodies;

  assert.match(coder, /task 的 `write_scope` 是非穷举并发提示，不是授权边界/);
  assert.match(coder, /task 模式可修改必要源码、测试、配置、lockfile、索引和自己的 checkbox/);
  assert.match(compiled.get('full-stack-coder'), /不得修改已批准规划工件或其他 task/);
  assert.match(coder, /acceptance evidence 与 Verification/);

  assert.match(operator, /planning commit.*`spec\.md`\/`plan\.md`/s);
  assert.match(operator, /规划 PathChange 仅允许当前 spec、plan 与完整 tasks/);
  assert.match(operator, /task.*按编号汇入 feature/s);
  assert.match(operator, /串行执行/);
  assert.match(compiled.get('git-operator'), /禁止 push、amend、reset、clean、隐式 stash、标签修改、跳 hook 和实现编辑/);

  assert.match(reviewer, /完整 spec context\/bundle/);
  assert.match(reviewer, /source binding.*bundle 完整性/s);
  assert.match(routing, /Git mutation 必须串行/);
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
  assert.equal(openCodePlanningWriter.permission.bash, 'allow');
  assert.deepEqual(openCodePlanningWriter.permission.edit, {
    '*': 'deny',
    '.ai-work-flow/plans/*/spec.md': 'allow',
    '.ai-work-flow/plans/*/plan.md': 'allow',
    '.ai-work-flow/plans/*/*/*': 'deny'
  });

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
  const fixer = readFileSync(resolve(templatesDir, 'bug-fixer.md'), 'utf8');
  const operator = readFileSync(resolve(templatesDir, 'git-operator.md'), 'utf8');
  const compiled = loadAgentAssets().compiledBodies;
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);

  for (const assertion of [
    /完整 `fixed-point` 与 `review-commit` SHA/,
    /blocking_findings/,
    /blocking finding 进入 `awaiting_user`/,
    /用户必须确认具体 finding IDs/,
    /自动同步并继续.*task 汇入.*单任务\/聚合最终整合/s,
    /不执行第二次评审/,
    /`resync_required` 后仍重新评审最终提交/,
    /`git merge --ff-only <review_commit>`/
  ]) assert.match(routing, assertion);
  const removedBranchPatterns = [
    /选择“再次执行 Code Reviewer 双轴评审”或“继续执行后续流程”/,
    /只有用户明确选择再次评审/,
    /第二次 Code Reviewer/,
    /第二次完整双轴评审/,
    /用户复审决策点/,
  ];
  for (const pattern of removedBranchPatterns) assert.doesNotMatch(routing, pattern);
  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    const generated = generatedBody(paths, platform, 'coding', extension);
    assert.match(generated, /`awaiting_finding_ids`.*具体 finding IDs/s, platform);
    assert.match(generated, /不执行第二次评审.*自动继续 task 汇入或最终整合/s, platform);
    assert.match(generated, /`resync_required`.*重新评审最终提交/s, platform);
    for (const pattern of removedBranchPatterns) assert.doesNotMatch(generated, pattern, platform);
  }
  assert.match(coding, /不执行第二次评审.*自动继续 task 汇入或最终整合/s);
  assert.match(fixer, /不执行第二次评审/);
  assert.match(operator, /finding 修复提交验证新 SHA 是旧 SHA 后继且等于 HEAD/);
  for (const content of [coding, fixer, operator]) {
    for (const pattern of removedBranchPatterns) assert.doesNotMatch(content, pattern);
  }
  assert.match(coding, /Git Operator.*安装 runtime prepare 后立即 verify/s);
  assert.match(coding, /Coding 只核对交接完整自洽.*再原样交 Code Reviewer/s);
  assert.match(coding, /唯一机器 envelope.*原始 `verify_input`/s);
  assert.match(coding, /Coding 只核对交接完整自洽.*再原样交 Code Reviewer.*不补齐、推导/s);
  assert.match(coding, /不委派 File Explorer prepare/);
  assert.match(coding, /checks: \["<check>"\].*acceptance_evidence.*criterion.*evidence.*verification.*command.*result/s);
  assert.match(compiled.get('git-operator'), /review_manifest.*verify_input.*manifest_digest.*bundle_digest/s);
  assert.match(compiled.get('git-operator'), /保存 stdout.*verify --repository <review-worktree>/s);
  assert.match(compiled.get('git-operator'), /review-manifest-cli\.mjs.*prepare --repository <review-worktree>/s);
  assert.match(compiled.get('git-operator'), /null、空值或缺失 checks 均阻塞/);
  assert.match(compiled.get('git-operator'), /拥有 prepare 及紧随的同 CLI verify/);
  assert.match(compiled.get('coding'), /absent 不含这些路径/);
  assert.match(compiled.get('file-explorer'), /不得 prepare、verify、构造、修改或转交 ReviewManifest envelope/);
  assert.doesNotMatch(compiled.get('file-explorer'), /null、空字符串、空对象或缺失 checks/);
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
    assert.match(compiled, /每项 finding 引用 ReviewManifest shard ID/);
    assert.match(compiled, /上下文只使用 `git show <review-commit>:<path>`/);
    assert.match(compiled, /不得从 committed diff 外新增 finding/);
  }
  assert.match(routing, /两叶子接收完全相同的 SHA、diff、commit list、来源、shards、manifest\/digest、原始 verify input/);
  assert.match(routing, /禁止用无参数 `git diff`、`git diff --cached` 或工作树文件读取命令取证/);
  assert.match(routing, /审查 worktree 的 `HEAD` 等于 review commit 且工作树干净/);
  assert.match(routing, /输入 range、commit list 或 changed paths 与 ReviewManifest 不一致时阻塞/);
  assert.match(routing, /每项 finding 引用 ReviewManifest shard ID 和 `git diff --no-ext-diff <fixed-point>\.\.\.<review-commit> -- <paths>` hunk/);
  assert.match(routing, /上下文只使用 `git show <review-commit>:<path>`/);
  assert.match(routing, /不得从 committed diff 外新增 finding/);
  assert.match(bodies['code-reviewer'], /不合并、不跨轴重排/);
  assert.match(compiledBodies.get('code-reviewer'), /审查角色只读，不编辑、不执行 Git mutation/);
  assert.match(compiledBodies.get('code-reviewer'), /只根据不可变 ReviewManifest 调度/);
  assert.match(compiledBodies.get('code-reviewer'), /新会话重试一次/);
  assert.match(compiledBodies.get('code-reviewer'), /manifest、digest、SHA、shards 和来源均不变/);
  assert.match(bodies['code-reviewer'], /prepare envelope 原样传.*review-manifest-cli\.mjs verify/s);
  assert.match(compiledBodies.get('code-reviewer'), /仍阻塞即报告用户/);
  assert.doesNotMatch(bodies['code-reviewer'], /git rev-parse/);
  assert.doesNotMatch(bodies['code-reviewer'], /\$code-review|已安装时|未安装时|Matt/);
  assert.match(bodies['review-standards'], /缺失\/不一致时 blocked/);
  assert.match(bodies['review-standards'], /ReviewManifest shard ID/);
  assert.match(bodies['review-spec'], /缺失\/不一致时 blocked/);
  assert.match(bodies['review-spec'], /ReviewManifest shard ID/);

  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);
  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    const generatedOperator = generatedBody(paths, platform, 'git-operator', extension);
    assert.match(generatedOperator, /blocking finding 修复提交必须不同于且后继于首次被拒的 review commit，并等于 feature\/task HEAD/, platform);
    assert.match(generatedOperator, /finding 修复提交验证新 SHA 是旧 SHA 后继且等于 HEAD/, platform);
    for (const role of Object.keys(bodies)) {
      const generated = generatedBody(paths, platform, role, extension);
      assert.ok(generated.includes('git diff <fixed-point>...<review-commit>'), `${platform}/${role}`);
      if (role === 'code-reviewer') {
        assert.match(generated, /新会话重试一次/, platform);
        assert.match(generated, /仍阻塞即报告用户/, platform);
      }
      assert.match(generated, /工作树文件读取命令取证/, `${platform}/${role}`);
      assert.match(generated, /每项 finding 引用 ReviewManifest shard ID/, `${platform}/${role}`);
      assert.match(generated, /上下文只使用 `git show <review-commit>:<path>`/, `${platform}/${role}`);
      assert.match(generated, /审查 worktree 的 `HEAD` 等于 review commit 且工作树干净/, `${platform}/${role}`);
      assert.match(generated, /输入 range、commit list 或 changed paths 与 ReviewManifest 不一致时阻塞/, `${platform}/${role}`);
    }
  }
});

test('dual-axis review binds standards and complete directory spec bundles without fallback', () => {
  const routing = readFileSync(resolve(configDir, 'routing.md'), 'utf8');
  const bodies = Object.fromEntries(['coding', 'code-reviewer', 'review-standards', 'review-spec'].map((role) => [
    role,
    readFileSync(resolve(templatesDir, `${role}.md`), 'utf8')
  ]));
  const compiled = loadAgentAssets().compiledBodies;
  const sharedBundleAssertions = [
    /spec context\/bundle|envelope 绑定/s,
    /\.ai-work-flow\/plans\/<plan-id>\/spec\.md \+ plan\.md/,
    /拆分 task 加当前 task、acceptance evidence 与 Verification 结果/,
    /不得退化为 instruction-only、单文件审查或静默遗漏上下文/
  ];
  const sharedManifestAssertions = [
    /ReviewManifest 机器冻结端点、commit list、真实 PathChange、review checks、diff、spec\/standards source、稳定 shards 和 digest/,
    /机器绑定 acceptance evidence\/Verification digest/,
    /`spec_status=present` 时同时绑定 spec\/plan\/可选 task/,
    /`spec_status=absent` 时输入不得提供 mode\/spec\/plan\/task 路径且生成的 single bundle sources 必须为空/,
    /不得退化为 instruction-only/
  ];
  for (const assertion of sharedBundleAssertions) assert.match(routing, assertion);
  for (const assertion of sharedManifestAssertions) assert.match(routing, assertion);
  assert.match(routing, /两叶子接收完全相同的 SHA、diff、commit list、来源、shards、manifest\/digest、原始 verify input及相同 spec bundle/);
  assert.match(routing, /Standards 轴使用冻结 revision 的仓库 Standards、`CONTEXT\.md` 等来源，`spec\.md` 不是 Standards 来源/);
  assert.match(bodies['code-reviewer'], /完整 spec context\/bundle/);
  assert.match(bodies['code-reviewer'], /`absent` 只委派 Standards，不构造 Spec/);
  assert.match(bodies['code-reviewer'], /present 两叶子共享 manifest\/digest、端点、shards、来源及 bundle/);
  assert.match(bodies['review-standards'], /冻结的 Standards\/`CONTEXT\.md` 来源/);
  assert.match(bodies['review-standards'], /`spec\.md` 不得作为 Standards 来源/);
  assert.match(bodies['review-spec'], /review-manifest-cli\.mjs verify.*机器复验/s);
  assert.doesNotMatch(bodies['review-spec'], /按 `instruction-only` 验证/);
  assert.match(bodies['review-spec'], /不得退化为只审 spec、plan 或当前 task/);

  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);
  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    const reviewer = generatedBody(paths, platform, 'code-reviewer', extension);
    const standards = generatedBody(paths, platform, 'review-standards', extension);
    const spec = generatedBody(paths, platform, 'review-spec', extension);
    for (const assertion of sharedBundleAssertions) assert.match(reviewer, assertion, `${platform}/code-reviewer`);
    for (const assertion of sharedManifestAssertions) assert.match(reviewer, assertion, `${platform}/code-reviewer`);
    assert.match(reviewer, /present 两叶子共享 manifest\/digest、端点、shards、来源及 bundle/, `${platform}/code-reviewer`);
    assert.match(standards, /`spec\.md` 不得作为 Standards 来源/, `${platform}/review-standards`);
    assert.match(spec, /完整 spec context\/bundle/, `${platform}/review-spec`);
    for (const assertion of sharedManifestAssertions) assert.match(spec, assertion, `${platform}/review-spec`);
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
    /只重试暂态 429、502\/503\/504、超时、连接重置或结果未知/,
    /硬配额\/计费 429、400\/401\/403\/404、参数或模型配置错误、正常任务失败、测试失败和需求不清不可重试/,
    /`Retry-After`，否则等待 30 秒、60 秒/,
    /网关或连接错误等待 5 秒、15 秒；单次等待不超过 120 秒/,
    /不承诺平台未提供的原子性或精确计时/,
    /只有确认其已终止，才能用全新子会话重试/,
    /无法确认终止时启动停止锁：停止新委派、恢复和继续/,
    /尽力中止全部已知活跃子代理/,
    /报告错误、尝试数、最后错误和会话状态/,
    /等待用户明确“继续”或“重试”/,
    /恢复后先确认没有持续运行的旧会话，再重置本轮预算/,
    /OpenCode 必须新建 child session，复用 `task_id` 只表示恢复/,
    /Code Reviewer 可按审查编排契约对可澄清的叶子阻塞额外重试一次/
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
      } else if (role.id === 'planning-writer') {
        assert.deepEqual(openCode.permission.edit, {
          '*': 'deny',
          '.ai-work-flow/plans/*/spec.md': 'allow',
          '.ai-work-flow/plans/*/plan.md': 'allow',
          '.ai-work-flow/plans/*/*/*': 'deny'
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
    } else if (role.id === 'file-explorer') {
      assert.deepEqual(openCode.permission.skill, { '*': 'deny', 'project-code-navigation': 'allow' }, role.id);
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

test('CLI reports control enforcement and control text participates in generation drift', () => {
  const paths = environment();
  const installed = install(paths);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(
    readFileSync(resolve(paths.config, 'ai-work-flow/config/controls.json'), 'utf8'),
    readFileSync(resolve(configDir, 'controls.json'), 'utf8')
  );
  assert.equal((installed.stdout.match(/^CONTROL [^\n]+$/gm) ?? []).length, 3 * catalog.roles.length);
  assert.equal((installed.stderr.match(/^WARNING CONTROL [^\n]+$/gm) ?? []).length, 3 * catalog.roles.length);
  assert.match(installed.stdout, /CONTROL opencode\/researcher: official-research-only=unsupported, research-report-path-only=enforced, single-research-report-only=instruction-only/);
  assert.match(installed.stderr, /WARNING CONTROL opencode\/researcher: official-research-only=unsupported, single-research-report-only=instruction-only/);

  const beforeDigest = installed.stdout.match(/Generation digest codex: ([a-f0-9]{64})/)?.[1];
  const generated = agentPath(paths, 'codex', 'coding', 'toml');
  const beforeAgent = readFileSync(generated, 'utf8');
  const controlPath = resolve(paths.config, 'ai-work-flow/config/controls.json');
  const changedControls = JSON.parse(readFileSync(controlPath, 'utf8'));
  changedControls.controls['coding-orchestration-only'].instruction += '仅用于摘要变更。';
  writeFileSync(controlPath, `${JSON.stringify(changedControls, null, 2)}\n`);

  const regenerated = runInstalledWorkflow(paths, 'generate', '--platform', 'codex');
  assert.equal(regenerated.status, 0, regenerated.stderr);
  const afterDigest = regenerated.stdout.match(/Generation digest codex: ([a-f0-9]{64})/)?.[1];
  assert.notEqual(afterDigest, beforeDigest);
  assert.notEqual(readFileSync(generated, 'utf8'), beforeAgent);
  assert.match(readFileSync(generated, 'utf8'), /仅用于摘要变更/);
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

test('install and generate remove obsolete owned content without deleting shared or user files', () => {
  const paths = environment();
  const obsoleteBody = resolve(paths.config, 'ai-work-flow/templates', `${legacyPrimaryAgentId}.md`);
  mkdirSync(resolve(paths.config, 'ai-work-flow/templates'), { recursive: true });
  writeFileSync(obsoleteBody, 'obsolete body\n');
  const installedRuntime = resolve(paths.config, 'ai-work-flow/execution-runtime');
  mkdirSync(resolve(installedRuntime, 'lib'), { recursive: true });
  const obsoleteCli = ['execution', '-cli.mjs'].join('');
  const obsoleteSchema = ['check', 'point-schema.json'].join('');
  writeFileSync(resolve(installedRuntime, obsoleteCli), 'obsolete runtime\n');
  writeFileSync(resolve(installedRuntime, 'lib/execution-coding.mjs'), 'obsolete runtime module\n');
  writeFileSync(resolve(installedRuntime, 'user-note.txt'), 'preserve user file\n');
  for (const platformRoot of [resolve(paths.home, '.codex'), resolve(paths.home, '.claude'), resolve(paths.config, 'opencode')]) {
    const skillRoot = resolve(platformRoot, 'skills', executionSkill);
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(resolve(skillRoot, 'legacy-owned-file.md'), 'obsolete managed tree\n');
  }

  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(obsoleteBody));
  assert.ok(!existsSync(resolve(installedRuntime, obsoleteCli)));
  assert.ok(!existsSync(resolve(installedRuntime, 'lib/execution-coding.mjs')));
  assert.ok(existsSync(resolve(installedRuntime, 'review-manifest-cli.mjs')));
  assert.equal(readFileSync(resolve(installedRuntime, 'user-note.txt'), 'utf8'), 'preserve user file\n');
  for (const platformRoot of [resolve(paths.home, '.codex'), resolve(paths.home, '.claude'), resolve(paths.config, 'opencode')]) {
    const skillRoot = resolve(platformRoot, 'skills', executionSkill);
    assert.ok(!existsSync(skillRoot));
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(resolve(skillRoot, 'legacy-owned-file.md'), 'obsolete managed tree\n');
  }
  writeFileSync(resolve(installedRuntime, obsoleteSchema), 'obsolete schema\n');
  const generated = run(paths, 'generate');
  assert.equal(generated.status, 0, generated.stderr);
  assert.ok(!existsSync(resolve(installedRuntime, obsoleteSchema)));
  for (const platformRoot of [resolve(paths.home, '.codex'), resolve(paths.home, '.claude'), resolve(paths.config, 'opencode')]) {
    assert.ok(!existsSync(resolve(platformRoot, 'skills', executionSkill)));
  }
});

test('obsolete managed tree cleanup rejects symlinks and rolls back transaction failures', () => {
  const paths = environment();
  const outside = resolve(paths.base, 'outside-owned-tree');
  mkdirSync(outside, { recursive: true });
  writeFileSync(resolve(outside, 'preserve.txt'), 'preserve\n');
  const linkedSkill = resolve(paths.home, '.codex/skills', executionSkill);
  mkdirSync(resolve(paths.home, '.codex/skills'), { recursive: true });
  symlinkSync(outside, linkedSkill);
  const rejected = install(paths);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /symbolic link/);
  assert.equal(readFileSync(resolve(outside, 'preserve.txt'), 'utf8'), 'preserve\n');

  rmSync(linkedSkill);
  mkdirSync(linkedSkill, { recursive: true });
  writeFileSync(resolve(linkedSkill, 'owned.txt'), 'restore\n');
  const transaction = resolve(paths.config, 'ai-work-flow/delete-tree-rollback.json');
  assert.throws(() => applyTransaction([
    { type: 'delete-tree', path: linkedSkill },
    { type: 'write', path: resolve(paths.home, '.codex/agents/never.txt'), contents: 'never\n' }
  ], { transactionPath: transaction, roots: [paths.home, paths.config], failAfterStep: 1 }), /Injected transaction failure/);
  assert.equal(readFileSync(resolve(linkedSkill, 'owned.txt'), 'utf8'), 'restore\n');
  assert.ok(!existsSync(transaction));
});

test('dangling managed links fail before any managed write', () => {
  const installPaths = environment();
  const linkedSkill = resolve(installPaths.home, '.codex/skills', executionSkill);
  mkdirSync(resolve(linkedSkill, '..'), { recursive: true });
  symlinkSync(resolve(installPaths.base, 'missing-skill'), linkedSkill);
  const installBefore = snapshotTree(installPaths.base);

  const rejectedInstall = install(installPaths);
  assert.equal(rejectedInstall.status, 1, rejectedInstall.stderr);
  assert.match(rejectedInstall.stderr, /symbolic link/);
  assert.ok(lstatSync(linkedSkill).isSymbolicLink());
  assert.deepEqual(snapshotTree(installPaths.base), installBefore);

  const generatePaths = environment();
  assert.equal(install(generatePaths).status, 0);
  const obsoleteCli = ['execution', '-cli.mjs'].join('');
  const linkedRuntimeFile = resolve(generatePaths.config, 'ai-work-flow/execution-runtime', obsoleteCli);
  mkdirSync(resolve(linkedRuntimeFile, '..'), { recursive: true });
  symlinkSync(resolve(generatePaths.base, 'missing-runtime'), linkedRuntimeFile);
  mkdirSync(generatePaths.project, { recursive: true });
  const generateBefore = snapshotTree(generatePaths.base);

  const rejectedGenerate = run(generatePaths, 'generate');
  assert.equal(rejectedGenerate.status, 1, rejectedGenerate.stderr);
  assert.match(rejectedGenerate.stderr, /symbolic link/);
  assert.ok(lstatSync(linkedRuntimeFile).isSymbolicLink());
  assert.deepEqual(snapshotTree(generatePaths.base), generateBefore);
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

test('invalid installed controls cannot mutate generated agents or runtime state', () => {
  const paths = environment();
  assert.equal(install(paths).status, 0);
  const generated = agentPath(paths, 'codex', 'coding', 'toml');
  const runtime = resolve(paths.config, 'ai-work-flow/agent-workflow.mjs');
  const environmentFile = defaultEnvironmentPath(paths);
  const before = new Map([generated, runtime, environmentFile].map((path) => [path, readFileSync(path, 'utf8')]));
  const controlPath = resolve(paths.config, 'ai-work-flow/config/controls.json');
  const invalid = JSON.parse(readFileSync(controlPath, 'utf8'));
  invalid.controls['coding-orchestration-only'].instruction = '';
  writeFileSync(controlPath, `${JSON.stringify(invalid, null, 2)}\n`);

  const result = runInstalledWorkflow(paths, 'generate', '--platform', 'codex');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must have a non-empty instruction/);
  for (const [path, contents] of before) assert.equal(readFileSync(path, 'utf8'), contents, path);
  assert.ok(!existsSync(resolve(paths.config, 'ai-work-flow/.generation-transaction.json')));
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
  assert.match(compiled, /你是 \*\*Coding\*\*。你是默认面向用户的编排入口/);
  assert.match(assets.bodies.get('coding'), /你是 \*\*Coding\*\*。你是默认面向用户的编排入口/);

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

test('control catalog validation fails closed on malformed interfaces and relationships', () => {
  const cases = [
    ['roles version', 'roles.json', (document) => { document.version = 1; }, /roles\.json must contain version: 2/],
    ['controls version', 'controls.json', (document) => { document.version = 2; }, /controls\.json must contain version: 1/],
    ['roles unknown field', 'roles.json', (document) => { document.extra = true; }, /roles\.json has unknown field: extra/],
    ['policies unknown field', 'policies.json', (document) => { document.extra = true; }, /policies\.json has unknown field: extra/],
    ['defaults unknown field', 'default-config.json', (document) => { document.extra = true; }, /default-config\.json has unknown field: extra/],
    ['control unknown field', 'controls.json', (document) => { document.controls['coding-orchestration-only'].extra = true; }, /Control coding-orchestration-only has unknown field: extra/],
    ['empty instruction', 'controls.json', (document) => { document.controls['coding-orchestration-only'].instruction = ''; }, /must have a non-empty instruction/],
    ['unknown capability', 'controls.json', (document) => { document.controls['coding-orchestration-only'].policy_requirements.unknown = ['none']; }, /has unknown capability: unknown/],
    ['invalid value', 'controls.json', (document) => { document.controls['coding-orchestration-only'].policy_requirements.git = ['invalid']; }, /has invalid policy value: invalid/],
    ['duplicate allowed value', 'controls.json', (document) => { document.controls['no-git-mutation'].policy_requirements.git = ['read', 'read']; }, /must be a non-empty array without duplicates/],
    ['duplicate role reference', 'roles.json', (document) => { document.roles[0].controls.push(document.roles[0].controls[0]); }, /Role coding has duplicate controls/],
    ['non-array role controls', 'roles.json', (document) => { document.roles[0].controls = { invalid: true }; }, /Role coding\.controls must be a non-empty array/],
    ['unknown role reference', 'roles.json', (document) => { document.roles[0].controls[0] = 'missing-control'; }, /references an unknown control: missing-control/],
    ['unreferenced control', 'roles.json', (document) => {
      const role = document.roles.find((candidate) => candidate.id === 'bug-fixer');
      role.controls = role.controls.filter((id) => id !== 'authorized-bug-or-finding-only');
    }, /Control is not referenced: authorized-bug-or-finding-only/],
    ['policy conflict', 'controls.json', (document) => { document.controls['authorized-bug-or-finding-only'].policy_requirements.write_scope = ['docs']; }, /policy does not satisfy control authorized-bug-or-finding-only/]
  ];

  for (const [name, file, mutate, expected] of cases) {
    const assets = copiedAssets();
    const path = resolve(assets.config, file);
    const document = JSON.parse(readFileSync(path, 'utf8'));
    mutate(document);
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
    assert.throws(() => loadAgentAssets(assets.config, assets.templates), expected, name);
  }

  for (const [name, replacement] of [['missing', ''], ['duplicate', '<!-- ai-work-flow:controls -->\n<!-- ai-work-flow:controls -->']]) {
    const assets = copiedAssets();
    const path = resolve(assets.templates, 'coding.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace('<!-- ai-work-flow:controls -->', replacement));
    assert.throws(() => loadAgentAssets(assets.config, assets.templates), /must contain exactly one controls placeholder/, name);
  }
});

test('catalog rejects missing spec-first contract markers before generation', () => {
  for (const [roleId, marker] of [
    ['planning', 'source_spec_digest'],
    ['planning-writer', '开放问题'],
    ['task-planner', '全量替换'],
    ['coding', '旧平铺计划'],
    ['git-operator', 'source_spec_digest']
  ]) {
    const assets = copiedAssets();
    const path = resolve(assets.templates, `${roleId}.md`);
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll(marker, 'removed-contract-marker'));
    assert.throws(
      () => loadAgentAssets(assets.config, assets.templates),
      new RegExp(`Template ${roleId}\\.md is missing spec-first contract marker`)
    );
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
  const fileExplorer = byId.get('file-explorer');
  const reviewer = byId.get('review-standards');
  assert.equal(evaluateOpenCodePermission(coding, policies[coding.policy], 'task'), 'allow');
  for (const key of ['read', 'edit', 'glob', 'grep', 'bash', 'skill', 'webfetch', 'websearch', 'question', 'external_directory', 'unknown']) {
    assert.equal(evaluateOpenCodePermission(coding, policies[coding.policy], key), 'deny', key);
  }
  assert.equal(evaluateOpenCodePermission(gitOperator, policies[gitOperator.policy], 'skill', 'git-commit'), 'allow');
  assert.equal(evaluateOpenCodePermission(gitOperator, policies[gitOperator.policy], 'skill', 'unrelated-skill'), 'deny');
  assert.equal(evaluateOpenCodePermission(fileExplorer, policies[fileExplorer.policy], 'skill', 'project-code-navigation'), 'allow');
  assert.equal(evaluateOpenCodePermission(fileExplorer, policies[fileExplorer.policy], 'skill', 'unrelated-skill'), 'deny');
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
