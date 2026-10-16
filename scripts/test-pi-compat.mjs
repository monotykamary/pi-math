import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const kind = manifest.name.includes("streaming") ? "streaming" : manifest.name.includes("pi-math") ? "math" : manifest.name.includes("localterm") ? "localterm" : "warp";
const entry = join(root, kind === "math" || kind === "streaming" ? "src/index.ts" : "extensions/index.ts");
const host = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const home = await mkdtemp(join(tmpdir(), "pi1-render-probe-"));
try {
  const probe = join(home, "probe.ts");
  await writeFile(probe, `
import assert from "node:assert/strict";
import extension from ${JSON.stringify(entry)};
import { VERSION, initTheme, getMarkdownTheme, AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth, getCapabilities, setCapabilities, setCapabilityOverrides, resetCapabilitiesCache, setCellDimensions } from "@earendil-works/pi-tui";
const kind = ${JSON.stringify(kind)};
export default async function(pi) {
  assert.equal(VERSION, "1.3.0");
  const stock = Markdown.prototype.render;
  const stockUpdate = AssistantMessageComponent.prototype.updateContent;
  const handlers = new Map();
  await extension({ ...pi, on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); } });
  assert.equal(Markdown.prototype.render, stock, "discovery must not patch host");
  pi.registerCommand("pi1-render-probe", { description: "Offline renderer identity probe", async handler(_args, ctx) {
    const fire = async (name, mode = "tui") => { for (const handler of handlers.get(name) ?? []) await handler({}, { ...ctx, mode }); };
    initTheme("dark", false);
    for (const mode of ["rpc", "json", "print"]) {
      await fire("session_start", mode);
      assert.equal(Markdown.prototype.render, stock);
      await fire("session_shutdown", mode);
    }
    setCapabilityOverrides({}); resetCapabilitiesCache();
    const before = getCapabilities();
    const sample = "## 界 🙂\\n\\n**bold** and $x^2 + y^2$";
    const expected = new Markdown(sample, 1, 0, getMarkdownTheme()).render(37);
    try {
      for (let generation = 0; generation < 2; generation++) {
        if (kind === "math") { setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true }); setCellDimensions({ widthPx: 8, heightPx: 16 }); }
        await fire("session_start");
        await new Promise(resolve => setImmediate(resolve));
        if (kind === "streaming") {
          assert.notEqual(Markdown.prototype.render, stock, "must patch the actual CLI Markdown class");
          assert.notEqual(AssistantMessageComponent.prototype.updateContent, stockUpdate);
          assert.deepEqual(new Markdown(sample, 1, 0, getMarkdownTheme()).render(37), expected);
        } else if (kind === "math") {
          assert.notEqual(Markdown.prototype.render, stock, "must patch the actual CLI Markdown class");
          const lines = new Markdown("$$x^2$$", 0, 0, getMarkdownTheme()).render(60);
          assert.ok(lines.some(line => line.includes("\\u001b_G")), "must rasterize through the active CLI host");
          const inlineSource = "界 🙂 $x^2$ and $y^2$.";
          const inline = new Markdown(inlineSource, 1, 0, getMarkdownTheme());
          for (const width of [20, 37, 60]) {
            const rendered = inline.render(width);
            assert.equal(rendered.join("\\n").match(/\\u001b_Ga=T,/gu)?.length, 2);
            assert.ok(rendered.every(line => visibleWidth(line) <= width), "inline images must fit the actual host width");
            assert.doesNotMatch(rendered.join("\\n"), /\\$[xy]/u);
            assert.equal(inline.text, inlineSource, "inline rendering must preserve source");
            assert.deepEqual(inline.render(width), rendered, "inline images must remain byte-stable");
          }
        } else {
          assert.equal(getCapabilities().images, "kitty");
          assert.equal(Markdown.prototype.render, stock);
        }
        await fire("session_shutdown");
        await fire("session_shutdown");
        assert.equal(Markdown.prototype.render, stock);
        assert.equal(AssistantMessageComponent.prototype.updateContent, stockUpdate);
        if (kind === "localterm") assert.equal(getCapabilities(), before);
      }
      console.log("PI1_RENDER_PROBE_OK " + kind);
    } finally { await fire("session_shutdown"); }
  }});
}
`);
  for (const cli of ["cli.js", "bundle/cli.js"]) {
    // An allowlisted environment cannot reach live credentials. No terminal UI
    // is started: the command invokes lifecycle hooks with offscreen components.
    const env = { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: home, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", TERM: "xterm-256color", TERM_PROGRAM: kind === "warp" ? "WarpTerminal" : "localterm", LOCALTERM: kind === "localterm" ? "1" : "0", trueTERM: "1" };
    const result = spawnSync(process.execPath, [join(host, cli), "--offline", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "-e", probe, "--print", "/pi1-render-probe"], { cwd: home, env, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(result.status, 0, `${cli}: ${result.error ?? ""}\n${result.stderr}\n${result.stdout}`);
    assert.ok((result.stdout + result.stderr).includes("PI1_RENDER_PROBE_OK"), `${cli}: probe did not complete\n${result.stderr}\n${result.stdout}`);
    console.log(`${manifest.name}: Pi 1.3 ${cli} host identity, offscreen rendering, non-TUI guards, repeated shutdown and restart passed`);
  }
} finally {
  await rm(home, { recursive: true, force: true });
}
