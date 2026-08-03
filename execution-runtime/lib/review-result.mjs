const VERDICTS = new Set(["approved", "blocked"]);

function assertFinding(finding) {
  if (!finding || typeof finding.id !== "string" || !finding.id || typeof finding.summary !== "string" || !finding.summary || typeof finding.evidence !== "string" || !finding.evidence) {
    throw new Error("Review findings require stable id, summary, and evidence");
  }
  return finding;
}

function assertAxis(axis, name) {
  if (!axis || !VERDICTS.has(axis.verdict) || !Array.isArray(axis.blocking_findings) || !Array.isArray(axis.advisory_findings)) {
    throw new Error(`${name} review result is invalid`);
  }
  axis.blocking_findings.forEach(assertFinding);
  axis.advisory_findings.forEach(assertFinding);
  const ids = [...axis.blocking_findings, ...axis.advisory_findings].map((finding) => finding.id);
  if (new Set(ids).size !== ids.length) throw new Error(`${name} review findings must have unique IDs`);
  if (axis.verdict === "approved" && axis.blocking_findings.length > 0) throw new Error(`${name} cannot approve with blocking findings`);
  if (axis.verdict === "blocked" && axis.blocking_findings.length === 0) throw new Error(`${name} must identify blocking findings`);
  return axis;
}

export function assertReviewResult(result, manifestDigest) {
  if (!result || result.manifest_digest !== manifestDigest) throw new Error("Review result must identify the frozen ReviewManifest");
  assertAxis(result.standards, "Standards");
  assertAxis(result.spec, "Spec");
  if (!result.coverage || result.coverage.manifest_digest !== manifestDigest) throw new Error("Review result coverage must identify the frozen ReviewManifest");
  return result;
}

export function blockingFindingIds(result) {
  return [
    ...result.standards.blocking_findings,
    ...result.spec.blocking_findings,
  ].map((finding) => finding.id);
}

export function hasBlockingFindings(result) {
  return blockingFindingIds(result).length > 0;
}
