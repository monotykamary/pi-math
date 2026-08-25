import {
  Markdown,
  allocateImageId,
  getCapabilities,
  getCellDimensions,
  type DefaultTextStyle,
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
};

type MarkdownRender = (this: Markdown, width: number) => string[];

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
  let nestedRender: MarkdownRender = baseRender;
  let enabled = true;
  let installed = true;
  let transformCache = new WeakMap<Markdown, CachedTransform>();
  let transformLineages: TransformLineage[] = [];
  let lineageUsage = 0;

  // One stable function identity delegates through a mutable target so rearm()
  // can re-layer the wrapper over renders installed later without growing the
  // call chain — and so disabled/uninstalled wrappers degrade to pass-through.
  const patchedRender: MarkdownRender = function (width: number): string[] {
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
      return nestedRender.call(this, width);
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
      return nestedRender.call(this, width);
    }

    markdown.text = transformed;
    try {
      const textLines = stripGeneratedMathFenceLines(nestedRender.call(this, width));
      return insertFormulaImages(textLines, placements, { renderWidth: width, paddingX });
    } finally {
      markdown.text = source;
    }
  };

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
      if (!installed || Markdown.prototype.render === patchedRender) return;
      nestedRender = Markdown.prototype.render as MarkdownRender;
      Markdown.prototype.render = patchedRender;
    },
    uninstall() {
      enabled = false;
      transformCache = new WeakMap();
      transformLineages = [];
      lineageUsage = 0;
      if (installed && Markdown.prototype.render === patchedRender) {
        Markdown.prototype.render = nestedRender;
      }
      // A wholesale replacement installed after this patch may still hold the
      // patched function; once that replacement unwinds, the disabled wrapper
      // must pass through to the render captured before this patch existed.
      nestedRender = baseRender;
      installed = false;
    },
  };
}
