import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { posix, resolve } from "node:path";

export const RUNTIME_PROVENANCE_FILE = "runtime-provenance.json";
export const RUNTIME_PROVENANCE_IDENTITY = "ai-work-flow/execution-runtime";
export const RUNTIME_PROVENANCE_VERSION = 1;

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const PROVENANCE_FIELDS = ["protocol_version", "type", "source", "managed_files", "files_digest", "provenance_digest"];
const SOURCE_FIELDS = ["identity", "revision"];
const FILE_FIELDS = ["path", "digest"];

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash("sha256").update(Buffer.isBuffer(value) ? value : JSON.stringify(canonicalize(value))).digest("hex");
}

function exactFields(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...fields].sort());
}

function runtimeFiles(root, prefix = "") {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!prefix && entry.name === RUNTIME_PROVENANCE_FILE) continue;
    const path = resolve(root, entry.name);
    const relativePath = prefix ? posix.join(prefix, entry.name) : entry.name;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Execution runtime contains a symbolic link: ${relativePath}`);
    if (stat.isDirectory()) files.push(...runtimeFiles(path, relativePath));
    else if (stat.isFile()) files.push({ path: relativePath, digest: digest(readFileSync(path)) });
    else throw new Error(`Execution runtime contains an unsupported entry: ${relativePath}`);
  }
  return files;
}

export function runtimeProvenanceDigest(provenance) {
  const { provenance_digest, ...unsigned } = provenance;
  return digest(unsigned);
}

export function createRuntimeProvenance(root) {
  const managed_files = runtimeFiles(root);
  const files_digest = digest(managed_files);
  const provenance = {
    protocol_version: RUNTIME_PROVENANCE_VERSION,
    type: "execution-runtime-provenance",
    source: { identity: RUNTIME_PROVENANCE_IDENTITY, revision: files_digest },
    managed_files,
    files_digest,
  };
  provenance.provenance_digest = runtimeProvenanceDigest(provenance);
  return provenance;
}

export function assertRuntimeProvenance(root, provenance, expectedSource) {
  if (!exactFields(provenance, PROVENANCE_FIELDS) || provenance.protocol_version !== RUNTIME_PROVENANCE_VERSION || provenance.type !== "execution-runtime-provenance") {
    throw new Error("Execution runtime provenance has an unsupported protocol or shape");
  }
  if (!exactFields(provenance.source, SOURCE_FIELDS) || provenance.source.identity !== RUNTIME_PROVENANCE_IDENTITY || !DIGEST_PATTERN.test(provenance.source.revision)) {
    throw new Error("Execution runtime source provenance is invalid");
  }
  if (!Array.isArray(provenance.managed_files) || provenance.managed_files.length === 0 || provenance.managed_files.some((file) => (
    !exactFields(file, FILE_FIELDS) || typeof file.path !== "string" || !file.path || posix.isAbsolute(file.path) || posix.normalize(file.path) !== file.path || !DIGEST_PATTERN.test(file.digest)
  ))) {
    throw new Error("Execution runtime provenance has an invalid managed file catalog");
  }
  const paths = provenance.managed_files.map((file) => file.path);
  if (new Set(paths).size !== paths.length || JSON.stringify(paths) !== JSON.stringify([...paths].sort())) {
    throw new Error("Execution runtime provenance managed files must be unique and sorted");
  }
  if (provenance.files_digest !== digest(provenance.managed_files) || provenance.source.revision !== provenance.files_digest || provenance.provenance_digest !== runtimeProvenanceDigest(provenance)) {
    throw new Error("Execution runtime provenance digest is invalid");
  }
  if (expectedSource && (provenance.source.identity !== expectedSource.identity || provenance.source.revision !== expectedSource.revision)) {
    throw new Error("Execution runtime provenance does not match the expected source");
  }
  const actual = createRuntimeProvenance(root);
  if (JSON.stringify(actual.managed_files) !== JSON.stringify(provenance.managed_files) || actual.files_digest !== provenance.files_digest) {
    throw new Error("Execution runtime files do not match installed provenance");
  }
  return Object.freeze({
    protocol_version: provenance.protocol_version,
    source_identity: provenance.source.identity,
    source_revision: provenance.source.revision,
    installed_revision: actual.files_digest,
    provenance_digest: provenance.provenance_digest,
  });
}

export function loadAndAssertRuntimeProvenance(root, expectedSource) {
  let provenance;
  try {
    provenance = JSON.parse(readFileSync(resolve(root, RUNTIME_PROVENANCE_FILE), "utf8"));
  } catch (error) {
    throw new Error(`Execution runtime provenance is missing or unreadable: ${error.message}`, { cause: error });
  }
  return { provenance, evidence: assertRuntimeProvenance(root, provenance, expectedSource) };
}
