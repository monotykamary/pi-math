import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MathPatchController } from "./markdown-patch.js";
import type { TerminalMathRenderer } from "./renderer.js";

interface MathUi {
  renderer: TerminalMathRenderer;
  installMarkdownMathPatch: typeof import("./markdown-patch.js").installMarkdownMathPatch;
  getCapabilities: typeof import("@earendil-works/pi-tui").getCapabilities;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export default function piMathExtension(pi: ExtensionAPI): void {
  let loading: Promise<MathUi | undefined> | undefined;
  let active: MathUi | undefined;
  let loadFailure: string | undefined;
  let patch: MathPatchController | undefined;
  let rearm: ReturnType<typeof setImmediate> | undefined;
  let generation = 0;

  const loadUi = () => loading ??= Promise.all([
    import("./renderer.js"),
    import("./config.js"),
    import("./markdown-patch.js"),
    import("@earendil-works/pi-tui"),
  ]).then(async ([renderer, config, markdown, tui]) => ({
    renderer: await renderer.createTerminalMathRenderer(config.loadSvgMathRendererOptions()),
    installMarkdownMathPatch: markdown.installMarkdownMathPatch,
    getCapabilities: tui.getCapabilities,
  })).catch((error: unknown) => {
    loadFailure = errorMessage(error);
    return undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    const current = ++generation;
    // RPC and print workers keep the extension registered without loading the
    // renderer and Markdown patch graph. The engines still wait for a formula.
    if (ctx.mode !== "tui") return;
    const ui = await loadUi();
    if (generation !== current) return;
    if (!ui) {
      ctx.ui.notify(`pi-math failed to load: ${loadFailure}`, "error");
      return;
    }
    active = ui;
    patch ??= ui.installMarkdownMathPatch(ui.renderer);
    // pi-streaming-guard can replace Markdown.render in its session_start.
    // Re-layer over whichever renderer is installed after the handlers run.
    if (rearm) clearImmediate(rearm);
    rearm = setImmediate(() => { rearm = undefined; patch?.rearm(); });
  });

  // Re-assert the wrapper each turn: a mid-session "/streaming-guard on" (or
  // any wholesale re-patch) replaces Markdown.render between turns.
  pi.on("turn_start", () => {
    patch?.rearm();
  });

  pi.on("session_shutdown", () => {
    generation++;
    if (rearm) clearImmediate(rearm);
    rearm = undefined;
    patch?.uninstall();
    patch = undefined;
    active?.renderer.clear();
    active = undefined;
  });

  pi.registerCommand("math-render", {
    description: "Control terminal LaTeX image rendering: on, off, status, or clear",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status";
      if (!patch || !active) {
        ctx.ui.notify(`pi-math is unavailable: ${loadFailure ?? "renderer did not load"}`, "error");
        return;
      }
      const { renderer, getCapabilities } = active;
      if (action === "on" || action === "enable") {
        patch.setEnabled(true);
        ctx.ui.notify("pi-math enabled", "info");
        return;
      }
      if (action === "off" || action === "disable") {
        patch.setEnabled(false);
        ctx.ui.notify("pi-math disabled", "info");
        return;
      }
      if (action === "clear") {
        renderer.clear();
        patch.clearTransformCache();
        ctx.ui.notify("pi-math render caches cleared", "info");
        return;
      }
      if (action === "status") {
        const status = patch.isEnabled() ? "enabled" : "disabled";
        const protocol = getCapabilities().images ?? "unsupported terminal";
        const lastFailure = renderer.lastFailure ? `, last failure: ${renderer.lastFailure.code}` : "";
        ctx.ui.notify(
          `pi-math is ${status} (${protocol}, ${renderer.cacheSize} rasters, ${formatBytes(renderer.cacheBytes)}${lastFailure})`,
          "info",
        );
        return;
      }
      ctx.ui.notify("Usage: /math-render on|off|status|clear", "warning");
    },
  });
}
