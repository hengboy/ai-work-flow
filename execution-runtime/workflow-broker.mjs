#!/usr/bin/env node
import { createInterface } from "node:readline";

import { handleBrokerRequest } from "./lib/workflow-broker.mjs";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  let response;
  try { response = await handleBrokerRequest(JSON.parse(line)); }
  catch (error) { response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: error.message } }; }
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
}
