import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const installer = resolve(root, 'scripts/install.mjs');
const agentAssets = resolve(root, 'scripts/agent-assets');
const catalog = JSON.parse(readFileSync(resolve(agentAssets, 'roles.json'), 'utf8'));

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
    assert.match(body, /~\/\.config\/ai-work-flow\/routing\.md/, name);
  }
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
  assert.equal(readdirSync(resolve(paths.home, '.codex/agents')).filter((name) => name.endsWith('.toml')).length, 9);
  assert.equal(readdirSync(resolve(paths.home, '.claude/agents')).filter((name) => name.endsWith('.md')).length, 9);
  assert.equal(readdirSync(resolve(paths.config, 'opencode/agents')).filter((name) => name.endsWith('.md')).length, 9);
  assert.match(readFileSync(agentPath(paths, 'codex', 'coordinator', 'toml'), 'utf8'), /~\/\.config\/ai-work-flow\/routing/);
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
  legacyConfig.roles.coordinator.codex.model = 'legacy-config-model';
  legacyConfig.version = 0;
  mkdirSync(resolve(paths.config, 'ai-work-flow'), { recursive: true });
  writeFileSync(legacyConfigPath(paths), `${JSON.stringify(legacyConfig, null, 2)}\n`);

  const result = run(paths, 'init');
  assert.equal(result.status, 0, result.stderr);

  const defaultConfig = JSON.parse(readFileSync(defaultEnvironmentPath(paths), 'utf8'));
  assert.notEqual(defaultConfig.roles.coordinator.codex.model, 'legacy-config-model');
  assert.equal(readFileSync(legacyConfigPath(paths), 'utf8'), `${JSON.stringify(legacyConfig, null, 2)}\n`);
  const validation = run(paths, 'validate');
  assert.equal(validation.status, 0, validation.stderr);
});

test('coordinator routes every required discovery phase through File Explorer', () => {
  const routing = readFileSync(resolve(agentAssets, 'routing.md'), 'utf8');
  const source = readFileSync(resolve(agentAssets, 'bodies/coordinator.md'), 'utf8');
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);

  for (const content of [routing, source]) {
    assert.match(content, /未知本地路径、文件搜索或枚举、代码地图、现有惯例或集成发现/);
    assert.match(content, /先委派 \*\*File Explorer\*\* 并等待其交接/);
    assert.match(content, /当前会话已有交接时可复用/);
    assert.match(content, /用户给出精确路径/);
    assert.match(content, /不得将发现阶段.*后续执行角色/);
  }
  assert.equal(
    readFileSync(resolve(paths.config, 'ai-work-flow/agent-assets/bodies/coordinator.md'), 'utf8'),
    source
  );
  assert.equal(readFileSync(resolve(paths.config, 'ai-work-flow/routing.md'), 'utf8'), routing);
  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    const generated = readFileSync(agentPath(paths, platform, 'coordinator', extension), 'utf8');
    assert.match(generated, /未知本地路径、文件搜索或枚举、代码地图、现有惯例或集成发现/);
    assert.match(generated, /先委派 \*\*File Explorer\*\* 并等待其交接/);
    assert.match(generated, /不得将发现阶段.*后续执行角色/);
  }
});

test('planning workflow persists plans and waits for user confirmation before implementation', () => {
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);

  const planningWriter = readFileSync(resolve(agentAssets, 'bodies/planning-writer.md'), 'utf8');
  const coordinator = readFileSync(resolve(agentAssets, 'bodies/coordinator.md'), 'utf8');
  const routing = readFileSync(resolve(agentAssets, 'routing.md'), 'utf8');

  assert.match(planningWriter, /\.ai-work-flow\/plans\/<planId>\.md/);
  assert.match(planningWriter, /不得实施/);
  assert.match(routing, /\*\*Planning Writer\*\* 写入计划、ADR/);
  for (const content of [coordinator, routing]) {
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
    const generatedCoordinator = readFileSync(agentPath(paths, platform, 'coordinator', extension), 'utf8');
    assert.match(generatedPlanningWriter, /\.ai-work-flow\/plans\/<planId>\.md/, platform);
    assert.match(generatedPlanningWriter, /不得实施/, platform);
    assert.match(generatedCoordinator, /等待用户明确确认/, platform);
    assert.match(generatedCoordinator, /不得自动.*实施/, platform);
  }
});

test('coordinator carries the retry and stop-lock policy into every generated platform', () => {
  const routing = readFileSync(resolve(agentAssets, 'routing.md'), 'utf8');
  const source = readFileSync(resolve(agentAssets, 'bodies/coordinator.md'), 'utf8');
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

  for (const content of [routing, source]) {
    for (const assertion of assertions) assert.match(content, assertion);
  }
  assert.equal(
    readFileSync(resolve(paths.config, 'ai-work-flow/agent-assets/bodies/coordinator.md'), 'utf8'),
    source
  );
  assert.equal(readFileSync(resolve(paths.config, 'ai-work-flow/routing.md'), 'utf8'), routing);
  for (const [platform, extension] of [['codex', 'toml'], ['claude', 'md'], ['opencode', 'md']]) {
    const generated = readFileSync(agentPath(paths, platform, 'coordinator', extension), 'utf8');
    for (const assertion of assertions) assert.match(generated, assertion, platform);
  }
});

test('platform generation enforces the declared workspace access where supported', () => {
  const paths = environment();
  const result = install(paths);
  assert.equal(result.status, 0, result.stderr);

  for (const role of catalog.roles) {
    const codex = readFileSync(agentPath(paths, 'codex', role.id, 'toml'), 'utf8');
    const claude = readFileSync(agentPath(paths, 'claude', role.id, 'md'), 'utf8');
    const openCode = readFileSync(agentPath(paths, 'opencode', role.id, 'md'), 'utf8');
    if (role.workspace === 'none' || role.workspace === 'read') {
      assert.match(codex, /sandbox_mode = "read-only"/, role.id);
      assert.match(claude, /permissionMode: plan/, role.id);
    } else {
      assert.match(codex, /sandbox_mode = "workspace-write"/, role.id);
      assert.match(claude, /permissionMode: acceptEdits/, role.id);
      assert.match(openCode, /permission: \{"edit":"allow"\}/, role.id);
    }
    if (role.workspace === 'none') {
      assert.match(openCode, /permission: \{"read":"deny","edit":"deny","bash":"deny"\}/, role.id);
    }
    if (role.workspace === 'read') {
      assert.match(openCode, /permission: \{"read":"allow","edit":"deny","bash":"deny"\}/, role.id);
    }
  }
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
    assert.ok(readFileSync(resolve(agentAssets, 'bodies', `${role.id}.md`), 'utf8').startsWith(`你是 **${displayName}**。`));
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
  writeFileSync(resolve(paths.config, 'opencode/opencode.json'), '{"theme":"user","agent":{"explore":false,"custom":{}}}\n');

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
  assert.equal(opencode.default_agent, 'coordinator');
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
  assert.ok(!existsSync(agentPath(paths, 'codex', 'coordinator', 'toml')));

  const opencodeOnly = run(paths, 'generate', '--platform', 'opencode');
  assert.equal(opencodeOnly.status, 0, opencodeOnly.stderr);
  assert.ok(existsSync(agentPath(paths, 'opencode', 'coordinator', 'md')));
  assert.ok(!existsSync(resolve(paths.home, '.codex')));
});

test('the installed asset catalog rejects inconsistent templates before generation writes', () => {
  const paths = environment();
  assert.equal(install(paths).status, 0);
  const generated = agentPath(paths, 'codex', 'coordinator', 'toml');
  writeFileSync(generated, 'preserved agent\n');
  writeFileSync(resolve(paths.config, 'ai-work-flow/agent-assets/bodies/coordinator.md'), '');

  const validation = runInstalledWorkflow(paths, 'validate');
  assert.equal(validation.status, 1);
  assert.match(validation.stderr, /Agent asset catalog is invalid:[\s\S]*Body template is empty: coordinator\.md/);

  const generation = runInstalledWorkflow(paths, 'generate', '--platform', 'codex');
  assert.equal(generation.status, 1);
  assert.match(generation.stderr, /Body template is empty: coordinator\.md/);
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
  assert.ok(!existsSync(agentPath(paths, 'codex', 'coordinator', 'toml')));
  assert.ok(!existsSync(agentPath(paths, 'claude', 'coordinator', 'md')));
  assert.ok(!existsSync(agentPath(paths, 'opencode', 'coordinator', 'md')));
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
      coordinator: {
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
  
  const coordinatorAgent = readFileSync(agentPath(paths, 'codex', 'coordinator', 'toml'), 'utf8');
  assert.match(coordinatorAgent, /model = "env-codex"/);
  assert.match(coordinatorAgent, /model_reasoning_effort = "low"/);
  
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

test('environment file not found gives clear error', () => {
  const paths = environment();
  assert.equal(install(paths).status, 0);
  
  writeFileSync(resolve(paths.config, 'ai-work-flow/.environment'), 'nonexistent');
  
  const result = run(paths, 'validate');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Environment file not found/);
});
