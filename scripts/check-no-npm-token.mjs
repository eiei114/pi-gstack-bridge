#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const workflowDir = fileURLToPath(new URL("../.github/workflows/", import.meta.url));
const forbidden = /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\.NPM_TOKEN/u;
for (const entry of readdirSync(workflowDir)) {
  if (!entry.endsWith(".yml") && !entry.endsWith(".yaml")) continue;
  const file = join(workflowDir, entry);
  if (forbidden.test(readFileSync(file, "utf8"))) {
    throw new Error(`Forbidden npm token reference in ${entry}`);
  }
}
console.log("publish guard passed: no long-lived npm token references");
