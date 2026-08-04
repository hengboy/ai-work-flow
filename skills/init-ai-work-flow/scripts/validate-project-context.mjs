#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const root = resolve(process.argv[2] ?? process.cwd());
const memory = await readFile(resolve(root, "MEMORY.md"), "utf8");
for (const heading of ["领域术语", "仓库约束", "职责", "模块边界"]) {
  const count = (memory.match(new RegExp(`^## ${heading}$`, "gm")) ?? []).length;
  if (count !== 1) throw new Error(`MEMORY.md must contain exactly one ${heading} section`);
}
const indexPath = resolve(root, ".ai-work-flow/index/feature-navigation.md");
const index = await readFile(indexPath, "utf8");
for (const line of index.split("\n").filter((candidate) => candidate.startsWith("|") && !candidate.includes("---"))) {
  const entryCell = line.split("|")[2] ?? "";
  for (const match of entryCell.matchAll(/`([^`]+)`/g)) {
    const value = match[1].split(" -> ")[0];
    if (value.includes("待确认") || value.includes("{") || value.includes("*")) continue;
    if (isAbsolute(value) || value.startsWith("../")) throw new Error(`index path must be repository-relative: ${value}`);
    await access(resolve(root, value));
  }
}
process.stdout.write("Project context is valid.\n");
