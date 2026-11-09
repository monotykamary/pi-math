import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("cold discovery and text-only sessions defer engines until synchronous first rendering", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const output = execFileSync(process.execPath, ["--import", "tsx", "scripts/startup-probe.mjs", "--assert-lazy"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  const result = JSON.parse(output.trim().split("\n").at(-1)!);
  assert.equal(result.idleModules, 0);
  assert.ok(result.afterModules > 0);
});
