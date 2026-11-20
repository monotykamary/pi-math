import {
  Markdown,
  allocateImageId,
  getCapabilities,
  getCellDimensions,
  type DefaultTextStyle,
  type MarkdownOptions,
} from "@earendil-works/pi-tui";
import { insertFormulaImages, type FormulaImagePlacement } from "./image-layout.js";
import type { TerminalMathRenderer } from "./renderer.js";
import { resolveFormulaColor } from "./text-color.js";
import {
  containsPotentialMath,
  expandMathInMarkdown,
  stripGeneratedMathFenceLines,
} from "./transform.js";

const MAX_RASTER_HEIGHT_PX = 4096;

type MarkdownInternals = {
  text: string;
  paddingX?: number;
  defaultTextStyle?: DefaultTextStyle;
  options?: MarkdownOptions;
};

type MarkdownRender = (this: Markdown, width: number) => readonly string[];

interface CachedTransform {
  source: string;
  layoutKey: string;
  transformed: string;
  placements: FormulaImagePlacement[];
}

// Pi recreates Markdown instances for every streamed delta. Keep completed formula IDs
// stable across append-only replacements so unchanged lines stay byte-identical to the TUI.
interface TransformLineage {
  imageIds: Map<string, number>;
  layoutKey: string;
  lastUsed: number;
  source: string;
}

const MAX_TRANSFORM_LINEAGES = 32;

export interface MathPatchController {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  clearTransformCache(): void;
  /**
   * Re-assert the wrapper as the outermost Markdown.render. Other extensions
   * may replace the prototype method wholesale instead of chaining (notably
   * pi-streaming-guard, which activates on session_start and can be toggled
   * mid-session); rearm() adopts the current render as the delegation target.
   */
  rearm(): void;
  uninstall(): void;
}

function formulaColor(markdown: MarkdownInternals): string {
  return resolveFormulaColor({ sampleStyle: markdown.defaultTextStyle?.color });
}

function imageMarker(
  imageId: number,
  index: number,
  columns: number,
  inline: boolean,
): string {
  if (!inline) return `__PI_MATH_IMAGE_${imageId}_${index}__`;
  const privateUseCharacter = String.fromCodePoint(0xe000 + (index % 0x1900));
  return privateUseCharacter.repeat(columns);
}

function allocateMathImageId(): number {
  return (allocateImageId() & 0xffffff) || 1;
}

function formulaIdentity(
  latex: string,
  display: boolean,
  context: { start: number; end: number },
): string {
  return JSON.stringify([context.start, context.end, display, latex]);
}

function matchingLineage(
  lineages: TransformLineage[],
  source: string,
  layoutKey: string,
): TransformLineage | undefined {
  let match: TransformLineage | undefined;
  for (const candidate of lineages) {
    if (candidate.layoutKey !== layoutKey || !source.startsWith(candidate.source)) continue;
    if (!match || candidate.source.length > match.source.length) match = candidate;
  }
  return match;
}

/**
 * Install a reversible display-only wrapper around Pi's Markdown renderer.
 * The source Markdown is restored before render() returns, so session history
 * and provider context always retain the original LaTeX.
 */
export function installMarkdownMathPatch(renderer: TerminalMathRenderer): MathPatchController {
  const baseRender = Markdown.prototype.render;
  let enabled = true;
  let installed = true;
  let transformCache = new WeakMap<Markdown, CachedTransform>();
  let transformLineages: TransformLineage[] = [];
  let lineageUsage = 0;

  const renderMath = function (this: Markdown, width: number, delegate: MarkdownRender): readonly string[] {
    const markdown = this as unknown as MarkdownInternals;
    const source = markdown.text;
    const protocol = getCapabilities().images;
    // Pi marks its transient reasoning component with a whole-block italic style.
    // Rasterizing it on every token floods Kitty and leaves no durable output to preserve.
    const isTransientReasoning = markdown.defaultTextStyle?.italic === true;
    if (
      !enabled ||
      !protocol ||
      typeof source !== "string" ||
      isTransientReasoning ||
      !containsPotentialMath(source)
    ) {
      return delegate.call(this, width);
    }

    const paddingX =
      typeof markdown.paddingX === "number" && Number.isFinite(markdown.paddingX)
        ? Math.max(0, markdown.paddingX)
        : 0;
    const color = formulaColor(markdown);
    const cells = getCellDimensions();
    const contentWidth = Math.max(1, width - paddingX * 2);
    const layoutKey = `${width}:${paddingX}:${color}:${protocol}:${cells.widthPx}:${cells.heightPx}`;
    const maxBlockRows = Math.max(1, Math.floor(MAX_RASTER_HEIGHT_PX / cells.heightPx));

    let transformed: string;
    let placements: FormulaImagePlacement[];
    const cached = transformCache.get(this);
    if (cached?.source === source && cached.layoutKey === layoutKey) {
      ({ transformed, placements } = cached);
    } else {
      placements = [];
      const lineage = matchingLineage(transformLineages, source, layoutKey);
      const imageIds = new Map<string, number>();
      transformed = expandMathInMarkdown(source, (latex, display, context) => {
        const inline = !display && !context.standalone;
        if (inline && protocol !== "kitty") return undefined;

        const raster = renderer.render(latex, display, color, {
          maxWidthCells: contentWidth,
          maxHeightCells: inline ? 1 : maxBlockRows,
          cellWidthPx: cells.widthPx,
          cellHeightPx: cells.heightPx,
          fitHeight: inline,
        });
        if (!raster) return undefined;

        const identity = formulaIdentity(latex, display, context);
        const imageId = lineage?.imageIds.get(identity) ?? allocateMathImageId();
        imageIds.set(identity, imageId);
        const marker = imageMarker(imageId, placements.length, raster.columns, inline);
        placements.push({
          marker,
          imageId,
          raster,
          inline,
          fallbackText: source.slice(context.start, context.end),
        });
        return { text: marker, forceBlock: !inline, rawInline: inline };
      });
      if (imageIds.size > 0) {
        const nextUsage = ++lineageUsage;
        if (lineage) {
          lineage.imageIds = imageIds;
          lineage.lastUsed = nextUsage;
          lineage.source = source;
        } else {
          transformLineages.push({ imageIds, layoutKey, lastUsed: nextUsage, source });
        }
        if (transformLineages.length > MAX_TRANSFORM_LINEAGES) {
          transformLineages.sort((left, right) => right.lastUsed - left.lastUsed);
          transformLineages = transformLineages.slice(0, MAX_TRANSFORM_LINEAGES);
        }
      }
      transformCache.set(this, { source, layoutKey, transformed, placements });
    }

    if (transformed === source || placements.length === 0) {
      return delegate.call(this, width);
    }

    markdown.text = transformed;
    try {
      const textLines = stripGeneratedMathFenceLines(delegate.call(this, width));
      return insertFormulaImages(textLines, placements, { renderWidth: width, paddingX });
    } finally {
      markdown.text = source;
    }
  };

  // Pi 0.99 applies native Markdown transformers inside render(). Run that
  // text-only stage before rasterization, once, then insert images after layout.
  // It cannot replace this hook: it has no access to final terminal rows.
  const rendering = new WeakSet<Markdown>();
  const delegates = new WeakMap<MarkdownRender, MarkdownRender>();
  const wrap = (delegate: MarkdownRender): MarkdownRender => {
    const wrapped: MarkdownRender = function (width) {
      // Each generation keeps its own delegate. A cooperative wrapper can retain
      // an older generation without cycles or bypassing the renderer beneath it.
      if (rendering.has(this)) return delegate.call(this, width);
      rendering.add(this);
      const markdown = this as unknown as MarkdownInternals;
      const source = markdown.text;
      const options = markdown.options;
      try {
        if (enabled && getCapabilities().images &&
            markdown.defaultTextStyle?.italic !== true && options?.transform) {
          const contentWidth = Math.max(1, width - (markdown.paddingX ?? 0) * 2);
          markdown.text = options.transform(source, contentWidth);
          markdown.options = { ...options, transform: undefined };
        }
        return renderMath.call(this, width, delegate);
      } finally {
        markdown.text = source;
        markdown.options = options;
        rendering.delete(this);
      }
    };
    delegates.set(wrapped, delegate);
    return wrapped;
  };
  let patchedRender = wrap(baseRender);
  Markdown.prototype.render = patchedRender;
  return {
    isEnabled: () => enabled,
    setEnabled(value: boolean) {
      enabled = value;
    },
    clearTransformCache() {
      transformCache = new WeakMap();
      transformLineages = [];
      lineageUsage = 0;
    },
    rearm() {
      if (!installed || delegates.has(Markdown.prototype.render)) return;
      patchedRender = wrap(Markdown.prototype.render);
      Markdown.prototype.render = patchedRender;
    },
    uninstall() {
      enabled = false;
      transformCache = new WeakMap();
      transformLineages = [];
      lineageUsage = 0;
      const delegate = delegates.get(Markdown.prototype.render);
      if (installed && delegate) Markdown.prototype.render = delegate;
      // Older generations retained by other extensions now pass through to
      // their own delegates; never overwrite a renderer owned by someone else.
      installed = false;
    },
  };
}
