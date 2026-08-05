import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { digestValue, loadWorkflowContract, validateActionInput, validateActionReceipt, validateSupportReceipt } from "./workflow-contract.mjs";
import { pathChangesEqual } from "./paths.mjs";

const execFileAsync = promisify(execFile);

async function gitCommonRoot(repository) {
  const root = resolve(repository);
  const { stdout } = await execFileAsync("git", ["rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf8" });
  const common = stdout.trim();
  const absolute = isAbsolute(common) ? resolve(common) : resolve(root, common);
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Git common dir must be a real directory");
  return realpath(absolute);
}

async function paths(repository, runId) {
  const common = await gitCommonRoot(repository);
  const base = join(common, "ai-work-flow");
  const runs = join(base, "runs");
  const run = runId ? join(runs, runId) : null;
  return { common, base, runs, run, runFile: run && join(run, "run.json"), lock: run && join(run, ".lock") };
}

async function assertPathChain(common, target) {
  const path = relative(common, target);
  if (!path || path === ".") return;
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error("workflow path escapes Git common dir");
  let cursor = common;
  for (const part of path.split(sep)) {
    cursor = join(cursor, part);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error(`workflow path contains a symbolic link: ${cursor}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      break;
    }
  }
}

async function ensureDirectoryChain(common, target) {
  const path = relative(common, target);
  if (!path || path === ".") return;
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error("workflow path escapes Git common dir");
  let cursor = common;
  for (const part of path.split(sep)) {
    cursor = join(cursor, part);
    try { await mkdir(cursor, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`workflow directory is unsafe: ${cursor}`);
  }
}

async function fsyncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicJson(path, value) {
  const temporary = join(dirname(path), `.${randomBytes(12).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await fsyncDirectory(dirname(path));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

async function withLock(path, callback) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("workflow lock path is unsafe");
    let owner;
    try { owner = await readJson(join(path, "owner.json")); } catch { throw new Error("WORKFLOW_BUSY: run is locked"); }
    if (pidAlive(owner.pid)) throw new Error("WORKFLOW_BUSY: run is locked");
    let recoveryHandle;
    try { recoveryHandle = await open(join(path, ".recover"), "wx", 0o600); }
    catch (recoveryError) { if (recoveryError.code === "EEXIST") throw new Error("WORKFLOW_BUSY: stale lock recovery is active"); throw recoveryError; }
    await recoveryHandle.close();
    const currentOwner = await readJson(join(path, "owner.json"));
    if (JSON.stringify(currentOwner) !== JSON.stringify(owner)) throw new Error("WORKFLOW_BUSY: lock owner changed during recovery");
    await rm(path, { recursive: true });
    await mkdir(path, { mode: 0o700 });
  }
  try {
    await atomicJson(join(path, "owner.json"), { pid: process.pid, created_at: new Date().toISOString() });
    return await callback();
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

function snapshot(run, contract) {
  const ready = contract.workflows[run.kind].phase_actions[run.phase] ?? [];
  const active = Object.values(run.active_claims).sort((a, b) => a.action_id.localeCompare(b.action_id));
  const result = {
    run_id: run.run_id,
    kind: run.kind,
    source_type: run.source_type,
    plan_digest: run.plan_digest,
    task_mode: run.task_mode,
    revision: run.revision,
    phase: run.phase,
    ready_actions: ready.filter((id) => !run.active_claims[id] && !run.completed_actions[id]),
    active_claims: active,
    budgets: structuredClone(run.budgets),
    decision_history: structuredClone(run.decision_history),
  };
  if (run.decision_request) result.decision_request = structuredClone(run.decision_request);
  if (run.planning_context_ref) result.planning_context_ref = structuredClone(run.planning_context_ref);
  if (run.direct_request) result.direct_request = structuredClone(run.direct_request);
  if (run.source_run_id) result.source_run_id = run.source_run_id;
  if (run.direct_kind) result.direct_kind = run.direct_kind;
  return result;
}

function initialBudgets(contract) {
  return {
    transient_retries_remaining: {},
    recover_remaining: contract.budgets.recoveries,
    main_resyncs_remaining: contract.budgets.main_resyncs,
    review_fix_rounds_remaining: contract.budgets.review_fix_rounds,
  };
}

function runKey(kind, sourceType, planDigest, taskMode, sourceRunId) {
  const source = sourceRunId ? `\0${sourceRunId}` : "";
  return createHash("sha256").update(`${kind}\0${sourceType}\0${planDigest}\0${taskMode ?? ""}${source}`).digest("hex");
}

export async function startRun({ repository, kind, plan_digest, task_mode, request, source_run_id }) {
  if (source_run_id !== undefined) {
    if (kind !== "planning" || request !== undefined || plan_digest !== undefined || task_mode !== undefined) {
      throw new Error("planning handoff start requires exactly kind=planning and source_run_id");
    }
    const { run: sourceRun } = await loadRun(repository, source_run_id);
    if (sourceRun.kind !== "coding" || sourceRun.source_type !== "direct" || sourceRun.phase !== "awaiting_decision" ||
      sourceRun.decision_request?.code !== "PLANNING_REQUIRED" || typeof sourceRun.direct_request?.objective !== "string") {
      throw new Error("source_run_id is not a terminal PLANNING_REQUIRED direct coding run");
    }
    request = structuredClone(sourceRun.direct_request);
  }
  const contract = await loadWorkflowContract();
  const requestBased = request !== undefined;
  const validRequest = request && typeof request === "object" && !Array.isArray(request) &&
    Object.keys(request).join() === "objective" && typeof request.objective === "string" && request.objective.trim();
  const validRequestStart = ["coding", "planning"].includes(kind) && validRequest && plan_digest === undefined && task_mode === undefined;
  const validPlanStart = kind !== "planning" && /^[0-9a-f]{64}$/.test(plan_digest ?? "") &&
    (kind === "coding" ? ["single", "split"].includes(task_mode) : task_mode === undefined);
  if (!contract.workflows[kind] || !(requestBased ? validRequestStart : validPlanStart)) {
    if (kind === "planning") {
      throw new Error("planning start requires exactly one of request={objective:<verbatim user request>} or source_run_id=<PLANNING_REQUIRED coding run_id>");
    }
    throw new Error("start input is invalid");
  }
  const sourceType = requestBased ? "direct" : "plan";
  const directRequest = requestBased ? { objective: request.objective } : null;
  const runDigest = requestBased ? digestValue(directRequest) : plan_digest;
  const runTaskMode = requestBased && kind === "coding" ? "single" : task_mode;
  const location = await paths(repository);
  await ensureDirectoryChain(location.common, location.runs);
  await assertPathChain(location.common, location.runs);
  const key = runKey(kind, sourceType, runDigest, runTaskMode, source_run_id);
  const indexPath = join(location.base, "plan-index", `${key}.json`);
  const startLock = join(location.base, "start-locks", key);
  await ensureDirectoryChain(location.common, dirname(startLock));
  return withLock(startLock, async () => {
    try {
      const existing = await readJson(indexPath);
      try {
        return await statusRun({ repository, run_id: existing.run_id });
      } catch (error) {
        if (error.code !== "ENOENT" && !error.message.includes("drifted")) throw error;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const runId = `run_${randomBytes(12).toString("hex")}`;
    const runLocation = await paths(repository, runId);
    const run = {
      contract_digest: contract.digest,
      run_id: runId,
      kind,
      source_type: sourceType,
      plan_digest: runDigest,
      task_mode: runTaskMode ?? null,
      revision: 0,
      phase: requestBased && kind === "coding" ? "direct_started" : contract.workflows[kind].initial_phase,
      active_claims: {},
      attempts: {},
      completed_actions: {},
      receipts: {},
      budgets: initialBudgets(contract),
      decision_request: null,
      decision_history: [],
      planning_context_ref: null,
      direct_request: directRequest,
      source_run_id: source_run_id ?? null,
      direct_kind: null,
      review_finding_ids: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await ensureDirectoryChain(runLocation.common, runLocation.run);
    await atomicJson(runLocation.runFile, run);
    await assertPathChain(runLocation.common, runLocation.runFile);
    await ensureDirectoryChain(location.common, dirname(indexPath));
    await atomicJson(indexPath, { run_id: runId });
    return snapshot(run, contract);
  });
}

async function loadRun(repository, runId) {
  if (!/^run_[0-9a-f]{24}$/.test(runId)) throw new Error("run_id is invalid");
  const contract = await loadWorkflowContract();
  const location = await paths(repository, runId);
  await assertPathChain(location.common, location.runFile);
  const run = await readJson(location.runFile);
  if (run.contract_digest !== contract.digest || run.run_id !== runId) throw new Error("run identity is invalid or drifted");
  return { contract, location, run };
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function artifactRef(input, field, kind) {
  const ref = input.fields[field];
  if (!ref || ref.kind !== kind || !input.artifacts.some((candidate) => same(candidate, ref))) {
    throw new Error(`${field} must reference the claimed ${kind} artifact`);
  }
  return ref;
}

function completedOutputs(run, actionId) {
  const outputs = run.completed_actions[actionId]?.receipt?.outputs;
  if (!outputs) throw new Error(`canonical receipt is missing for ${actionId}`);
  return outputs;
}

function uniquePaths(pathChanges) {
  return [...new Set(pathChanges.map((change) => change.path))].sort();
}

function planningSummary(run) {
  return {
    planning_context_ref: run.planning_context_ref,
    task_mode: run.task_mode,
    spec: completedOutputs(run, "planning.write_spec"),
    plan: completedOutputs(run, "planning.write_plan"),
    tasks: run.task_mode === "split" ? completedOutputs(run, "planning.write_tasks") : null,
    commit: completedOutputs(run, "planning.commit"),
  };
}

function validatePlanningSource(actionId, input, run) {
  const contextRef = run.planning_context_ref;
  if (!contextRef || !input.artifacts.some((ref) => same(ref, contextRef))) throw new Error(`${actionId} requires the canonical planning_context artifact`);
  if (input.fields.mode !== run.task_mode) throw new Error(`${actionId} mode does not match planning context`);
  if (actionId === "planning.write_spec") {
    if (!same(input.fields.source_ref, contextRef) || input.fields.source_digest !== contextRef.sha256) throw new Error("planning.write_spec source does not match planning context");
    return;
  }
  const previousId = actionId === "planning.write_plan" ? "planning.write_spec" : "planning.write_plan";
  const previous = completedOutputs(run, previousId);
  if (input.fields.source_ref !== previous.target || input.fields.source_digest !== previous.sha256 || input.fields.mode !== previous.mode) {
    throw new Error(`${actionId} source does not match ${previousId}`);
  }
}

function validateClaimSemantics({ action_id: actionId, input, run, verifiedArtifacts }) {
  if (["coding.prepare", "coding.prepare_direct_bug"].includes(actionId) &&
    (input.fields.plan_digest !== run.plan_digest || input.fields.task_mode !== run.task_mode)) {
    throw new Error(`${actionId} input does not match run identity`);
  }
  if (actionId === "coding.triage" && (run.source_type !== "direct" || input.fields.objective !== run.direct_request?.objective || input.fields.request_digest !== run.plan_digest)) {
    throw new Error("coding.triage input does not match the canonical direct request");
  }
  if (actionId === "planning.discover" && run.source_type === "direct" && input.fields.objective !== run.direct_request?.objective) {
    throw new Error("planning.discover input does not match the canonical planning request");
  }
  if (["coding.implement", "coding.fix_direct"].includes(actionId) && run.source_type === "direct") {
    const triage = completedOutputs(run, "coding.triage");
    const expectedAction = triage.implementation_kind === "bug" ? "coding.fix_direct" : "coding.implement";
    if (actionId !== expectedAction || !same(input.fields.spec_or_task_ids, triage.implementation_ids) || !same(input.fields.acceptance, triage.acceptance)) {
      throw new Error(`${actionId} input does not match canonical direct triage`);
    }
  }
  if (actionId === "planning.confirm") {
    if (!same(input.fields.decision_history, run.decision_history)) throw new Error("planning.confirm decision history is stale");
    if (!same(input.fields.discovery_receipt, run.completed_actions["planning.discover"]?.receipt)) throw new Error("planning.confirm discovery receipt is not canonical");
  }
  if (["planning.write_spec", "planning.write_plan", "planning.write_tasks"].includes(actionId)) validatePlanningSource(actionId, input, run);
  if (actionId === "planning.complete" && !same(input.fields.refs, planningSummary(run))) throw new Error("planning.complete refs are not canonical");
  if (["planning.commit", "coding.commit"].includes(actionId)) {
    const ref = artifactRef(input, "evidence_ref", "change_evidence");
    const evidence = verifiedArtifacts.get(ref.id);
    if (input.fields.base_sha !== evidence.base_sha || !pathChangesEqual(input.fields.path_changes, evidence.path_changes)) {
      throw new Error(`${actionId} input does not match change_evidence`);
    }
    const implementationAction = run.source_type === "direct" && run.direct_kind === "bug" ? "coding.fix_direct" : "coding.implement";
    if (actionId === "coding.commit" && !same(ref, completedOutputs(run, implementationAction).change_evidence_ref)) {
      throw new Error("coding.commit evidence is not the canonical implementation evidence");
    }
    if (actionId === "planning.commit") {
      const planningActionIds = ["planning.write_spec", "planning.write_plan", ...(run.task_mode === "split" ? ["planning.write_tasks"] : [])];
      const expectedPaths = [...new Set(planningActionIds.flatMap((id) => {
        const outputs = completedOutputs(run, id);
        return [...outputs.changed_paths, ...(outputs.deleted_paths ?? [])];
      }))].sort();
      if (!same(uniquePaths(evidence.path_changes), expectedPaths)) throw new Error("planning.commit evidence does not cover canonical planning paths");
    }
  }
  if (run.contract_digest && input.fields.review_packet_ref) artifactRef(input, "review_packet_ref", "review_packet");
  if (["coding.fix_1", "coding.fix_2"].includes(actionId)) {
    const ref = artifactRef(input, "review_result_ref", "review_result");
    const review = verifiedArtifacts.get(ref.id);
    if (!same([...input.fields.finding_ids].sort(), [...review.finding_ids].sort())) throw new Error(`${actionId} finding IDs do not match review_result`);
  }
}

export async function statusRun({ repository, run_id, action_id }) {
  const { contract, run } = await loadRun(repository, run_id);
  const validDirectIdentity = run.source_type !== "direct" || ["coding", "planning"].includes(run.kind) &&
    (run.kind === "coding" ? run.task_mode === "single" : [null, "single", "split"].includes(run.task_mode)) && run.direct_request &&
    Object.keys(run.direct_request).join() === "objective" && digestValue(run.direct_request) === run.plan_digest;
  if (!Number.isSafeInteger(run.revision) || run.revision < 0 || !["plan", "direct"].includes(run.source_type) || !validDirectIdentity ||
    !contract.workflows[run.kind].terminal_phases.includes(run.phase) && !contract.workflows[run.kind].phase_actions[run.phase]) throw new Error("run state is invalid");
  const result = snapshot(run, contract);
  if (action_id) {
    const completed = run.completed_actions[action_id]?.receipt;
    const canonical = completed ?? run.receipts[`${action_id}:${run.attempts[action_id]}`];
    if (canonical) result.result_receipt = structuredClone(canonical);
  }
  return result;
}

export async function statusRepository({ repository, kind }) {
  const contract = await loadWorkflowContract();
  if (kind !== undefined && !contract.workflows[kind]) throw new Error("workflow kind is invalid");
  const location = await paths(repository);
  let entries;
  try {
    entries = await readdir(location.runs, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    entries = [];
  }
  const runs = [];
  const incompatible_run_ids = [];
  const invalid_run_ids = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^run_[0-9a-f]{24}$/.test(entry.name)) continue;
    try {
      const runLocation = await paths(repository, entry.name);
      await assertPathChain(runLocation.common, runLocation.runFile);
      const run = await readJson(runLocation.runFile);
      if (run.run_id !== entry.name) throw new Error("run identity is invalid");
      if (run.contract_digest !== contract.digest) {
        incompatible_run_ids.push(entry.name);
        continue;
      }
      if (kind === undefined || run.kind === kind) runs.push({ updated_at: run.updated_at, snapshot: snapshot(run, contract) });
    } catch {
      invalid_run_ids.push(entry.name);
    }
  }
  runs.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  return {
    contract_digest: contract.digest,
    kind: kind ?? null,
    runs: runs.map((entry) => entry.snapshot),
    incompatible_run_ids: incompatible_run_ids.sort(),
    invalid_run_ids: invalid_run_ids.sort(),
  };
}

export async function claimAction({ repository, run_id, action_id, claimant, owner_pid, input }) {
  const loaded = await loadRun(repository, run_id);
  const performClaim = () => withLock(loaded.location.lock, async () => {
    const { contract, location } = await loadRun(repository, run_id);
    const run = location.run ? await readJson(location.runFile) : loaded.run;
    const completed = run.completed_actions[action_id];
    if (completed) return { claim_status: "completed", receipt: completed.receipt };
    if (run.active_claims[action_id]) return { claim_status: "existing_claim", ...run.active_claims[action_id] };
    if (!(contract.workflows[run.kind].phase_actions[run.phase] ?? []).includes(action_id)) throw new Error(`action ${action_id} is not ready`);
    if (typeof claimant !== "string" || !claimant.trim() || !Number.isSafeInteger(owner_pid) || owner_pid <= 0) throw new Error("claim identity is invalid");
    if (action_id === "planning.confirm") {
      input = {
        fields: {
          discovery_receipt: structuredClone(run.completed_actions["planning.discover"]?.receipt),
          decision_history: structuredClone(run.decision_history),
        },
        artifacts: [],
      };
    }
    validateActionInput(input, action_id, contract);
    const { verifyArtifact } = await import("./artifact-store.mjs");
    const verifiedArtifacts = new Map();
    for (const ref of input.artifacts) verifiedArtifacts.set(ref.id, await verifyArtifact({ repository, run_id, ref }));
    validateClaimSemantics({ action_id, input, run, verifiedArtifacts });
    const attempt = (run.attempts[action_id] ?? 0) + 1;
    const claim = {
      claim_id: `claim_${randomBytes(12).toString("hex")}`,
      action_id,
      attempt,
      claimant,
      owner_pid,
      input: structuredClone(input),
      claimed_at: new Date().toISOString(),
    };
    run.attempts[action_id] = attempt;
    run.active_claims[action_id] = claim;
    run.updated_at = new Date().toISOString();
    await atomicJson(location.runFile, run);
    const attemptDirectory = join(location.run, "actions", action_id, `attempt-${attempt}`);
    await ensureDirectoryChain(location.common, attemptDirectory);
    await atomicJson(join(attemptDirectory, "claim.json"), claim);
    return { claim_status: "claimed", ...claim };
  });
  try {
    return await performClaim();
  } catch (error) {
    if (!error.message.startsWith("WORKFLOW_BUSY")) throw error;
    for (let retry = 0; retry < 2; retry += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5 * (retry + 1)));
      const { run } = await loadRun(repository, run_id);
      if (run.completed_actions[action_id]) return { claim_status: "completed", receipt: run.completed_actions[action_id].receipt };
      if (run.active_claims[action_id]) return { claim_status: "existing_claim", ...run.active_claims[action_id] };
    }
    throw error;
  }
}

function applyReceipt(run, receipt, action, contract) {
  if (receipt.result === "completed") {
    const outputBranch = action.completed_to_by_output;
    const completedTo = outputBranch?.values?.[receipt.outputs[outputBranch.field]] ?? action.completed_to_by_task_mode?.[run.task_mode] ?? action.completed_to;
    if (!completedTo || completedTo === run.phase) throw new Error("WORKFLOW_STALLED: completed action did not advance phase");
    run.phase = completedTo;
    if (action.budget === "review_fix_rounds") run.budgets.review_fix_rounds_remaining -= 1;
  } else if (receipt.result === "retryable_failure") {
    const findingIds = Array.isArray(receipt.error?.finding_ids) ? [...new Set(receipt.error.finding_ids)].sort() : [];
    const repeatedFinding = findingIds.some((id) => run.review_finding_ids.includes(id));
    if (repeatedFinding) {
      run.phase = "awaiting_decision";
      run.decision_request = { code: "REPEATED_REVIEW_FINDING", summary: receipt.summary, resume_phase: action.from };
    } else if (action.retryable_to && action.retryable_to !== run.phase) {
      run.phase = action.retryable_to;
      if (findingIds.length) run.review_finding_ids = findingIds;
      if (action.budget === "main_resyncs") run.budgets.main_resyncs_remaining -= 1;
      if (action.decision_code) run.decision_request = { code: action.decision_code, summary: receipt.summary, resume_phase: action.from };
    } else {
      const remaining = run.budgets.transient_retries_remaining[receipt.action_id] ?? contract.budgets.transient_retries;
      if (remaining > 0) run.budgets.transient_retries_remaining[receipt.action_id] = remaining - 1;
      else {
        run.phase = "awaiting_decision";
        run.decision_request = { code: "WORKFLOW_STALLED", summary: "Transient retry budget exhausted", resume_phase: action.from };
      }
    }
  } else if (receipt.result === "needs_decision") {
    if (!contract.decision_codes.includes(receipt.decision_request.code)) throw new Error("decision code is invalid");
    run.phase = "awaiting_decision";
    run.decision_request = receipt.decision_request.code === "PLANNING_REQUIRED"
      ? structuredClone(receipt.decision_request)
      : { ...receipt.decision_request, resume_phase: action.from };
  } else {
    run.phase = "failed";
    run.decision_request = { code: "UNRECOVERABLE_FAILURE", summary: receipt.summary };
  }
  run.revision += 1;
}

function validateFinishedSemantics({ receipt, claim, action, run, verifiedArtifacts }) {
  if (receipt.action_id === "coding.triage" && receipt.result === "needs_decision" && (
    receipt.decision_request?.code !== "PLANNING_REQUIRED" || !Array.isArray(receipt.outputs.scope_evidence) || receipt.outputs.scope_evidence.length === 0
  )) throw new Error("large direct requests must return PLANNING_REQUIRED with scope evidence");
  if (receipt.result !== "completed" && action.io_contract !== "dual_axis_review") return;
  if (receipt.action_id === "coding.triage") {
    if (!["bug", "small_feature"].includes(receipt.outputs.implementation_kind) || receipt.outputs.objective !== run.direct_request?.objective ||
      !Array.isArray(receipt.outputs.implementation_ids) || receipt.outputs.implementation_ids.length === 0 ||
      !Array.isArray(receipt.outputs.acceptance) || receipt.outputs.acceptance.length === 0 ||
      !Array.isArray(receipt.outputs.scope_evidence) || receipt.outputs.scope_evidence.length === 0) {
      throw new Error("coding.triage outputs are invalid or do not match the canonical direct request");
    }
  }
  if (receipt.action_id === "planning.confirm") {
    const context = verifiedArtifacts.get(receipt.outputs.planning_context_ref.id);
    if (context.plan_id !== receipt.outputs.plan_id || context.task_mode !== receipt.outputs.task_mode || !same(context.decisions, run.decision_history)) {
      throw new Error("planning_context does not match confirmation outputs or decision history");
    }
  }
  if (["planning.write_spec", "planning.write_plan", "planning.write_tasks"].includes(receipt.action_id) && (
    receipt.outputs.target !== claim.input.fields.target || receipt.outputs.mode !== claim.input.fields.mode || !/^[0-9a-f]{64}$/.test(receipt.outputs.sha256)
  )) throw new Error(`${receipt.action_id} outputs do not match its canonical input`);
  if (receipt.action_id === "planning.write_tasks" && (receipt.outputs.deleted_paths?.length ?? 0) > 0) {
    const decision = claim.input.fields.deletion_decision_ref;
    if (!decision || !run.decision_history.some((entry) => entry.revision === decision.revision && entry.code === decision.code)) {
      throw new Error("planning.write_tasks deletion is not authorized by decision history");
    }
  }
  if (receipt.action_id === "planning.complete" && !same(receipt.outputs.refs, claim.input.fields.refs)) {
    throw new Error("planning.complete outputs do not match canonical refs");
  }
  if (["coding.implement", "coding.fix_direct", "coding.fix_1", "coding.fix_2"].includes(receipt.action_id) && receipt.result === "completed") {
    const evidence = verifiedArtifacts.get(receipt.outputs.change_evidence_ref.id);
    if (claim.input.fields.base_sha !== evidence.base_sha || receipt.outputs.head_sha !== evidence.head_sha || !same([...receipt.outputs.changed_paths].sort(), uniquePaths(evidence.path_changes))) {
      throw new Error(`${receipt.action_id} outputs do not match change_evidence`);
    }
    if (["coding.fix_1", "coding.fix_2"].includes(receipt.action_id) && !same([...receipt.outputs.fixed_finding_ids].sort(), [...claim.input.fields.finding_ids].sort())) {
      throw new Error(`${receipt.action_id} fixed finding IDs do not match its claim`);
    }
  }
  if (action.io_contract === "local_commit" && receipt.result === "completed") {
    if (!/^[0-9a-f]{40,64}$/.test(receipt.outputs.commit_sha) || !same([...receipt.outputs.committed_paths].sort(), uniquePaths(claim.input.fields.path_changes))) {
      throw new Error(`${receipt.action_id} commit outputs do not match claimed PathChange`);
    }
  }
  if (action.io_contract === "review_prepare" && receipt.result === "completed") {
    const packet = verifiedArtifacts.get(receipt.outputs.review_packet_ref.id);
    if (packet.review_base_commit !== claim.input.fields.base_sha || packet.review_commit !== claim.input.fields.review_sha ||
      !same(packet.review_context, claim.input.fields.review_context) || !same(packet.review_slices, claim.input.fields.slices)) {
      throw new Error("ReviewPacket does not match review prepare claim");
    }
  }
  if (action.io_contract === "dual_axis_review" && ["completed", "retryable_failure", "needs_decision"].includes(receipt.result)) {
    const result = verifiedArtifacts.get(receipt.outputs.review_result_ref.id);
    const packetRef = claim.input.artifacts.find((ref) => ref.kind === "review_packet");
    for (const axisRef of result.axis_result_refs) {
      const axis = verifiedArtifacts.get(axisRef.id);
      if (!axis || !same(axis.review_packet_ref, packetRef)) throw new Error("review axis result does not match claimed ReviewPacketRef");
    }
    if (!same([...receipt.outputs.finding_ids].sort(), [...result.finding_ids].sort()) || !same([...receipt.outputs.coverage].sort(), [...result.coverage].sort()) ||
      (receipt.error?.finding_ids && !same([...receipt.error.finding_ids].sort(), [...result.finding_ids].sort()))) {
      throw new Error("review receipt does not match review_result");
    }
  }
}

export async function finishAction({ repository, receipt }) {
  const loaded = await loadRun(repository, receipt?.run_id);
  return withLock(loaded.location.lock, async () => {
    const { contract, location } = await loadRun(repository, receipt.run_id);
    const run = await readJson(location.runFile);
    validateActionReceipt(receipt, contract);
    const { verifyArtifact } = await import("./artifact-store.mjs");
    const verifiedArtifacts = new Map();
    for (const ref of receipt.artifacts) verifiedArtifacts.set(ref.id, await verifyArtifact({ repository, run_id: receipt.run_id, ref }));
    const receiptKey = `${receipt.action_id}:${receipt.attempt}`;
    if (run.receipts[receiptKey]) {
      if (JSON.stringify(run.receipts[receiptKey]) !== JSON.stringify(receipt)) throw new Error("attempt already finished with a different receipt");
      return { receipt: run.receipts[receiptKey], snapshot: snapshot(run, contract) };
    }
    const existing = run.completed_actions[receipt.action_id];
    if (existing) {
      if (JSON.stringify(existing.receipt) !== JSON.stringify(receipt)) throw new Error("action already completed with a different receipt");
      return { receipt: existing.receipt, snapshot: snapshot(run, contract) };
    }
    const claim = run.active_claims[receipt.action_id];
    if (!claim || claim.attempt !== receipt.attempt) throw new Error(`action ${receipt.action_id} is not actively claimed for attempt ${receipt.attempt}`);
    const action = contract.actions[receipt.action_id];
    if (!action || action.workflow !== run.kind || action.from !== run.phase) throw new Error("receipt transition is illegal");
    if (action.io_contract === "dual_axis_review" && ["completed", "retryable_failure", "needs_decision"].includes(receipt.result)) {
      const result = verifiedArtifacts.get(receipt.outputs.review_result_ref.id);
      for (const axisRef of result.axis_result_refs) verifiedArtifacts.set(axisRef.id, await verifyArtifact({ repository, run_id: receipt.run_id, ref: axisRef }));
    }
    validateFinishedSemantics({ receipt, claim, action, run, verifiedArtifacts });
    if (receipt.action_id === "planning.confirm" && receipt.result === "completed") {
      run.planning_context_ref = structuredClone(receipt.outputs.planning_context_ref);
      run.task_mode = receipt.outputs.task_mode;
    }
    if (receipt.action_id === "coding.triage" && receipt.result === "completed") run.direct_kind = receipt.outputs.implementation_kind;
    delete run.active_claims[receipt.action_id];
    applyReceipt(run, receipt, action, contract);
    run.receipts[receiptKey] = structuredClone(receipt);
    const resumableDecision = run.phase === "awaiting_decision" && run.decision_request?.resume_phase === action.from;
    if (!resumableDecision && (receipt.result !== "retryable_failure" || run.phase !== action.from)) {
      run.completed_actions[receipt.action_id] = { receipt: structuredClone(receipt), completed_at: new Date().toISOString() };
    }
    run.updated_at = new Date().toISOString();
    await atomicJson(join(location.run, "actions", receipt.action_id, `attempt-${receipt.attempt}`, "receipt.json"), receipt);
    await atomicJson(location.runFile, run);
    return { receipt: structuredClone(receipt), snapshot: snapshot(run, contract) };
  });
}

export async function recoverAction({ repository, run_id, action_id }) {
  const loaded = await loadRun(repository, run_id);
  return withLock(loaded.location.lock, async () => {
    const { contract, location } = await loadRun(repository, run_id);
    const run = await readJson(location.runFile);
    const claim = run.active_claims[action_id];
    if (!claim) throw new Error("action has no active claim to recover");
    if (pidAlive(claim.owner_pid)) throw new Error("WORKFLOW_BUSY: claim owner is still alive");
    if (run.budgets.recover_remaining <= 0) throw new Error("RECOVERY_BUDGET_EXHAUSTED");
    delete run.active_claims[action_id];
    run.budgets.recover_remaining -= 1;
    run.revision += 1;
    run.updated_at = new Date().toISOString();
    await atomicJson(location.runFile, run);
    return snapshot(run, contract);
  });
}

export async function resolveDecision({ repository, run_id, answer, decision }) {
  const loaded = await loadRun(repository, run_id);
  return withLock(loaded.location.lock, async () => {
    const { contract, location } = await loadRun(repository, run_id);
    const run = await readJson(location.runFile);
    if (run.phase === "awaiting_decision" && run.decision_request?.code === "PLANNING_REQUIRED" && !run.decision_request.resume_phase) {
      throw new Error(`PLANNING_HANDOFF_REQUIRED: call start with {operation:"start",repository:${JSON.stringify(repository)},kind:"planning",source_run_id:${JSON.stringify(run_id)}}`);
    }
    if (run.phase !== "awaiting_decision" || !run.decision_request?.resume_phase) throw new Error("run has no resumable decision request");
    if (answer !== undefined) {
      if (decision !== undefined || typeof answer !== "string" || !answer.trim()) throw new Error("decide requires exactly one non-empty answer or decision object");
      decision = { code: run.decision_request.code, summary: answer };
    }
    const validDecision = decision && typeof decision === "object" && !Array.isArray(decision) &&
      Object.keys(decision).sort().join() === "code,summary" && decision.code === run.decision_request.code &&
      typeof decision.summary === "string" && decision.summary.trim();
    if (!validDecision) {
      throw new Error(`decision must be exactly {code:${JSON.stringify(run.decision_request.code)},summary:<verbatim user answer>}`);
    }
    const historyEntry = { revision: run.revision + 1, code: decision.code, summary: decision.summary };
    run.phase = run.decision_request.resume_phase;
    run.decision_request = null;
    run.decision_history.push(historyEntry);
    run.revision += 1;
    run.updated_at = new Date().toISOString();
    const decisionDirectory = join(location.run, "decisions");
    await ensureDirectoryChain(location.common, decisionDirectory);
    await atomicJson(join(decisionDirectory, `revision-${run.revision}.json`), historyEntry);
    await atomicJson(location.runFile, run);
    return snapshot(run, contract);
  });
}

export async function validateSupportAction({ repository, caller_ref, input, receipt }) {
  const loaded = await loadRun(repository, receipt?.run_id);
  return withLock(loaded.location.lock, async () => {
    const { contract, location } = await loadRun(repository, receipt.run_id);
    const run = await readJson(location.runFile);
    validateSupportReceipt(receipt, contract);
    if (receipt.caller_ref !== caller_ref) throw new Error("SupportReceipt caller is invalid");
    const callerClaim = Object.values(run.active_claims).find((claim) => claim.claim_id === caller_ref);
    if (!callerClaim) throw new Error("SupportReceipt caller_ref is not an active claim");
    const callerOwner = contract.actions[callerClaim.action_id]?.owner;
    const owner = contract.actions[receipt.action_id].owner;
    if (!contract.support_delegations[callerOwner]?.includes(receipt.action_id)) {
      throw new Error(`Support action ${receipt.action_id} is not delegated by ${callerOwner}`);
    }
    validateActionInput(input, receipt.action_id, contract);
    const { verifyArtifact } = await import("./artifact-store.mjs");
    const verified = new Map();
    for (const ref of [...input.artifacts, ...receipt.artifacts]) verified.set(ref.id, await verifyArtifact({ repository, run_id: receipt.run_id, ref }));
    if (receipt.action_id === "support.research" && receipt.result === "completed" && (
      receipt.outputs.report_path !== input.fields.report_path || !receipt.outputs.changed_paths.includes(input.fields.report_path)
    )) throw new Error("research support result does not match its report target");
    if (receipt.action_id === "support.update_docs" && receipt.result === "completed" && !receipt.outputs.changed_paths.includes(input.fields.target)) {
      throw new Error("documentation support result does not include its target");
    }
    if (["support.review_standards", "support.review_spec"].includes(receipt.action_id) && receipt.result === "completed") {
      const packetRef = input.artifacts.find((ref) => ref.kind === "review_packet");
      const axis = verified.get(receipt.outputs.axis_result_ref.id);
      const expectedAxis = receipt.action_id === "support.review_standards" ? "standards" : "spec";
      const findingIds = axis.findings.map((finding) => finding.id).sort();
      if (axis.axis !== expectedAxis || input.fields.axis !== expectedAxis || !same(input.fields.review_packet_ref, packetRef) || !same(axis.review_packet_ref, packetRef) ||
        !same([...input.fields.assigned_slices].sort(), [...axis.coverage].sort()) || !same([...receipt.outputs.coverage].sort(), [...axis.coverage].sort()) ||
        !same([...receipt.outputs.finding_ids].sort(), findingIds)) {
        throw new Error("review support result does not match its axis or ReviewPacketRef");
      }
    }
    const directory = join(location.run, "support");
    const target = join(directory, `${receipt.call_id}.json`);
    const canonical = { owner, input: structuredClone(input), receipt: structuredClone(receipt) };
    try {
      const existing = await readJson(target);
      if (JSON.stringify(existing) !== JSON.stringify(canonical)) throw new Error("support call already validated with different input or receipt");
      return structuredClone(existing.receipt);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await ensureDirectoryChain(location.common, directory);
    await atomicJson(target, canonical);
    return structuredClone(receipt);
  });
}

export async function workflowRunPaths(repository, runId) {
  return paths(repository, runId);
}

export async function ensureWorkflowDirectory(repository, target) {
  const location = await paths(repository);
  await ensureDirectoryChain(location.common, target);
}
