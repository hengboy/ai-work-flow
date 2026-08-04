import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { loadWorkflowContract, validateActionInput, validateActionReceipt, validateSupportReceipt } from "./workflow-contract.mjs";

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

function runKey(kind, planDigest, taskMode) {
  return createHash("sha256").update(`${kind}\0${planDigest}\0${taskMode ?? ""}`).digest("hex");
}

export async function startRun({ repository, kind, plan_digest, task_mode }) {
  const contract = await loadWorkflowContract();
  if (!contract.workflows[kind] || !/^[0-9a-f]{64}$/.test(plan_digest) || (kind === "coding" && !["single", "split"].includes(task_mode))) {
    throw new Error("start input is invalid");
  }
  const location = await paths(repository);
  await ensureDirectoryChain(location.common, location.runs);
  await assertPathChain(location.common, location.runs);
  const key = runKey(kind, plan_digest, task_mode);
  const indexPath = join(location.base, "plan-index", `${key}.json`);
  const startLock = join(location.base, ".start-lock");
  return withLock(startLock, async () => {
    try {
      const existing = await readJson(indexPath);
      return statusRun({ repository, run_id: existing.run_id });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const runId = `run_${randomBytes(12).toString("hex")}`;
    const runLocation = await paths(repository, runId);
    const run = {
      contract_digest: contract.digest,
      run_id: runId,
      kind,
      plan_digest,
      task_mode: task_mode ?? null,
      revision: 0,
      phase: contract.workflows[kind].initial_phase,
      active_claims: {},
      attempts: {},
      completed_actions: {},
      receipts: {},
      budgets: initialBudgets(contract),
      decision_request: null,
      decision_history: [],
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

export async function statusRun({ repository, run_id, action_id }) {
  const { contract, run } = await loadRun(repository, run_id);
  if (!Number.isSafeInteger(run.revision) || run.revision < 0 || !contract.workflows[run.kind].terminal_phases.includes(run.phase) && !contract.workflows[run.kind].phase_actions[run.phase]) throw new Error("run state is invalid");
  const result = snapshot(run, contract);
  if (action_id) {
    const completed = run.completed_actions[action_id]?.receipt;
    const canonical = completed ?? run.receipts[`${action_id}:${run.attempts[action_id]}`];
    if (canonical) result.result_receipt = structuredClone(canonical);
  }
  return result;
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
    validateActionInput(input, action_id, contract);
    if (action_id === "coding.prepare" && (input.fields.plan_digest !== run.plan_digest || input.fields.task_mode !== run.task_mode)) throw new Error("coding.prepare input does not match run identity");
    if (action_id === "planning.confirm" && JSON.stringify(input.fields.decision_history) !== JSON.stringify(run.decision_history)) throw new Error("planning.confirm decision history is stale");
    const { verifyArtifact } = await import("./artifact-store.mjs");
    for (const ref of input.artifacts) await verifyArtifact({ repository, run_id, ref });
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
    if (!action.completed_to || action.completed_to === run.phase) throw new Error("WORKFLOW_STALLED: completed action did not advance phase");
    run.phase = action.completed_to;
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
    run.decision_request = { ...receipt.decision_request, resume_phase: action.from };
  } else {
    run.phase = "failed";
    run.decision_request = { code: "UNRECOVERABLE_FAILURE", summary: receipt.summary };
  }
  run.revision += 1;
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
    if (receipt.action_id === "planning.confirm" && receipt.result === "completed") {
      const context = verifiedArtifacts.get(receipt.outputs.planning_context_ref.id);
      if (context.plan_id !== receipt.outputs.plan_id || context.task_mode !== receipt.outputs.task_mode || JSON.stringify(context.decisions) !== JSON.stringify(run.decision_history)) {
        throw new Error("planning_context does not match confirmation outputs or decision history");
      }
    }
    if (action.io_contract === "dual_axis_review" && ["completed", "retryable_failure", "needs_decision"].includes(receipt.result)) {
      const result = verifiedArtifacts.get(receipt.outputs.review_result_ref.id);
      const packetRef = claim.input.artifacts.find((ref) => ref.kind === "review_packet");
      for (const axisRef of result.axis_result_refs) {
        const axis = await verifyArtifact({ repository, run_id: receipt.run_id, ref: axisRef });
        if (JSON.stringify(axis.review_packet_ref) !== JSON.stringify(packetRef)) throw new Error("review axis result does not match claimed ReviewPacketRef");
      }
      if (JSON.stringify([...receipt.outputs.finding_ids].sort()) !== JSON.stringify([...result.finding_ids].sort()) ||
        (receipt.error?.finding_ids && JSON.stringify([...receipt.error.finding_ids].sort()) !== JSON.stringify([...result.finding_ids].sort()))) {
        throw new Error("review finding IDs do not match review_result");
      }
    }
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

export async function resolveDecision({ repository, run_id, decision }) {
  const loaded = await loadRun(repository, run_id);
  return withLock(loaded.location.lock, async () => {
    const { contract, location } = await loadRun(repository, run_id);
    const run = await readJson(location.runFile);
    if (run.phase !== "awaiting_decision" || !run.decision_request?.resume_phase) throw new Error("run has no resumable decision request");
    if (!decision || decision.code !== run.decision_request.code || typeof decision.summary !== "string" || !decision.summary.trim()) throw new Error("decision does not match the active request");
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

export async function validateSupportAction({ repository, caller_ref, owner, input, receipt }) {
  const loaded = await loadRun(repository, receipt?.run_id);
  return withLock(loaded.location.lock, async () => {
    const { contract, location } = await loadRun(repository, receipt.run_id);
    const run = await readJson(location.runFile);
    validateSupportReceipt(receipt, contract);
    if (receipt.caller_ref !== caller_ref || contract.actions[receipt.action_id].owner !== owner) throw new Error("SupportReceipt caller or owner is invalid");
    const callerClaim = Object.values(run.active_claims).find((claim) => claim.claim_id === caller_ref);
    if (!callerClaim) throw new Error("SupportReceipt caller_ref is not an active claim");
    validateActionInput(input, receipt.action_id, contract);
    const { verifyArtifact } = await import("./artifact-store.mjs");
    const verified = new Map();
    for (const ref of [...input.artifacts, ...receipt.artifacts]) verified.set(ref.id, await verifyArtifact({ repository, run_id: receipt.run_id, ref }));
    if (["support.review_standards", "support.review_spec"].includes(receipt.action_id) && receipt.result === "completed") {
      const packetRef = input.artifacts.find((ref) => ref.kind === "review_packet");
      const axis = verified.get(receipt.outputs.axis_result_ref.id);
      const expectedAxis = receipt.action_id === "support.review_standards" ? "standards" : "spec";
      if (axis.axis !== expectedAxis || input.fields.axis !== expectedAxis || JSON.stringify(axis.review_packet_ref) !== JSON.stringify(packetRef)) {
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
