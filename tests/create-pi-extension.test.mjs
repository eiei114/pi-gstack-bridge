import assert from "node:assert/strict";
import test from "node:test";

import { resolveOutputDirectory } from "../packages/create-pi-extension/src/scaffold.mjs";

test("rejects multi-segment output directory names", () => {
  assert.throws(
    () => resolveOutputDirectory(process.cwd(), "nested/project"),
    /Output directory must be a single relative directory name/u,
  );
});
