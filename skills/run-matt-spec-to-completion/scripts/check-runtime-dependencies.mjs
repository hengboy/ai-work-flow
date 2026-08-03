import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourceRuntime = fileURLToPath(new URL("../../../execution-runtime/", import.meta.url));
const configHome = process.env.XDG_CONFIG_HOME ? resolve(process.env.XDG_CONFIG_HOME) : resolve(homedir(), ".config");
const runtimeDirectory = existsSync(resolve(sourceRuntime, "package.json"))
  ? sourceRuntime
  : resolve(configHome, "ai-work-flow", "execution-runtime");
const requiredFiles = ["package.json", "package-lock.json"];
const validationUrl = pathToFileURL(resolve(runtimeDirectory, "lib", "validation.mjs")).href;

function validateRuntime() {
  execFileSync(process.execPath, ["--input-type=module", "--eval", `await import(${JSON.stringify(validationUrl)})`], {
    cwd: runtimeDirectory,
    stdio: "pipe",
  });
}

try {
  await Promise.all(requiredFiles.map((file) => access(resolve(runtimeDirectory, file))));
  try {
    validateRuntime();
  } catch {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    execFileSync(npm, ["ci", "--omit=dev"], { cwd: runtimeDirectory, stdio: "inherit" });
    validateRuntime();
  }
  console.log("Runtime dependencies are available.");
} catch (error) {
  console.error(`Runtime dependency check failed: ${error.message}`);
  console.error(`Run \"npm ci --omit=dev\" in ${runtimeDirectory}, then rerun the skill runtime check.`);
  process.exitCode = 1;
}
