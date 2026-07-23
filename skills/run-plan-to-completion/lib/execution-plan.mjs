import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { derivePlanLocation, executionPlanPath, sourcePlanPath } from "./paths.mjs";
import { toShanghaiTimestamp } from "./time.mjs";
import { assertExecutionPlan } from "./validation.mjs";

function titleFrom(content, fallback) {
  return content.match(/^#\s+(.+)$/m)?.[1].trim() || fallback;
}

function workItemCountFrom(content) {
  return [...content.matchAll(/^\s*- \[[ xX]\]\s+.+$/gm)].length;
}

function blockedByFrom(content) {
  const value = content.match(/^(?:\*\*)?Dependencies:(?:\*\*)?\s*(.*)$/mi)?.[1] || "";
  return [...new Set(value.match(/\b\d+\b/g) || [])];
}

function levelsFor(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const resolving = new Set();
  const resolved = new Map();

  function level(task) {
    if (resolved.has(task.id)) return resolved.get(task.id);
    if (resolving.has(task.id)) throw new Error(`Task dependency cycle includes ${task.id}`);
    resolving.add(task.id);
    const blockerLevels = task.blocked_by.map((id) => {
      const blocker = byId.get(id);
      if (!blocker) throw new Error(`Task ${task.id} references unknown blocker ${id}`);
      return level(blocker);
    });
    resolving.delete(task.id);
    const result = blockerLevels.length === 0 ? 0 : Math.max(...blockerLevels) + 1;
    resolved.set(task.id, result);
    return result;
  }

  return tasks.map((task) => ({ ...task, level: level(task) }));
}

function revisionFor(facts) {
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex");
}

function relativePathWithin(worktree, path) {
  const relativePath = relative(worktree, path);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Plan artifact must be inside the main worktree: ${path}`);
  }
  return relativePath;
}

async function sourceRefWithin(worktree, path) {
  return relativePathWithin(worktree, await realpath(path));
}

const DIRECT_EXECUTION_MAX_CONTENT_LENGTH = 1000;
const DIRECT_EXECUTION_MAX_WORK_ITEMS = 2;
const COMPLEX_TASK_PATTERN = /\b(?:database|migration|schema|auth(?:entication|orization)?|security|payment|billing|deploy(?:ment)?|release|api|breaking|performance|concurren(?:cy|t)|parallel|integrat(?:e|ion)|distributed|cache)\b|数据库|数据迁移|迁移|鉴权|认证|授权|安全|支付|账单|部署|发布|接口|兼容|性能|并发|集成|分布式|缓存/i;

function executionModeFor(tasks) {
  if (tasks.length !== 1) return "delegated";
  const [task] = tasks;
  const work = `${task.title}\n${task.content}`;
  if (task.content.length > DIRECT_EXECUTION_MAX_CONTENT_LENGTH) return "delegated";
  if (task.work_item_count > DIRECT_EXECUTION_MAX_WORK_ITEMS) return "delegated";
  return COMPLEX_TASK_PATTERN.test(work) ? "delegated" : "coordinator";
}

function executionTaskFrom({ content, work_item_count, ...task }) {
  return task;
}

export async function materializeLocalPlan({ mainWorktree, planPath, now = new Date() }) {
  now = toShanghaiTimestamp(now);
  const requestedLocation = derivePlanLocation(mainWorktree, planPath);
  const mainRoot = await realpath(mainWorktree);
  const sourcePlanPath = await realpath(requestedLocation.absolutePath);
  const location = derivePlanLocation(mainRoot, sourcePlanPath);
  if (location.planId !== requestedLocation.planId || location.path !== requestedLocation.path) {
    throw new Error("Plan path must not resolve through a symlink");
  }
  const planRef = await sourceRefWithin(mainRoot, sourcePlanPath);
  if (planRef !== location.path) throw new Error("Plan path must not resolve through a symlink");
  const planContent = await readFile(sourcePlanPath, "utf8");
  const tasksDirectory = join(sourcePlanPath, "..", "tasks");
  const taskNames = await readdir(tasksDirectory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const taskFiles = taskNames.filter((name) => /^\d+-.+\.md$/.test(name)).sort();
  const sourceTasks = await Promise.all(taskFiles.map(async (name) => {
    const taskPath = join(tasksDirectory, name);
    const content = await readFile(taskPath, "utf8");
    const [, id, slug] = name.match(/^(\d+)-(.+)\.md$/);
    return {
      id,
      ref: await sourceRefWithin(mainRoot, taskPath),
      title: titleFrom(content, slug),
      blocked_by: blockedByFrom(content),
      work_item_count: workItemCountFrom(content),
      content,
    };
  }));
  if (sourceTasks.length === 0) {
    throw new Error(`Plan has no task files: ${join(location.path, "..", "tasks")}`);
  }
  const taskIds = new Set();
  for (const task of sourceTasks) {
    if (taskIds.has(task.id)) throw new Error(`Duplicate derived task ID: ${task.id}`);
    taskIds.add(task.id);
  }
  const tasks = levelsFor(sourceTasks);
  const facts = {
    version: 1,
    created_at: now,
    execution_mode: executionModeFor(tasks),
    plan: { ref: planRef, plan_id: location.planId, title: titleFrom(planContent, location.planId) },
    tasks: tasks.map(executionTaskFrom),
  };
  return { ...facts, revision: revisionFor(facts) };
}

export async function writeExecutionPlan(worktree, executionPlan) {
  verifyExecutionPlan(executionPlan);
  const path = join(worktree, executionPlanPath(executionPlan.plan.plan_id));
  await mkdir(join(worktree, ".ai-work-flow", "plans", executionPlan.plan.plan_id), { recursive: true });
  await writeFile(path, `${JSON.stringify(executionPlan, null, 2)}\n`);
  return path;
}

export async function readExecutionPlan(worktree, planId) {
  return verifyExecutionPlan(JSON.parse(await readFile(join(worktree, executionPlanPath(planId)), "utf8")));
}

async function pathWithin(worktree, path) {
  return relativePathWithin(await realpath(worktree), await realpath(path));
}

export async function assertPlanArtifactsInMainWorktree({ mainWorktree, executionPlan }) {
  const mainRoot = await realpath(mainWorktree);
  await pathWithin(mainRoot, resolve(mainRoot, executionPlan.plan.ref));
  await Promise.all(executionPlan.tasks.map((task) => pathWithin(mainRoot, resolve(mainRoot, task.ref))));
}

export function createTaskReader({ mainWorktree, executionPlan }) {
  return async function readTask(taskId) {
    const { taskPath } = await localTaskPath({ mainWorktree, executionPlan, taskId });
    return readFile(taskPath, "utf8");
  };
}

export async function markLocalTaskComplete({ mainWorktree, executionPlan, taskId }) {
  const { taskPath, relativePath } = await localTaskPath({ mainWorktree, executionPlan, taskId });
  const content = await readFile(taskPath, "utf8");
  const updated = content.replace(/^(\s*-\s*)\[ \]/gm, "$1[x]");
  if (updated === content) return [];
  await writeFile(taskPath, updated);
  return [relativePath];
}

export async function localTaskPaths({ mainWorktree, executionPlan }) {
  return Promise.all(executionPlan.tasks.map(async ({ id: taskId }) => {
    const { relativePath } = await localTaskPath({ mainWorktree, executionPlan, taskId });
    return relativePath;
  }));
}

async function localTaskPath({ mainWorktree, executionPlan, taskId }) {
  const task = executionPlan.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`Unknown plan task: ${taskId}`);
  const taskPath = resolve(await realpath(mainWorktree), task.ref);
  return { taskPath, relativePath: await pathWithin(mainWorktree, taskPath) };
}

export function verifyExecutionPlan(executionPlan) {
  assertExecutionPlan(executionPlan);
  if (executionPlan.plan.ref !== sourcePlanPath(executionPlan.plan.plan_id)) {
    throw new Error("Execution plan reference does not match its plan_id");
  }
  if (executionPlan.execution_mode === "coordinator" && executionPlan.tasks.length !== 1) {
    throw new Error("Coordinator execution is only available for a single-task plan");
  }
  const { revision, ...facts } = executionPlan;
  if (revisionFor(facts) !== revision) throw new Error("Execution plan revision does not match its immutable facts");
  return executionPlan;
}
