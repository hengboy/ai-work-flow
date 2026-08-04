import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { fail, isPlainObject, readJson } from "./shared.mjs";

function skillRoot() {
  return [resolve(import.meta.dirname, "..", "..", "skills"), resolve(import.meta.dirname, "..", "skills")].find(existsSync);
}

function contractPath() {
  return [resolve(import.meta.dirname, "..", "..", "execution-runtime", "workflow-contract.json"), resolve(import.meta.dirname, "..", "execution-runtime", "workflow-contract.json")].find(existsSync);
}

function quoted(value) {
  return JSON.stringify(value);
}

export function renderSkillOpenAiYaml(skill) {
  return [
    "interface:",
    `  display_name: ${quoted(skill.display_name)}`,
    `  short_description: ${quoted(skill.short_description)}`,
    `  default_prompt: ${quoted(skill.default_prompt)}`,
    "",
  ].join("\n");
}

function frontmatter(source) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (!match) throw new Error("SKILL.md must begin with YAML frontmatter");
  const result = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error("SKILL.md frontmatter must use key: value lines");
    result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return result;
}

export function loadSkillAssets(configRoot = resolve(import.meta.dirname, "..", "config"), skillsRoot = skillRoot(), workflowContractPath = contractPath()) {
  if (!skillsRoot) fail("Missing managed skills.");
  const document = readJson(resolve(configRoot, "skills.json"));
  const contract = readJson(workflowContractPath);
  const roles = readJson(resolve(configRoot, "roles.json")).roles;
  const errors = [];
  if (!isPlainObject(document) || Object.keys(document).join() !== "skills" || !Array.isArray(document.skills)) errors.push("skills.json must contain only a skills array.");
  const skills = document.skills ?? [];
  const names = skills.map((skill) => skill?.name);
  if (new Set(names).size !== names.length) errors.push("skills.json contains duplicate names.");
  const directories = readdirSync(skillsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync(resolve(skillsRoot, entry.name, "SKILL.md"))).map((entry) => entry.name).sort();
  if (JSON.stringify([...names].sort()) !== JSON.stringify(directories)) errors.push("skills.json and managed Skill directories do not match.");
  for (const skill of skills) {
    const fields = ["name", "trigger_branches", "owner", "runtime_action", "display_name", "short_description", "default_prompt"];
    if (!isPlainObject(skill) || Object.keys(skill).sort().join() !== [...fields].sort().join()) {
      errors.push(`Skill ${skill?.name ?? "unknown"} has an invalid metadata shape.`);
      continue;
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) || !Array.isArray(skill.trigger_branches) || skill.trigger_branches.length === 0 || skill.trigger_branches.some((entry) => typeof entry !== "string" || !entry)) errors.push(`Skill ${skill.name} has invalid triggers.`);
    for (const field of ["owner", "runtime_action", "display_name", "short_description", "default_prompt"]) if (typeof skill[field] !== "string" || !skill[field]) errors.push(`Skill ${skill.name}.${field} must be a non-empty string.`);
    if (skill.short_description.length < 25 || skill.short_description.length > 64) errors.push(`Skill ${skill.name} short_description must contain 25-64 characters.`);
    if (!skill.default_prompt.includes(`$${skill.name}`)) errors.push(`Skill ${skill.name} default_prompt must explicitly contain $${skill.name}.`);
    if (!roles.some((role) => role.id === skill.owner) || contract.actions[skill.runtime_action]?.owner !== skill.owner) errors.push(`Skill ${skill.name} runtime_action and owner must match workflow-contract.json.`);
    const source = readFileSync(resolve(skillsRoot, skill.name, "SKILL.md"), "utf8");
    try {
      const metadata = frontmatter(source);
      if (Object.keys(metadata).sort().join() !== "description,name" || metadata.name !== skill.name || !metadata.description) errors.push(`Skill ${skill.name} frontmatter is not canonical.`);
    } catch (error) { errors.push(`Skill ${skill.name}: ${error.message}`); }
    if (source.length > 4_000) errors.push(`Skill ${skill.name} body exceeds 4000 characters.`);
    const yamlPath = resolve(skillsRoot, skill.name, "agents", "openai.yaml");
    if (!existsSync(yamlPath) || readFileSync(yamlPath, "utf8") !== renderSkillOpenAiYaml(skill)) errors.push(`Skill ${skill.name} openai.yaml is stale.`);
  }
  const total = skills.reduce((sum, skill) => sum + readFileSync(resolve(skillsRoot, skill.name, "SKILL.md"), "utf8").length, 0);
  if (total > 12_000) errors.push(`Managed Skill bodies exceed 12000 characters: ${total}.`);
  if (errors.length) fail(`Skill asset catalog is invalid:\n${errors.join("\n")}`);
  return { skills, skillsRoot };
}
