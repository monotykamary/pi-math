import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import extension from "../src/index.js";

test("discovery and non-TUI sessions never patch; shutdown cancels rearm and TUI restart reinstalls", async () => {
  const stock = Markdown.prototype.render;
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const api = { on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, fn), registerCommand: () => {} } as unknown as ExtensionAPI;
  const fire = async (name: string, mode = "tui") => handlers.get(name)?.({}, { mode, ui: { notify: () => {} } });
  await extension(api);
  try {
    assert.equal(Markdown.prototype.render, stock);
    for (const mode of ["rpc", "json", "print"]) {
      await fire("session_start", mode);
      await fire("turn_start", mode);
      assert.equal(Markdown.prototype.render, stock);
      await fire("session_shutdown", mode);
    }
    const interrupted = fire("session_start");
    await fire("session_shutdown");
    await interrupted;
    assert.equal(Markdown.prototype.render, stock, "a stale async load must not install a patch after shutdown");
    await fire("session_start");
    assert.notEqual(Markdown.prototype.render, stock);
    await fire("session_shutdown");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(Markdown.prototype.render, stock);
    await fire("turn_start");
    assert.equal(Markdown.prototype.render, stock);
    await fire("session_start");
    assert.notEqual(Markdown.prototype.render, stock);
    await fire("session_shutdown");
    await fire("session_shutdown");
    assert.equal(Markdown.prototype.render, stock);
  } finally {
    await fire("session_shutdown");
    Markdown.prototype.render = stock;
  }
});
