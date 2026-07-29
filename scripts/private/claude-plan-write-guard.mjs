import { lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';

function deny() {
  console.error('Planning may only write .ai-work-flow/plans/<planId>.md.');
  process.exit(2);
}

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  deny();
}

if (input?.tool_name !== 'Write' || typeof input?.tool_input?.file_path !== 'string') deny();

const projectRoot = resolve(process.cwd());
const plansRoot = resolve(projectRoot, '.ai-work-flow/plans');
const target = resolve(projectRoot, input.tool_input.file_path);
const relativeTarget = relative(plansRoot, target);
const planId = basename(target, '.md');
const isDirectChild = dirname(target) === plansRoot
  && relativeTarget !== ''
  && !relativeTarget.startsWith('..')
  && !relativeTarget.includes(`..${sep}`);

let current = projectRoot;
let hasSymbolicLink = false;
for (const segment of relative(projectRoot, target).split(sep).filter(Boolean)) {
  current = resolve(current, segment);
  try {
    if (lstatSync(current).isSymbolicLink()) {
      hasSymbolicLink = true;
      break;
    }
  } catch (error) {
    if (error.code === 'ENOENT') break;
    deny();
  }
}

if (hasSymbolicLink || !isDirectChild || basename(target) !== `${planId}.md` || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(planId)) deny();
