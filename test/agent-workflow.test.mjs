import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const skillRoot = resolve(root, 'skills/setup-ai-work-flow');
const workflow = resolve(skillRoot, 'scripts/agent-workflow.mjs');
const installer = resolve(root, 'scripts/install.mjs');
const catalog = JSON.parse(readFileSync(resolve(skillRoot, 'assets/agents/roles.json'), 'utf8'));

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
  return spawnSync(process.execPath, [workflow, ...args], {
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
  const bodies = resolve(skillRoot, 'assets/agents/bodies');
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
  assert.equal(readdirSync(resolve(paths.home, '.codex/agents')).filter((name) => name.endsWith('.toml')).length, 9);
  assert.equal(readdirSync(resolve(paths.home, '.claude/agents')).filter((name) => name.endsWith('.md')).length, 9);
  assert.equal(readdirSync(resolve(paths.config, 'opencode/agents')).filter((name) => name.endsWith('.md')).length, 9);
  assert.match(readFileSync(agentPath(paths, 'codex', 'coordinator', 'toml'), 'utf8'), /~\/\.config\/ai-work-flow\/routing/);
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

  const result = run(paths, 'setup');
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

  const result = run(paths, 'generate', '--platform', 'codex');
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
  const drySetup = run(paths, 'setup', '--dry-run');
  assert.equal(drySetup.status, 0, drySetup.stderr);
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

test('repeated installation is idempotent and installed setup does not write the project', () => {
  const paths = environment();
  assert.equal(install(paths).status, 0);
  const repeated = install(paths);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /Generated 0 file\(s\)\./);

  mkdirSync(paths.project, { recursive: true });
  const installedWorkflow = resolve(paths.home, '.codex/skills/setup-ai-work-flow/scripts/agent-workflow.mjs');
  const result = spawnSync(process.execPath, [installedWorkflow, 'setup'], {
    cwd: paths.project,
    encoding: 'utf8',
    env: env(paths)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(paths.project), []);
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
