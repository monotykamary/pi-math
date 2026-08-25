import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  setCapabilities,
  setCellDimensions,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import piMathExtension from "../src/index.js";

type EventHandler = (event: unknown, ctx: unknown) => unknown;
type CommandHandler = (args: string, ctx: unknown) => unknown;
type MarkdownRender = (this: Markdown, width: number) => string[];

interface TestContext {
  mode: "tui";
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}

const identity = (text: string) => text;
const markdownTheme: MarkdownTheme = {
  heading: identity,
  link: identity,
  linkUrl: identity,
  code: identity,
  codeBlock: identity,
  codeBlockBorder: identity,
  quote: identity,
  quoteBorder: identity,
  hr: identity,
  listBullet: identity,
  bold: identity,
  italic: identity,
  strikethrough: identity,
  underline: identity,
};

const context: TestContext = {
  mode: "tui",
  ui: { notify: () => undefined },
};

function imageLineCount(lines: string[]): number {
  return lines.filter((line) => line.includes("\x1b_G")).length;
}

async function nextMacrotask(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

interface Harness {
  pi: ExtensionAPI;
  fire(name: string): Promise<void>;
  command(name: string, args: string): Promise<void>;
}

function createHarness(): Harness {
  const events = new Map<string, EventHandler[]>();
  const commands = new Map<string, CommandHandler>();
  const api = {
    on(name: string, handler: EventHandler) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
    registerCommand(name: string, options: { handler: CommandHandler }) {
      commands.set(name, options.handler);
    },
  } as unknown as ExtensionAPI;
  return {
    pi: api,
    async fire(name: string) {
      for (const handler of events.get(name) ?? []) await handler({}, context);
    },
    async command(name: string, args: string) {
      const handler = commands.get(name);
      assert.ok(handler, `command ${name} not registered`);
      await handler(args, context);
    },
  };
}

/**
 * Stand-in for pi-streaming-guard: like the real patch it *replaces*
 * Markdown.prototype.render wholesale (never delegating to previously
 * installed wrappers) and restores the captured render when disposed.
 */
function installGuardFacsimile(stock: MarkdownRender) {
  const captured = Markdown.prototype.render as MarkdownRender;
  const render: MarkdownRender = function (width) {
    return stock.call(this, width);
  };
  Markdown.prototype.render = render;
  return {
    render,
    dispose() {
      if (Markdown.prototype.render === render) {
        Markdown.prototype.render = captured;
      }
    },
  };
}

test("pi-math re-arms on top of wholesale Markdown.render replacements", async () => {
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  setCellDimensions({ widthPx: 9, heightPx: 18 });
  const stockRender = Markdown.prototype.render as MarkdownRender;
  const harness = createHarness();
  const formula = String.raw`$$x^2+y^2=z^2$$`;
  const renderLines = () => new Markdown(formula, 0, 0, markdownTheme).render(80);

  await piMathExtension(harness.pi);
  const patchedRender = Markdown.prototype.render as MarkdownRender;
  assert.notEqual(patchedRender, stockRender);
  assert.equal(imageLineCount(renderLines()), 1);

  // Guard activates on session_start without chaining: pi-math is bypassed.
  const firstGuard = installGuardFacsimile(stockRender);
  assert.equal(imageLineCount(renderLines()), 0);

  // session_start handlers settle, then pi-math re-layers over the guard.
  await harness.fire("session_start");
  await nextMacrotask();
  await nextMacrotask();
  assert.equal(Markdown.prototype.render, patchedRender);
  assert.equal(imageLineCount(renderLines()), 1);

  // Guard churn that restores its captured render is a no-op for the layering.
  firstGuard.dispose();
  assert.equal(Markdown.prototype.render, patchedRender);
  assert.equal(imageLineCount(renderLines()), 1);

  // Mid-session "/streaming-guard on" replaces the prototype again.
  const secondGuard = installGuardFacsimile(stockRender);
  assert.equal(Markdown.prototype.render, secondGuard.render);
  assert.equal(imageLineCount(renderLines()), 0);

  // The next turn re-heals without waiting for a session restart.
  await harness.fire("turn_start");
  assert.equal(Markdown.prototype.render, patchedRender);
  assert.equal(imageLineCount(renderLines()), 1);

  // "/math-render off" must delegate cleanly to the render beneath pi-math.
  await harness.command("math-render", "off");
  assert.equal(imageLineCount(renderLines()), 0);
  await harness.command("math-render", "on");
  assert.equal(imageLineCount(renderLines()), 1);

  // Guard disposal restores pi-math's wrapper it captured.
  secondGuard.dispose();
  assert.equal(Markdown.prototype.render, patchedRender);

  // session_shutdown detaches pi-math; a stale guard render beneath resumes
  // plain Markdown output and turn hooks must not resurrect the wrapper.
  await harness.fire("session_shutdown");
  assert.equal(Markdown.prototype.render, secondGuard.render);
  assert.equal(imageLineCount(renderLines()), 0);
  await harness.fire("turn_start");
  await nextMacrotask();
  assert.equal(Markdown.prototype.render, secondGuard.render);

  setCapabilities({ images: null, trueColor: false, hyperlinks: false });
  Markdown.prototype.render = stockRender;
  assert.equal(Markdown.prototype.render, stockRender);
});
