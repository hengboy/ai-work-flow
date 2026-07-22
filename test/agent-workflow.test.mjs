import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const skillRoot = resolve(root, 'skills/setup-matt-pocock-skills');
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

function configPath(paths) {
  return resolve(paths.config, 'ai-work-flow/config.json');
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
  assert.ok(existsSync(configPath(paths)));
  assert.ok(existsSync(resolve(paths.config, 'ai-work-flow/routing.md')));
  assert.ok(existsSync(resolve(paths.config, 'ai-work-flow/agent-workflow.mjs')));
  assert.equal(readdirSync(resolve(paths.home, '.codex/agents')).filter((name) => name.endsWith('.toml')).length, 9);
  assert.equal(readdirSync(resolve(paths.home, '.claude/agents')).filter((name) => name.endsWith('.md')).length, 9);
  assert.equal(readdirSync(resolve(paths.config, 'opencode/agents')).filter((name) => name.endsWith('.md')).length, 9);
  assert.match(readFileSync(agentPath(paths, 'codex', 'coordinator', 'toml'), 'utf8'), /~\/\.config\/ai-work-flow\/routing/);
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

test('skills use the catalog display name for Full Stack Coder', () => {
  for (const entry of readdirSync(resolve(root, 'skills'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = readFileSync(resolve(root, 'skills', entry.name, 'SKILL.md'), 'utf8');
    assert.doesNotMatch(source, /Full-Stack Coder/, entry.name);
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
  assert.match(readFileSync(resolve(paths.home, '.claude/CLAUDE.md'), 'utf8'), /@~\/\.config\/ai-work-flow\/routing\.md/);
  const opencode = JSON.parse(readFileSync(resolve(paths.config, 'opencode/opencode.json'), 'utf8'));
  assert.equal(opencode.theme, 'user');
  assert.equal(opencode.agent.explore, undefined);
  assert.deepEqual(opencode.agent.custom, {});
  assert.equal(opencode.default_agent, 'coordinator');
});

test('generate applies edited global configuration only to requested platforms', () => {
  const paths = environment();
  assert.equal(install(paths).status, 0);
  const claudeBefore = readFileSync(agentPath(paths, 'claude', 'full-stack-coder', 'md'), 'utf8');
  const config = JSON.parse(readFileSync(configPath(paths), 'utf8'));
  config.roles['full-stack-coder'].codex = { model: 'local-codex', reasoning: 'low' };
  writeFileSync(configPath(paths), `${JSON.stringify(config, null, 2)}\n`);

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
  assert.ok(!existsSync(configPath(paths)));
  const dryInstall = run(paths, 'install', '--dry-run');
  assert.equal(dryInstall.status, 0, dryInstall.stderr);
  assert.ok(!existsSync(resolve(paths.home, '.codex')));
  assert.ok(!existsSync(resolve(paths.config, 'opencode')));

  assert.equal(run(paths, 'init').status, 0);
  const config = JSON.parse(readFileSync(configPath(paths), 'utf8'));
  config.roles.researcher.codex.reasoning = 'extreme';
  writeFileSync(configPath(paths), `${JSON.stringify(config)}\n`);
  const invalid = run(paths, 'validate');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /researcher\.codex\.reasoning must be low, medium, or high/);

  config.roles.researcher.codex.reasoning = 'medium';
  writeFileSync(configPath(paths), `${JSON.stringify(config)}\n`);
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

test('each platform adapter validates its own preservation work before writing its files', () => {
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
  assert.ok(existsSync(agentPath(paths, 'codex', 'coordinator', 'toml')));
  assert.ok(!existsSync(agentPath(paths, 'claude', 'coordinator', 'md')));
  assert.ok(!existsSync(agentPath(paths, 'opencode', 'coordinator', 'md')));
});

test('repeated installation is idempotent and the global workflow is independent from setup', () => {
  const paths = environment();
  assert.equal(install(paths).status, 0);
  const repeated = install(paths);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /Generated 0 file\(s\)\./);

  mkdirSync(paths.project, { recursive: true });
  assert.ok(!existsSync(resolve(paths.home, '.codex/skills/setup-matt-pocock-skills/scripts')));
  assert.ok(!existsSync(resolve(paths.home, '.codex/skills/setup-matt-pocock-skills/assets')));
  const result = runInstalledWorkflow(paths, 'validate');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(paths.project), []);
});

test('restored setup skill only describes project configuration', () => {
  const source = readFileSync(resolve(skillRoot, 'SKILL.md'), 'utf8');
  assert.match(source, /^name: setup-matt-pocock-skills$/m);
  assert.doesNotMatch(source, /scripts\/install\.mjs|agent-workflow\.mjs|Agent\/Subagent/);
  const askMatt = readFileSync(resolve(root, 'skills/ask-matt/SKILL.md'), 'utf8');
  assert.match(askMatt, /^name: ask-matt$/m);
  assert.ok(!existsSync(resolve(root, 'skills/ask-ai-work-flow')));
  assert.ok(!existsSync(resolve(root, 'skills/setup-ai-work-flow')));
});

test('all shipped skills route through the global routing file', () => {
  for (const entry of readdirSync(resolve(root, 'skills'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = readFileSync(resolve(root, 'skills', entry.name, 'SKILL.md'), 'utf8');
    assert.match(source, /## 专职代理路由/, entry.name);
    assert.match(source, /~\/\.config\/ai-work-flow\/routing\.md/, entry.name);
    assert.doesNotMatch(source, /\.ai-work-flow\/agents\/routing\.md/, entry.name);
  }
});

test('grill-with-docs assigns discussion-time CONTEXT.md updates to Document Maintainer', () => {
  const source = readFileSync(resolve(root, 'skills/grill-with-docs/SKILL.md'), 'utf8');
  assert.match(source, /只委派 \*\*Document Maintainer\*\* 即时更新项目的 `CONTEXT\.md`/);
  assert.match(source, /不得将此写入委派给 \*\*Planning Writer\*\*/);
});
