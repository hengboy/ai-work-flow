import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const setupSkill = resolve(root, 'skills/setup-ai-work-flow');
const script = resolve(setupSkill, 'scripts/agent-workflow.mjs');

function fixture() {
  return mkdtempSync(resolve(tmpdir(), 'agent-workflow-'));
}

function run(target, ...args) {
  return spawnSync(process.execPath, [script, ...args, '--target', target], {
    cwd: root,
    encoding: 'utf8'
  });
}

function init(target) {
  const result = run(target, 'init');
  assert.equal(result.status, 0, result.stderr);
}

test('a standalone setup skill initializes the current project directly', () => {
  const installation = fixture();
  const installedSkill = resolve(installation, 'setup-ai-work-flow');
  const target = fixture();
  cpSync(setupSkill, installedSkill, { recursive: true });
  const coordinatorBody = resolve(installedSkill, 'assets/agents/bodies/coordinator.md');
  writeFileSync(coordinatorBody, `${readFileSync(coordinatorBody, 'utf8')}Template body probe.\n`);

  const result = spawnSync(process.execPath, [resolve(installedSkill, 'scripts/agent-workflow.mjs'), 'setup'], {
    cwd: target,
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Initialized .*\.ai-work-flow\/agents/);
  assert.equal(readdirSync(resolve(target, '.codex/agents')).length, 9);
  assert.equal(readdirSync(resolve(target, '.claude/agents')).length, 9);
  assert.equal(readdirSync(resolve(target, '.opencode/agents')).length, 9);
  assert.match(readFileSync(resolve(target, '.codex/agents/coordinator.toml'), 'utf8'), /Template body probe\./);
  assert.match(readFileSync(resolve(target, '.claude/agents/coordinator.md'), 'utf8'), /Template body probe\./);
  assert.match(readFileSync(resolve(target, '.opencode/agents/coordinator.md'), 'utf8'), /Template body probe\./);

  const repeated = spawnSync(process.execPath, [resolve(installedSkill, 'scripts/agent-workflow.mjs'), 'setup'], {
    cwd: target,
    encoding: 'utf8'
  });
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /Generated 0 file\(s\)\./);
});

test('every role has one shared body template without platform formatting', () => {
  const catalog = JSON.parse(readFileSync(resolve(setupSkill, 'assets/agents/roles.json'), 'utf8'));
  const expected = catalog.roles.map((role) => `${role.id}.md`).sort();
  const bodiesPath = resolve(setupSkill, 'assets/agents/bodies');
  assert.deepEqual(readdirSync(bodiesPath).sort(), expected);

  for (const name of expected) {
    const body = readFileSync(resolve(bodiesPath, name), 'utf8');
    assert.doesNotMatch(body, /^---$/m, name);
    assert.doesNotMatch(body, /^(name|model|sandbox_mode|permissionMode)\s*[:=]/m, name);
  }
});

test('init creates versioned defaults and an ignored local override example', () => {
  const target = fixture();
  init(target);
  assert.ok(existsSync(resolve(target, '.ai-work-flow/agents/config.json')));
  assert.match(readFileSync(resolve(target, '.ai-work-flow/agents/.gitignore'), 'utf8'), /^config\.local\.json$/m);
  assert.match(readFileSync(resolve(target, '.ai-work-flow/agents/config.local.example.json'), 'utf8'), /provider\/model/);
});

test('init preserves existing project defaults and local ignore entries', () => {
  const target = fixture();
  init(target);
  const configPath = resolve(target, '.ai-work-flow/agents/config.json');
  const ignorePath = resolve(target, '.ai-work-flow/agents/.gitignore');
  writeFileSync(configPath, '{"version":1,"roles":{}}\n');
  writeFileSync(ignorePath, 'private-notes\n');
  init(target);
  assert.equal(readFileSync(configPath, 'utf8'), '{"version":1,"roles":{}}\n');
  assert.equal(readFileSync(ignorePath, 'utf8'), 'private-notes\nconfig.local.json\n');
});

test('generate preserves user files and produces restricted role definitions', () => {
  const target = fixture();
  init(target);
  writeFileSync(resolve(target, 'AGENTS.md'), '# Existing user guidance\n');
  writeFileSync(resolve(target, 'CLAUDE.md'), '# Existing Claude guidance\n');
  mkdirSync(resolve(target, '.codex'), { recursive: true });
  writeFileSync(resolve(target, '.codex/config.toml'), 'model = "user-model"\n[agents]\nmax_depth = 1\n');
  writeFileSync(resolve(target, 'opencode.json'), '{\n  "theme": "user-theme",\n  "agent": { "custom": { "mode": "subagent" } }\n}\n');

  const result = run(target, 'generate');
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(resolve(target, 'AGENTS.md'), 'utf8'), /^# Existing user guidance/m);
  assert.match(readFileSync(resolve(target, 'CLAUDE.md'), 'utf8'), /^# Existing Claude guidance/m);
  assert.match(readFileSync(resolve(target, '.codex/config.toml'), 'utf8'), /^model = "user-model"/m);
  assert.match(readFileSync(resolve(target, '.codex/config.toml'), 'utf8'), /^max_depth = 2$/m);

  const openCode = JSON.parse(readFileSync(resolve(target, 'opencode.json'), 'utf8'));
  assert.equal(openCode.theme, 'user-theme');
  assert.equal(openCode.agent.explore, false);
  assert.equal(openCode.agent.custom.mode, 'subagent');
  assert.match(readFileSync(resolve(target, '.opencode/agents/coordinator.md'), 'utf8'), /"read":"deny","edit":"deny","bash":"deny"/);
  assert.doesNotMatch(readFileSync(resolve(target, '.opencode/agents/coordinator.md'), 'utf8'), /model: inherit/);
  assert.match(readFileSync(resolve(target, '.claude/agents/code-reviewer.md'), 'utf8'), /并行委派标准审查和规范审查/);
  assert.match(readFileSync(resolve(target, '.claude/agents/code-reviewer.md'), 'utf8'), /tools: Read, Glob, Grep, Bash, Task/);
  assert.doesNotMatch(readFileSync(resolve(target, '.claude/agents/full-stack-coder.md'), 'utf8'), /Task/);
  assert.match(readFileSync(resolve(target, '.codex/agents/full-stack-coder.toml'), 'utf8'), /model_reasoning_effort = "high"/);
  assert.equal(readdirSync(resolve(target, '.codex/agents')).length, 9);
  assert.equal(readdirSync(resolve(target, '.claude/agents')).length, 9);
  assert.equal(readdirSync(resolve(target, '.opencode/agents')).length, 9);
});

test('local configuration takes priority and OpenCode native overrides remove its warning', () => {
  const target = fixture();
  init(target);
  writeFileSync(resolve(target, '.ai-work-flow/agents/config.local.json'), JSON.stringify({
    roles: {
      'full-stack-coder': {
        codex: { model: 'local-codex' },
        opencode: { model: 'openai/local-model', variant: 'high', options: { reasoning: 'high' } }
      }
    }
  }));
  const result = run(target, 'validate');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /full-stack-coder: OpenCode/);
  const generate = run(target, 'generate', '--platform', 'codex,opencode');
  assert.equal(generate.status, 0, generate.stderr);
  assert.match(readFileSync(resolve(target, '.codex/agents/full-stack-coder.toml'), 'utf8'), /model = "local-codex"/);
  assert.match(readFileSync(resolve(target, '.opencode/agents/full-stack-coder.md'), 'utf8'), /model: openai\/local-model/);
  assert.match(readFileSync(resolve(target, '.opencode/agents/full-stack-coder.md'), 'utf8'), /variant: "high"/);
});

test('validate rejects invalid reasoning and dry runs do not write generated files', () => {
  const target = fixture();
  init(target);
  writeFileSync(resolve(target, '.ai-work-flow/agents/config.local.json'), JSON.stringify({
    roles: { researcher: { codex: { reasoning: 'extreme' } } }
  }));
  const invalid = run(target, 'validate');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /researcher\.codex\.reasoning must be low, medium, or high/);

  writeFileSync(resolve(target, '.ai-work-flow/agents/config.local.json'), '{}\n');
  const dryRun = run(target, 'generate', '--dry-run');
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.ok(!existsSync(resolve(target, '.codex/agents/coordinator.toml')));
  assert.ok(!existsSync(resolve(target, 'AGENTS.md')));
});

test('validate warns about OpenCode inheritance and generation rejects unsafe merges', () => {
  const target = fixture();
  init(target);
  const validation = run(target, 'validate');
  assert.equal(validation.status, 0, validation.stderr);
  assert.match(validation.stderr, /OpenCode inherits the primary-session model/);
  assert.match(validation.stderr, /OpenCode does not map generic reasoning effort/);

  mkdirSync(resolve(target, '.codex'), { recursive: true });
  writeFileSync(resolve(target, '.codex/config.toml'), 'features = [\n');
  const unsafeToml = run(target, 'generate', '--platform', 'codex');
  assert.equal(unsafeToml.status, 1);
  assert.match(unsafeToml.stderr, /Cannot safely parse existing TOML/);
  assert.ok(!existsSync(resolve(target, '.codex/agents/coordinator.toml')));

  writeFileSync(resolve(target, '.codex/config.toml'), 'model = "safe"\n');
  writeFileSync(resolve(target, 'opencode.json'), '{"agent":"not-an-object"}\n');
  const unsafeOpenCode = run(target, 'generate', '--platform', 'opencode');
  assert.equal(unsafeOpenCode.status, 1);
  assert.match(unsafeOpenCode.stderr, /agent must be an object/);
  assert.equal(JSON.parse(readFileSync(resolve(target, 'opencode.json'), 'utf8')).agent, 'not-an-object');
  assert.ok(!existsSync(resolve(target, '.opencode/agents/coordinator.md')));
});

test('every shipped skill uses the specialized-agent routing rule', () => {
  const skills = readdirSync(resolve(root, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(root, 'skills', entry.name, 'SKILL.md'));
  assert.ok(skills.length > 0);
  for (const skill of skills) {
    const source = readFileSync(skill, 'utf8');
    assert.match(source, /## 专职代理路由/, skill);
    assert.match(source, /下文的每个命令和第二人称/, skill);
    assert.doesNotMatch(source, /subagent_type=Explore/, skill);
  }
});
