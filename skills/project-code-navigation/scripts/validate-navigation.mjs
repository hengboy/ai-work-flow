#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const root = resolve(process.argv[2] ?? process.cwd());
const paths = ["feature-navigation.md", "frontend-navigation.md", "backend-navigation.md"];
let checked = 0;
for (const name of paths) {
  let source;
  try { source = await readFile(resolve(root, ".ai-work-flow/index", name), "utf8"); } catch (error) { if (error.code === "ENOENT" && name !== paths[0]) continue; throw error; }
  for (const line of source.split("\n").filter((candidate) => candidate.startsWith("|") && !candidate.includes("---"))) {
    const entryCell = line.split("|")[2] ?? "";
    for (const match of entryCell.matchAll(/`([^`]+)`/g)) {
      const values = match[1].split(" -> ").filter((value) => !value.includes("待确认") && !value.includes("{") && !value.includes("*"));
      for (const value of values) {
        if (isAbsolute(value) || value.startsWith("../")) throw new Error(`navigation path must be repository-relative: ${value}`);
        await access(resolve(root, value));
        checked += 1;
      }
    }
  }
}
if (checked === 0) throw new Error("navigation index contains no verifiable paths");
process.stdout.write(`Navigation is valid (${checked} paths).\n`);
