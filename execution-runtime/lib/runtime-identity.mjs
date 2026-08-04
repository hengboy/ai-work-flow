import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { posix, resolve } from "node:path";

export const RUNTIME_IDENTITY_FILE = "runtime-identity.json";
export const RUNTIME_SOURCE_IDENTITY = "ai-work-flow/execution-runtime";
export const RUNTIME_IDENTITY_EXCLUDED_DIRECTORIES = Object.freeze(["node_modules"]);

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const IDENTITY_FIELDS = ["type", "source", "managed_files", "files_digest", "identity_digest"];

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

function digest(value) {
  return createHash("sha256").update(Buffer.isBuffer(value) ? value : JSON.stringify(canonicalize(value))).digest("hex");
}

function exactFields(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...fields].sort());
}

function runtimeFiles(root, prefix = "") {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!prefix && entry.name === RUNTIME_IDENTITY_FILE) continue;
    const path = resolve(root, entry.name);
    const relativePath = prefix ? posix.join(prefix, entry.name) : entry.name;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Execution runtime contains a symbolic link: ${relativePath}`);
    if (stat.isDirectory()) {
      if (!RUNTIME_IDENTITY_EXCLUDED_DIRECTORIES.includes(entry.name)) files.push(...runtimeFiles(path, relativePath));
    } else if (stat.isFile()) files.push({ path: relativePath, digest: digest(readFileSync(path)) });
    else throw new Error(`Execution runtime contains an unsupported entry: ${relativePath}`);
  }
  return files;
}

export function runtimeIdentityDigest(identity) {
  const { identity_digest, ...unsigned } = identity;
  return digest(unsigned);
}

export function createRuntimeIdentity(root) {
  const managed_files = runtimeFiles(root);
  const files_digest = digest(managed_files);
  const identity = {
    type: "execution-runtime-identity",
    source: { identity: RUNTIME_SOURCE_IDENTITY, revision: files_digest },
    managed_files,
    files_digest,
  };
  identity.identity_digest = runtimeIdentityDigest(identity);
  return identity;
}

export function assertRuntimeIdentity(root, identity, expectedSource) {
  if (!exactFields(identity, IDENTITY_FIELDS) || identity.type !== "execution-runtime-identity" ||
    !exactFields(identity.source, ["identity", "revision"]) || identity.source.identity !== RUNTIME_SOURCE_IDENTITY || !DIGEST_PATTERN.test(identity.source.revision)) {
    throw new Error("Execution runtime identity has an invalid shape");
  }
  if (!Array.isArray(identity.managed_files) || identity.managed_files.length === 0 || identity.managed_files.some((file) => (
    !exactFields(file, ["path", "digest"]) || typeof file.path !== "string" || !file.path || posix.isAbsolute(file.path) || posix.normalize(file.path) !== file.path || !DIGEST_PATTERN.test(file.digest)
  ))) throw new Error("Execution runtime identity has an invalid file catalog");
  const paths = identity.managed_files.map((file) => file.path);
  if (new Set(paths).size !== paths.length || JSON.stringify(paths) !== JSON.stringify([...paths].sort())) throw new Error("Execution runtime identity paths must be unique and sorted");
  if (identity.files_digest !== digest(identity.managed_files) || identity.source.revision !== identity.files_digest || identity.identity_digest !== runtimeIdentityDigest(identity)) throw new Error("Execution runtime identity digest is invalid");
  if (expectedSource && (identity.source.identity !== expectedSource.identity || identity.source.revision !== expectedSource.revision)) throw new Error("Execution runtime identity does not match the expected source");
  const actual = createRuntimeIdentity(root);
  if (JSON.stringify(actual.managed_files) !== JSON.stringify(identity.managed_files) || actual.files_digest !== identity.files_digest) throw new Error("Execution runtime files do not match installed identity");
  return Object.freeze({
    source_identity: identity.source.identity,
    source_revision: identity.source.revision,
    installed_revision: actual.files_digest,
    identity_digest: identity.identity_digest,
  });
}

export function loadAndAssertRuntimeIdentity(root, expectedSource) {
  let identity;
  try { identity = JSON.parse(readFileSync(resolve(root, RUNTIME_IDENTITY_FILE), "utf8")); }
  catch (error) { throw new Error(`Execution runtime identity is missing or unreadable: ${error.message}`, { cause: error }); }
  return { identity, evidence: assertRuntimeIdentity(root, identity, expectedSource) };
}
