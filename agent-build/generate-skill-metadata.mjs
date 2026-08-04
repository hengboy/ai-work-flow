#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadSkillAssets, renderSkillOpenAiYaml } from "./runtime/skill-catalog.mjs";
import { readJson } from "./runtime/shared.mjs";

const configRoot = resolve(import.meta.dirname, "config");
const skillsRoot = resolve(import.meta.dirname, "..", "skills");
const document = readJson(resolve(configRoot, "skills.json"));
for (const skill of document.skills) {
  const directory = resolve(skillsRoot, skill.name, "agents");
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "openai.yaml"), renderSkillOpenAiYaml(skill));
}
loadSkillAssets(configRoot, skillsRoot);
process.stdout.write("Skill metadata is in sync.\n");
