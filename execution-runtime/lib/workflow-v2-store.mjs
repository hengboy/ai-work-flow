import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { loadWorkflowContract, validateArtifactContent } from "./workflow-contract.mjs";

const execFileAsync = promisify(execFile);
const LEASE_MS = 30 * 60 * 1000;
const TERMINAL = new Set(["complete", "failed"]);
const TRANSIENT_IO = new Set(["EINTR", "EAGAIN", "EBUSY", "EMFILE", "ENFILE"]);

export class WorkflowBusinessError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function digest(value) {
  return createHash("sha256").update(Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
}

async function gitRoot(cwd) {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  return realpath(stdout.trim());
}

async function locations(cwd, runId) {
  const repository = await gitRoot(cwd);
  const { stdout } = await execFileAsync("git", ["rev-parse", "--git-common-dir"], { cwd: repository, encoding: "utf8" });
  const commonCandidate = stdout.trim();
  const common = await realpath(isAbsolute(commonCandidate) ? commonCandidate : resolve(repository, commonCandidate));
  const base = join(common, "ai-work-flow", "v2");
  const runs = join(base, "runs");
  const run = runId ? join(runs, runId) : null;
  return { repository, common, base, runs, run, runFile: run && join(run, "run.json"), lock: join(base, ".lock") };
}

async function ensureDirectory(common, target) {
  const path = relative(common, target);
  if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error("workflow path escapes Git common dir");
  let cursor = common;
  for (const part of path.split(sep)) {
    cursor = join(cursor, part);
    try { await mkdir(cursor, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const entry = await lstat(cursor);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("workflow directory is unsafe");
  }
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function retryTransient(operation) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      if (!TRANSIENT_IO.has(error.code) || attempt >= 2) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20 * (attempt + 1)));
    }
  }
}

async function atomicJson(path, value) {
  return retryTransient(async () => {
    const temporary = join(dirname(path), `.${randomBytes(12).toString("hex")}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, path);
      await syncDirectory(dirname(path));
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  });
}

async function readJson(path) {
  try { return JSON.parse(await retryTransient(() => readFile(path, "utf8"))); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error(`workflow persistence is corrupt: ${path}`);
    throw error;
  }
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

async function withLock(location, callback) {
  await ensureDirectory(location.common, location.base);
  const started = Date.now();
  const token = randomBytes(16).toString("hex");
  while (true) {
    try {
      await mkdir(location.lock, { mode: 0o700 });
      try { await atomicJson(join(location.lock, "owner.json"), { pid: process.pid, token, created_at: new Date().toISOString() }); }
      catch (ownerError) { await rm(location.lock, { recursive: true, force: true }); throw ownerError; }
      break;
    }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const entry = await lstat(location.lock);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("workflow lock path is unsafe");
      let owner;
      try { owner = await readJson(join(location.lock, "owner.json")); }
      catch (ownerError) {
        if (ownerError.code !== "ENOENT") throw ownerError;
        if (Date.now() - started > 2_000) throw new WorkflowBusinessError("busy", "workflow store is busy");
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
        continue;
      }
      if (!pidAlive(owner.pid)) {
        const stale = `${location.lock}.stale-${token}`;
        try { await rename(location.lock, stale); }
        catch (renameError) { if (renameError.code === "ENOENT") continue; throw renameError; }
        await rm(stale, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > 2_000) throw new WorkflowBusinessError("busy", "workflow store is busy");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
  }
  try { return await callback(); }
  finally {
    try {
      const owner = await readJson(join(location.lock, "owner.json"));
      if (owner.token === token) await rm(location.lock, { recursive: true, force: true });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function metadata(source, name) {
  const match = new RegExp("^- " + name + ":\\s*(?:`([^`]*)`|(.+))\\s*$", "mi").exec(source);
  return (match?.[1] ?? match?.[2] ?? "").trim();
}

function sectionItems(source, heading) {
  const start = new RegExp(`^## ${heading}\\s*$`, "mi").exec(source);
  if (!start) return [];
  const bodyStart = start.index + start[0].length;
  const next = /^## /m.exec(source.slice(bodyStart));
  const body = source.slice(bodyStart, next ? bodyStart + next.index : source.length);
  return [...body.matchAll(/^\s*[-*]\s+(.+)$/gm)].map((entry) => entry[1].trim());
}

async function safeFile(repository, path) {
  let absolute;
  try { absolute = await realpath(resolve(repository, path)); }
  catch (error) { if (error.code === "ENOENT") throw new WorkflowBusinessError("correction_required", "plan input does not exist"); throw error; }
  const rel = relative(repository, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new WorkflowBusinessError("correction_required", "plan path must be inside the repository");
  const entry = await lstat(absolute);
  if (entry.isSymbolicLink() || !entry.isFile()) throw new WorkflowBusinessError("correction_required", "plan input must be a regular file");
  return absolute;
}

export async function parsePlanBundle(cwd, planPath) {
  const location = await locations(cwd);
  let unresolved;
  try { unresolved = await realpath(resolve(location.repository, planPath)); }
  catch (error) { if (error.code === "ENOENT") throw new WorkflowBusinessError("correction_required", "plan path does not exist"); throw error; }
  const rel = relative(location.repository, unresolved);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new WorkflowBusinessError("correction_required", "plan path must be inside the repository");
  const entry = await stat(unresolved).catch(() => null);
  let candidate = entry?.isDirectory() ? await safeFile(location.repository, join(unresolved, "plan.md")) : await safeFile(location.repository, unresolved);
  if (basename(candidate) !== "plan.md") throw new WorkflowBusinessError("correction_required", "coding_start_plan requires a plan directory or plan.md");
  const planBytes = await readFile(candidate);
  const plan = planBytes.toString("utf8");
  const planId = metadata(plan, "plan-id");
  const status = metadata(plan, "status");
  const sourceSpec = metadata(plan, "source_spec");
  const sourceDigest = metadata(plan, "source_spec_digest");
  const taskMode = metadata(plan, "task_mode") || ((await readdir(join(dirname(candidate), "tasks")).catch(() => [])).some((name) => /^\d{2}-.+\.md$/.test(name)) ? "split" : "single");
  if (!planId || status !== "ready-for-implementation" || !sourceSpec || !/^[0-9a-f]{64}$/.test(sourceDigest) || !["single", "split"].includes(taskMode)) {
    throw new WorkflowBusinessError("correction_required", "plan metadata is incomplete or invalid");
  }
  const specPath = await safeFile(location.repository, sourceSpec);
  if (dirname(specPath) !== dirname(candidate) || basename(specPath) !== "spec.md") throw new WorkflowBusinessError("correction_required", "source spec must be the plan directory spec.md");
  const specBytes = await readFile(specPath);
  if (digest(specBytes) !== sourceDigest) throw new WorkflowBusinessError("correction_required", "source spec digest does not match the current file");
  const spec = specBytes.toString("utf8");
  if (metadata(spec, "plan-id") !== planId || metadata(spec, "status") !== "approved") throw new WorkflowBusinessError("correction_required", "source spec metadata does not match the plan");
  const taskFiles = taskMode === "split"
    ? (await readdir(join(dirname(candidate), "tasks"))).filter((name) => /^\d{2}-.+\.md$/.test(name)).sort()
    : [];
  if (taskMode === "split" && taskFiles.length === 0) throw new WorkflowBusinessError("correction_required", "split plan has no task files");
  const tasks = [];
  for (const name of taskFiles) {
    const path = await safeFile(location.repository, join(dirname(candidate), "tasks", name));
    const bytes = await readFile(path);
    const sourcePlanDigest = metadata(bytes.toString("utf8"), "source_plan_digest");
    if (!/^[0-9a-f]{64}$/.test(sourcePlanDigest) || sourcePlanDigest !== digest(planBytes)) throw new WorkflowBusinessError("correction_required", `task ${name} does not match the current plan`);
    tasks.push({ id: name.replace(/\.md$/, ""), path: relative(location.repository, path), sha256: digest(bytes) });
  }
  const acceptance = [...new Set([...sectionItems(spec, "Acceptance Criteria"), ...sectionItems(plan, "Acceptance Criteria")])];
  if (acceptance.length === 0) throw new WorkflowBusinessError("correction_required", "plan bundle has no acceptance criteria");
  return {
    version: 2, plan_id: planId, task_mode: taskMode,
    spec: { path: relative(location.repository, specPath), sha256: sourceDigest },
    plan: { path: relative(location.repository, candidate), sha256: digest(planBytes) },
    tasks, implementation_ids: tasks.length ? tasks.map((task) => task.id) : [planId], acceptance,
  };
}

function runKey(kind, source) { return digest({ kind, source }); }
function runSummary(run) { return { run_id: run.run_id, kind: run.kind, phase: run.phase, updated_at: run.updated_at }; }

async function allRuns(location) {
  await ensureDirectory(location.common, location.runs);
  const names = await readdir(location.runs);
  const runs = [];
  for (const name of names.filter((entry) => /^run_[0-9a-f]{24}$/.test(entry))) runs.push(await readJson(join(location.runs, name, "run.json")));
  return runs;
}

async function start(cwd, kind, source, initialPhase) {
  const location = await locations(cwd);
  return withLock(location, async () => {
    const contract = await loadWorkflowContract();
    const existing = (await allRuns(location)).find((run) => run.key === runKey(kind, source));
    if (existing) {
      if (existing.contract_digest !== contract.digest) throw new WorkflowBusinessError("correction_required", "run contract digest does not match the installed runtime");
      return { ...runSummary(existing), status: TERMINAL.has(existing.phase) ? existing.phase : existing.decision ? "decision_required" : "claimed" };
    }
    const now = new Date().toISOString();
    const run = {
      version: 2, contract_digest: contract.digest, run_id: `run_${randomBytes(12).toString("hex")}`, key: runKey(kind, source), kind, source,
      phase: initialPhase, revision: 0, leases: {}, superseded_leases: {}, completed: {}, receipts: {}, decision: null,
      created_at: now, updated_at: now,
    };
    const runLocation = await locations(cwd, run.run_id);
    await ensureDirectory(runLocation.common, runLocation.run);
    await atomicJson(runLocation.runFile, run);
    return { ...runSummary(run), status: "claimed" };
  });
}

export async function startDirect(cwd, objective) {
  if (typeof objective !== "string" || !objective.trim()) throw new WorkflowBusinessError("correction_required", "objective must be a non-empty string");
  return start(cwd, "coding", { type: "direct", objective: objective.trim(), request_digest: digest(objective.trim()) }, "direct_started");
}

export async function startPlan(cwd, planPath) {
  if (typeof planPath !== "string" || !planPath.trim()) throw new WorkflowBusinessError("correction_required", "plan_path must be a non-empty string");
  const bundle = await parsePlanBundle(cwd, planPath);
  return start(cwd, "coding", { type: "plan", plan_bundle: bundle }, "started");
}

export async function startPlanning(cwd, objective) {
  if (typeof objective !== "string" || !objective.trim()) throw new WorkflowBusinessError("correction_required", "objective must be a non-empty string");
  return start(cwd, "planning", { type: "direct", objective: objective.trim(), request_digest: digest(objective.trim()) }, "started");
}

export async function startPlanningHandoff(cwd, sourceRunId) {
  const source = await getRun(cwd, sourceRunId);
  if (source.kind !== "coding" || source.decision?.code !== "PLANNING_REQUIRED") throw new WorkflowBusinessError("correction_required", "source run is not a Planning handoff");
  return start(cwd, "planning", { type: "handoff", source_run_id: sourceRunId, objective: source.source.objective }, "started");
}

async function getRun(cwd, runId) {
  if (!/^run_[0-9a-f]{24}$/.test(runId ?? "")) throw new WorkflowBusinessError("correction_required", "run_id is invalid");
  const location = await locations(cwd, runId);
  try {
    const run = await readJson(location.runFile);
    if (run.version !== 2 || run.contract_digest !== (await loadWorkflowContract()).digest) throw new WorkflowBusinessError("correction_required", "run contract digest does not match the installed runtime");
    return run;
  }
  catch (error) { if (error.code === "ENOENT") throw new WorkflowBusinessError("correction_required", "run does not exist"); throw error; }
}

export async function resume(cwd, runId) {
  const location = await locations(cwd);
  if (runId) {
    const run = await getRun(cwd, runId);
    return { ...runSummary(run), status: TERMINAL.has(run.phase) ? run.phase : run.decision ? "decision_required" : "claimed", decision: run.decision ?? undefined };
  }
  const active = (await allRuns(location)).filter((run) => !TERMINAL.has(run.phase)).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const contractDigest = (await loadWorkflowContract()).digest;
  if (active.some((run) => run.version !== 2 || run.contract_digest !== contractDigest)) throw new WorkflowBusinessError("correction_required", "an unfinished run does not match the installed runtime contract");
  if (active.length === 0) return { status: "complete", message: "no unfinished workflow run" };
  if (active.length > 1) return { status: "selection_required", candidates: active.map(runSummary) };
  return { ...runSummary(active[0]), status: active[0].decision ? "decision_required" : "claimed", decision: active[0].decision ?? undefined };
}

function readyAction(run, contract) { return contract.workflows[run.kind]?.phase_actions?.[run.phase]?.[0] ?? null; }
function completionTool(action, contract) { return action ? `workflow_complete_${contract.actions[action].io_contract}` : null; }

function dispatchInput(run, action, contract) {
  const upstream = Object.values(run.receipts).map((receipt) => ({ action_id: receipt.action_id, result: receipt.result, fields: receipt.visible_fields ?? receipt.fields }));
  const flattened = Object.assign({}, ...upstream.map((receipt) => receipt.fields));
  const bundle = run.source.plan_bundle;
  const aliases = {
    objective: run.source.objective,
    request_digest: run.source.request_digest,
    plan_digest: bundle?.plan.sha256 ?? run.source.request_digest,
    task_mode: bundle?.task_mode ?? "single",
    target_base: "main",
    spec_or_task_ids: bundle?.implementation_ids ?? flattened.implementation_ids,
    acceptance: bundle?.acceptance ?? flattened.acceptance ?? flattened.planning_context?.acceptance_criteria,
    decision_history: run.decision_history ?? [],
    discovery_receipt: upstream.find((receipt) => receipt.action_id === "planning.discover"),
    source_ref: flattened.planning_context,
    source_digest: flattened.planning_context ? digest(flattened.planning_context) : undefined,
    mode: flattened.task_mode ?? bundle?.task_mode,
    evidence_ref: flattened.change_evidence,
    review_packet_ref: flattened.review_packet,
    review_result_ref: flattened.review_result,
    refs: Object.fromEntries(upstream.map((receipt) => [receipt.action_id, receipt.fields])),
  };
  const declaration = contract.io_contracts[contract.actions[action].io_contract].input_contract;
  const publicField = (field) => {
    if (!field.endsWith("_ref")) return field;
    const kinds = declaration.required_artifact_kinds ?? [];
    return kinds.find((kind) => field === `${kind}_ref`) ?? (kinds.length === 1 ? kinds[0] : field.slice(0, -4));
  };
  const input = {};
  for (const field of [...declaration.required_fields, ...(declaration.optional_fields ?? [])]) {
    const exposed = publicField(field);
    const value = aliases[field] ?? aliases[exposed] ?? flattened[exposed] ?? flattened[field];
    if (value !== undefined) input[exposed] = value;
  }
  if (action === "planning.write_spec") input.target = `.ai-work-flow/plans/${flattened.plan_id}/spec.md`;
  if (action === "planning.write_plan") input.target = `.ai-work-flow/plans/${flattened.plan_id}/plan.md`;
  if (action === "planning.write_tasks") input.target = `.ai-work-flow/plans/${flattened.plan_id}/tasks`;
  return input;
}

function visibleReceipt(receipt) {
  return { receipt_id: receipt.receipt_id, action_id: receipt.action_id, result: receipt.result, summary: receipt.summary, fields: receipt.visible_fields ?? receipt.fields };
}

export async function claimNext(cwd, runId) {
  const location = await locations(cwd, runId);
  return withLock(location, async () => {
    const run = await getRun(cwd, runId);
    if (TERMINAL.has(run.phase)) return { status: run.phase, ...runSummary(run) };
    if (run.decision) return { status: "decision_required", ...runSummary(run), decision: run.decision };
    const contract = await loadWorkflowContract();
    const action = readyAction(run, contract);
    if (!action) return { status: "failed", message: `no action is declared for phase ${run.phase}` };
    const current = run.leases[action];
    const now = Date.now();
    if (current && Date.parse(current.expires_at) > now) return { status: "busy", run_id: runId, action_id: action, lease_expires_at: current.expires_at };
    const lease = {
      lease_id: `lease_${randomBytes(16).toString("hex")}`, action_id: action, generation: (current?.generation ?? 0) + 1,
      issued_at: new Date(now).toISOString(), expires_at: new Date(now + LEASE_MS).toISOString(),
    };
    if (current) run.superseded_leases[current.lease_id] = { action_id: current.action_id, superseded_by: lease.lease_id };
    run.leases[action] = lease;
    run.revision += 1;
    run.updated_at = lease.issued_at;
    await atomicJson(location.runFile, run);
    return {
      status: "claimed", run_id: runId, lease_id: lease.lease_id, lease_expires_at: lease.expires_at,
      completion_tool: completionTool(action, contract),
      dispatch: { action_id: action, owner: contract.actions[action].owner, input: dispatchInput(run, action, contract) },
    };
  });
}

function transition(run, action, result, fields, contract) {
  const declaration = contract.actions[action];
  if (result === "completed") {
    const branch = declaration.completed_to_by_output;
    if (branch) return branch.values[fields[branch.field]] ?? declaration.completed_to;
    if (declaration.completed_to_by_task_mode) return declaration.completed_to_by_task_mode[run.source.plan_bundle?.task_mode ?? fields.task_mode];
    return declaration.completed_to;
  }
  if (result === "retryable_failure") return declaration.retryable_to ?? declaration.from;
  if (result === "failed") return "failed";
  return "awaiting_decision";
}

function publicResultField(field, resultContract) {
  if (!field.endsWith("_ref")) return field;
  const kinds = resultContract.required_artifact_kinds ?? [];
  return kinds.find((kind) => field === `${kind}_ref`) ?? (kinds.length === 1 ? kinds[0] : field.slice(0, -4));
}

function validateCompletion(action, result, fields, contract) {
  const io = contract.io_contracts[contract.actions[action].io_contract];
  const resultContract = io.result_contracts[result];
  if (!resultContract) throw new WorkflowBusinessError("correction_required", `result ${result} is not allowed by this completion tool`);
  const required = [...resultContract.required_fields.map((field) => publicResultField(field, resultContract)), ...(resultContract.required_error_fields ?? [])];
  const allowed = [...required, ...(resultContract.optional_fields ?? []).map((field) => publicResultField(field, resultContract))];
  const extra = Object.keys(fields).filter((field) => !allowed.includes(field));
  const missing = required.filter((field) => fields[field] === undefined);
  if (extra.length || missing.length) throw new WorkflowBusinessError("correction_required", "completion fields do not match the I/O contract", { extra, missing });
  return resultContract;
}

async function storeCompletionArtifacts(location, run, fields, resultContract, contract) {
  const artifacts = {};
  for (const kind of resultContract.required_artifact_kinds ?? []) {
    if (fields[kind] === undefined) continue;
    validateArtifactContent(kind, fields[kind], contract);
    const body = Buffer.from(`${JSON.stringify(fields[kind], null, 2)}\n`);
    const sha256 = digest(body);
    const directory = join(location.run, "artifacts");
    await ensureDirectory(location.common, directory);
    const path = join(directory, `${kind}_${sha256.slice(0, 24)}.json`);
    try { await readFile(path); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
      await syncDirectory(directory);
    }
    artifacts[kind] = { kind, id: `${kind}_${sha256.slice(0, 24)}`, sha256, bytes: body.byteLength };
  }
  return artifacts;
}

export async function complete(cwd, contractName, input) {
  const location = await locations(cwd);
  return withLock(location, async () => {
    const runs = await allRuns(location);
    const matches = [];
    for (const run of runs) for (const lease of Object.values(run.leases)) if (lease.lease_id === input.lease_id) matches.push({ run, lease });
    for (const run of runs) if (run.completed[input.lease_id]) {
      if (run.version !== 2 || run.contract_digest !== (await loadWorkflowContract()).digest) throw new WorkflowBusinessError("correction_required", "run contract digest does not match the installed runtime");
      return { ...runSummary(run), status: TERMINAL.has(run.phase) ? run.phase : run.decision ? "decision_required" : "claimed", receipt: visibleReceipt(run.completed[input.lease_id]) };
    }
    for (const run of runs) if (run.superseded_leases?.[input.lease_id]) return { status: "superseded", run_id: run.run_id, ...run.superseded_leases[input.lease_id] };
    if (matches.length !== 1) throw new WorkflowBusinessError("correction_required", "lease_id is unknown");
    const { run, lease } = matches[0];
    if (run.version !== 2 || run.contract_digest !== (await loadWorkflowContract()).digest) throw new WorkflowBusinessError("correction_required", "run contract digest does not match the installed runtime");
    const current = run.leases[lease.action_id];
    if (current.lease_id !== lease.lease_id) return { status: "superseded", run_id: run.run_id, action_id: lease.action_id };
    const contract = await loadWorkflowContract();
    if (contract.actions[lease.action_id].io_contract !== contractName) throw new WorkflowBusinessError("correction_required", "wrong completion tool for this lease", { completion_tool: completionTool(lease.action_id, contract) });
    const fields = Object.fromEntries(Object.entries(input).filter(([key]) => !["lease_id", "result", "summary"].includes(key)));
    if (typeof input.summary !== "string" || !input.summary.trim()) throw new WorkflowBusinessError("correction_required", "summary must be non-empty");
    const resultContract = validateCompletion(lease.action_id, input.result, fields, contract);
    const runLocation = await locations(cwd, run.run_id);
    const artifacts = await storeCompletionArtifacts(runLocation, run, fields, resultContract, contract);
    const canonicalFields = Object.fromEntries(resultContract.required_fields.concat(resultContract.optional_fields ?? []).filter((field) => {
      const publicField = publicResultField(field, resultContract);
      return fields[publicField] !== undefined;
    }).map((field) => {
      const publicField = publicResultField(field, resultContract);
      return [field, artifacts[publicField] ?? fields[publicField]];
    }));
    for (const field of resultContract.required_error_fields ?? []) canonicalFields[field] = fields[field];
    const receipt = { receipt_id: `receipt_${digest({ lease: lease.lease_id, input }).slice(0, 24)}`, action_id: lease.action_id, result: input.result, summary: input.summary, fields: canonicalFields, visible_fields: fields, artifacts };
    run.completed[lease.lease_id] = receipt;
    run.receipts[lease.action_id] = receipt;
    delete run.leases[lease.action_id];
    run.phase = transition(run, lease.action_id, input.result, fields, contract);
    if (input.result === "needs_decision" || run.phase === "awaiting_decision") {
      const code = contract.actions[lease.action_id].decision_code ?? fields.code ?? fields.open_decision?.code ?? "PRODUCT_DECISION_REQUIRED";
      run.decision = { code, prompt: fields.open_decision ?? fields, resume_phase: code === "PLANNING_REQUIRED" || contract.actions[lease.action_id].decision_code ? null : contract.actions[lease.action_id].from };
    }
    run.revision += 1;
    run.updated_at = new Date().toISOString();
    await atomicJson(runLocation.runFile, run);
    return { ...runSummary(run), status: run.decision ? "decision_required" : TERMINAL.has(run.phase) ? run.phase : "claimed", receipt: visibleReceipt(receipt), decision: run.decision ?? undefined };
  });
}

export async function answer(cwd, runId, answerText) {
  if (typeof answerText !== "string" || !answerText.trim()) throw new WorkflowBusinessError("correction_required", "answer must be non-empty");
  const location = await locations(cwd, runId);
  return withLock(location, async () => {
    const run = await getRun(cwd, runId);
    if (!run.decision) throw new WorkflowBusinessError("correction_required", "run has no active decision");
    if (!run.decision.resume_phase) return { status: "decision_required", run_id: runId, decision: run.decision, handoff_tool: run.decision.code === "PLANNING_REQUIRED" ? "planning_start_handoff" : undefined };
    run.decision_history ??= [];
    run.decision_history.push({ code: run.decision.code, answer: answerText, answered_at: new Date().toISOString() });
    run.phase = run.decision.resume_phase;
    run.decision = null;
    run.revision += 1;
    run.updated_at = new Date().toISOString();
    await atomicJson(location.runFile, run);
    return { ...runSummary(run), status: "claimed" };
  });
}

export const workflowLeaseMilliseconds = LEASE_MS;
