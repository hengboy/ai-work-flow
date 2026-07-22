#!/usr/bin/env node
import process from 'node:process';

import { runCli } from './private/workflow.mjs';

try {
  runCli(process.argv.slice(2));
} catch (error) {
  console.error(`ai-work-flow: ${error.message}`);
  process.exitCode = 1;
}
