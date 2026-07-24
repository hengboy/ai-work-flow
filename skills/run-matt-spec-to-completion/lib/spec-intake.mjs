import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { deriveSpecLocation, executionPlanPath, sourceSpecPath } from "./paths.mjs";
import { toShanghaiTimestamp } from "./time.mjs";
import { assertExecutionPlan } from "./validation.mjs";

function titleFrom(content, fallback) {
  return content.match(/^#\s+\d+\s*[—\-]\s*(.+)$/m)?.[1].trim()
    || content.match(/^#\s+(.+)$/m)?.[1].trim()
    || fallback;
}

function workItemCountFrom(content) {
  return [...content.matchAll(/^\s*- \[[ xX]\]\s+.+$/gm)].length;
}

function blockedByFrom(content) {
  const value = content.match(/^(?:\*\*)?Blocked by:(?:\*\*)?\s*(.*)$/mi)?.[1] || "";
  return [...new Set(value.match(/\b\d+\b/g) || [])];
}

function levelsFor(tickets) {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const resolving = new Set();
  const resolved = new Map();

  function level(ticket) {
    if (resolved.has(ticket.id)) return resolved.get(ticket.id);
    if (resolving.has(ticket.id)) throw new Error(`Ticket dependency cycle includes ${ticket.id}`);
    resolving.add(ticket.id);
    const blockerLevels = ticket.blocked_by.map((id) => {
      const blocker = byId.get(id);
      if (!blocker) throw new Error(`Ticket ${ticket.id} references unknown blocker ${id}`);
      return level(blocker);
    });
    resolving.delete(ticket.id);
    const result = blockerLevels.length === 0 ? 0 : Math.max(...blockerLevels) + 1;
    resolved.set(ticket.id, result);
    return result;
  }

  return tickets.map((ticket) => ({ ...ticket, level: level(ticket) }));
}

export function verifyTicketDependencies(tickets) {
  const ticketIds = new Set();
  for (const ticket of tickets) {
    if (ticketIds.has(ticket.id)) throw new Error(`Duplicate execution plan ticket ID: ${ticket.id}`);
    ticketIds.add(ticket.id);
  }
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  for (const ticket of tickets) {
    if (!Array.isArray(ticket.blocked_by)) throw new Error(`Ticket ${ticket.id} must declare blocked_by`);
    const blockers = ticket.blocked_by.map((blockerId) => {
      const blocker = byId.get(blockerId);
      if (!blocker) throw new Error(`Ticket ${ticket.id} references unknown blocker ${blockerId}`);
      return blocker;
    });
    const expectedLevel = blockers.length === 0 ? 0 : Math.max(...blockers.map((blocker) => blocker.level)) + 1;
    if (ticket.level !== expectedLevel) {
      const blocker = blockers.find((candidate) => candidate.level === expectedLevel - 1);
      throw new Error(blocker
        ? `Ticket ${ticket.id} level must follow blocker ${blocker.id}`
        : `Ticket ${ticket.id} without blockers must be level 0`);
    }
  }
  return tickets;
}

function revisionFor(facts) {
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex");
}

function relativePathWithin(worktree, path) {
  const relativePath = relative(worktree, path);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Spec artifact must be inside the main worktree: ${path}`);
  }
  return relativePath;
}

async function sourceRefWithin(worktree, path) {
  return relativePathWithin(worktree, await realpath(path));
}

const DIRECT_EXECUTION_MAX_CONTENT_LENGTH = 1000;
const DIRECT_EXECUTION_MAX_WORK_ITEMS = 2;
const COMPLEX_TICKET_PATTERN = /\b(?:database|migration|schema|auth(?:entication|orization)?|security|payment|billing|deploy(?:ment)?|release|api|breaking|performance|concurren(?:cy|t)|parallel|integrat(?:e|ion)|distributed|cache)\b|数据库|数据迁移|迁移|鉴权|认证|授权|安全|支付|账单|部署|发布|接口|兼容|性能|并发|集成|分布式|缓存/i;

function executionModeFor(tickets) {
  if (tickets.length !== 1) return "delegated";
  const [ticket] = tickets;
  const work = `${ticket.title}\n${ticket.content}`;
  if (ticket.content.length > DIRECT_EXECUTION_MAX_CONTENT_LENGTH) return "delegated";
  if (ticket.work_item_count > DIRECT_EXECUTION_MAX_WORK_ITEMS) return "delegated";
  return COMPLEX_TICKET_PATTERN.test(work) ? "delegated" : "coordinator";
}

function executionTicketFrom({ content, work_item_count, ...ticket }) {
  return ticket;
}

export async function materializeSpec({ mainWorktree, specPath, now = new Date() }) {
  now = toShanghaiTimestamp(now);
  const requestedLocation = deriveSpecLocation(mainWorktree, specPath);
  const mainRoot = await realpath(mainWorktree);
  const resolvedSpecPath = await realpath(requestedLocation.absolutePath);
  const location = deriveSpecLocation(mainRoot, resolvedSpecPath);
  if (location.featureSlug !== requestedLocation.featureSlug || location.path !== requestedLocation.path) {
    throw new Error("Spec path must not resolve through a symlink");
  }
  const specRef = await sourceRefWithin(mainRoot, resolvedSpecPath);
  if (specRef !== location.path) throw new Error("Spec path must not resolve through a symlink");
  const specContent = await readFile(resolvedSpecPath, "utf8");
  const issuesDirectory = join(resolvedSpecPath, "..", "issues");
  const issueNames = await readdir(issuesDirectory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const issueFiles = issueNames.filter((name) => /^\d+-.+\.md$/.test(name)).sort();
  const sourceTickets = await Promise.all(issueFiles.map(async (name) => {
    const issuePath = join(issuesDirectory, name);
    const content = await readFile(issuePath, "utf8");
    const [, id, slug] = name.match(/^(\d+)-(.+)\.md$/);
    return {
      id,
      ref: await sourceRefWithin(mainRoot, issuePath),
      title: titleFrom(content, slug),
      blocked_by: blockedByFrom(content),
      work_item_count: workItemCountFrom(content),
      content,
    };
  }));
  if (sourceTickets.length === 0) {
    throw new Error(`Spec has no issue files: ${join(location.path, "..", "issues")}`);
  }
  const seenIds = new Set();
  for (const ticket of sourceTickets) {
    if (seenIds.has(ticket.id)) throw new Error(`Duplicate derived ticket ID: ${ticket.id}`);
    seenIds.add(ticket.id);
  }
  const tickets = levelsFor(sourceTickets);
  const facts = {
    version: 1,
    created_at: now,
    execution_mode: executionModeFor(tickets),
    spec: { ref: specRef, feature_slug: location.featureSlug, title: titleFrom(specContent, location.featureSlug) },
    tickets: tickets.map(executionTicketFrom),
  };
  return { ...facts, revision: revisionFor(facts) };
}

export async function writeExecutionPlan(worktree, executionPlan) {
  verifyExecutionPlan(executionPlan);
  const path = join(worktree, executionPlanPath(executionPlan.spec.feature_slug));
  await mkdir(join(worktree, ".scratch", executionPlan.spec.feature_slug), { recursive: true });
  await writeFile(path, `${JSON.stringify(executionPlan, null, 2)}\n`);
  return path;
}

export async function readExecutionPlan(worktree, featureSlug) {
  return verifyExecutionPlan(JSON.parse(await readFile(join(worktree, executionPlanPath(featureSlug)), "utf8")));
}

async function pathWithin(worktree, path) {
  return relativePathWithin(await realpath(worktree), await realpath(path));
}

export async function assertSpecArtifactsInMainWorktree({ mainWorktree, executionPlan }) {
  const mainRoot = await realpath(mainWorktree);
  await pathWithin(mainRoot, resolve(mainRoot, executionPlan.spec.ref));
  await Promise.all(executionPlan.tickets.map((ticket) => pathWithin(mainRoot, resolve(mainRoot, ticket.ref))));
}

export function verifyExecutionPlan(executionPlan) {
  assertExecutionPlan(executionPlan);
  if (executionPlan.spec.ref !== sourceSpecPath(executionPlan.spec.feature_slug)) {
    throw new Error("Execution plan reference does not match its feature_slug");
  }
  if (executionPlan.execution_mode === "coordinator" && executionPlan.tickets.length !== 1) {
    throw new Error("Coordinator execution is only available for a single-ticket spec");
  }
  verifyTicketDependencies(executionPlan.tickets);
  const { revision, ...facts } = executionPlan;
  if (revisionFor(facts) !== revision) throw new Error("Execution plan revision does not match its immutable facts");
  return executionPlan;
}
