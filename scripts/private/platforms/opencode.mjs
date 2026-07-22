import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { fail, isPlainObject, readJson, write } from '../shared.mjs';

function agentDescription(role) {
  return `**${role.name}**: ${role.description}`;
}

function permission(role) {
  if (role.workspace === 'none') return { read: 'deny', edit: 'deny', bash: 'deny' };
  if (role.workspace === 'read') return { read: 'allow', edit: 'deny', bash: 'deny' };
  return { edit: 'allow' };
}

function render(role, settings, body) {
  const frontmatter = [
    '---',
    `description: ${JSON.stringify(agentDescription(role))}`,
    `mode: ${role.kind === 'primary' ? 'primary' : 'subagent'}`,
    `permission: ${JSON.stringify(permission(role))}`
  ];
  if (settings.model) frontmatter.splice(3, 0, `model: ${settings.model}`);
  if (settings.variant) frontmatter.push(`variant: ${JSON.stringify(settings.variant)}`);
  if (isPlainObject(settings.options) && Object.keys(settings.options).length) frontmatter.push(`options: ${JSON.stringify(settings.options)}`);
  frontmatter.push('---', '', body, '');
  return frontmatter.join('\n');
}

function explicitSubagentModels(roles, config) {
  return Object.fromEntries(roles
    .filter((role) => role.kind !== 'primary')
    .map((role) => [role.id, config.roles[role.id].opencode])
    .filter(([, settings]) => settings.model && settings.variant)
    .map(([id, settings]) => [id, { model: settings.model, variant: settings.variant }]));
}

function renderModelGuard(models) {
  return `// OpenCode automatically discovers global plugins in ~/.config/opencode/plugins.
// Model resolution completes before chat.message; no earlier hook exposes both model and variant.
const EXPECTED = ${JSON.stringify(models)};
const pendingTasks = new Map();
const childParents = new Map();
const childTasks = new Map();
const checkedChildren = new Set();

function modelParts(model) {
  const separator = model.indexOf('/');
  return {
    providerID: model.slice(0, separator),
    modelID: model.slice(separator + 1)
  };
}

function matches(expected, model, variant) {
  const expectedModel = modelParts(expected.model);
  return expectedModel.providerID === model.providerID
    && expectedModel.modelID === model.modelID
    && expected.variant === variant;
}

function takePendingTask(parentID, agent) {
  const tasks = pendingTasks.get(parentID);
  if (!tasks) return undefined;
  const index = tasks.findIndex((task) => task.agent === agent);
  if (index === -1) return undefined;
  const [task] = tasks.splice(index, 1);
  if (!tasks.length) pendingTasks.delete(parentID);
  return task;
}

function responseData(response) {
  if (response && typeof response === 'object' && 'error' in response && response.error) {
    throw new Error(String(response.error));
  }
  return response && typeof response === 'object' && 'data' in response ? response.data : response;
}

export async function AiWorkFlowSubagentModelGuard({ client }) {
  async function report(parentID, message) {
    console.error(\`[ai-work-flow] \${message}\`);
    await client.session.prompt({
      path: { id: parentID },
      body: {
        noReply: true,
        parts: [{ type: 'text', synthetic: true, text: \`[ai-work-flow] \${message}\` }]
      }
    }).catch(() => undefined);
  }

  async function retry(parentID, task) {
    const expected = EXPECTED[task.agent];
    const session = responseData(await client.session.create({
      body: { parentID, title: \`\${task.description} (@\${task.agent} subagent)\` }
    }));
    if (!session || !session.id) throw new Error('OpenCode did not return a retry session.');
    childTasks.set(session.id, { ...task, parentID, retries: 1 });
    await client.session.prompt({
      path: { id: session.id },
      body: {
        agent: task.agent,
        model: modelParts(expected.model),
        parts: [{ type: 'text', text: task.prompt }]
      }
    });
  }

  return {
    'tool.execute.before': async (input, output) => {
      if (input.tool !== 'task') return;
      const args = output.args;
      if (!args || typeof args.description !== 'string' || typeof args.prompt !== 'string'
        || typeof args.subagent_type !== 'string' || !EXPECTED[args.subagent_type]) return;
      const tasks = pendingTasks.get(input.sessionID) ?? [];
      tasks.push({
        agent: args.subagent_type,
        description: args.description,
        prompt: args.prompt,
        retries: 0
      });
      pendingTasks.set(input.sessionID, tasks);
    },
    event: async ({ event }) => {
      if (event.type === 'session.created' && event.properties.info.parentID) {
        childParents.set(event.properties.info.id, event.properties.info.parentID);
      }
    },
    'chat.message': async (input) => {
      const knownTask = childTasks.get(input.sessionID);
      let parentID = childParents.get(input.sessionID) ?? knownTask?.parentID;
      if (!parentID) {
        try {
          const session = responseData(await client.session.get({ path: { id: input.sessionID } }));
          parentID = session?.parentID;
        } catch {
          return;
        }
      }
      if (!parentID || checkedChildren.has(input.sessionID)) return;
      const task = knownTask ?? takePendingTask(parentID, input.agent);
      if (!task) return;
      childTasks.set(input.sessionID, task);
      checkedChildren.add(input.sessionID);
      const expected = EXPECTED[task.agent];
      if (matches(expected, input.model, input.variant)) return;

      await client.session.abort({ path: { id: input.sessionID } });
      const actual = \`\${input.model.providerID}/\${input.model.modelID}@\${input.variant ?? 'default'}\`;
      const required = \`\${expected.model}@\${expected.variant}\`;
      if (task.retries >= 1) {
        await report(parentID, \`Subagent model guard retry exhausted for \${task.agent}: expected \${required}, received \${actual}. The child session was aborted after its one permitted retry.\`);
        return;
      }
      try {
        await retry(parentID, task);
      } catch (error) {
        await report(parentID, \`Subagent model guard retry exhausted for \${task.agent}: expected \${required}, received \${actual}. The retry could not be started: \${error.message}\`);
      }
    }
  };
}
`;
}

function updateConfig(path) {
  const current = existsSync(path) ? readJson(path) : {};
  if (!isPlainObject(current)) fail(`Cannot safely merge ${path}: root must be an object.`);
  if (current.agent !== undefined && !isPlainObject(current.agent)) {
    fail(`Cannot safely merge ${path}: agent must be an object.`);
  }
  const agent = { ...(current.agent ?? {}) };
  // OpenCode expects agent.explore to be an object when present; older output used false.
  if (agent.explore === false) delete agent.explore;
  return `${JSON.stringify({ ...current, agent, default_agent: 'coordinator' }, null, 2)}\n`;
}

export function generateOpenCode({ paths, roles, config, bodies, dryRun }) {
  const changed = [];
  const configPath = resolve(paths.openCodeDir, 'opencode.json');
  const configContents = updateConfig(configPath);
  for (const role of roles) {
    write(resolve(paths.openCodeDir, `agents/${role.id}.md`), render(role, config.roles[role.id].opencode, bodies.get(role.id)), dryRun, changed);
  }
  write(
    resolve(paths.openCodeDir, 'plugins/ai-work-flow-subagent-model-guard.js'),
    renderModelGuard(explicitSubagentModels(roles, config)),
    dryRun,
    changed
  );
  write(configPath, configContents, dryRun, changed);
  return changed;
}
