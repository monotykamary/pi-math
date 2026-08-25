const HEX_COLOR_PATTERN = /^#[\da-f]{6}$/i;
const TRUECOLOR_PATTERN = /\x1b\[38;2;(\d+);(\d+);(\d+)m/;
const INDEXED_PATTERN = /\x1b\[38;5;(\d+)m/;
const BASIC_PATTERN = /\x1b\[(3[0-7]|9[0-7])m/;

const BUILTIN_DARK_TEXT = "#d4d4d4";
const BUILTIN_LIGHT_TEXT = "#1f2328";

/** Used when no Pi theme, component style, or override can be resolved. */
export const FALLBACK_TEXT_COLOR = BUILTIN_DARK_TEXT;

const PI_THEME_KEYS = [
  Symbol.for("@earendil-works/pi-coding-agent:theme"),
  Symbol.for("@mariozechner/pi-coding-agent:theme"),
];

const BASIC_PALETTE = [
  "#000000",
  "#800000",
  "#008000",
  "#808000",
  "#000080",
  "#800080",
  "#008080",
  "#c0c0c0",
  "#808080",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#0000ff",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
];

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

function clampComponent(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function rgbToHex(red: number, green: number, blue: number): string {
  return (
    "#" +
    [red, green, blue]
      .map((value) => clampComponent(value).toString(16).padStart(2, "0"))
      .join("")
  );
}

/** Map an xterm 256-palette index to its conventional RGB approximation. */
export function xtermPaletteHex(index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
  if (index < 16) return BASIC_PALETTE[index];
  if (index < 232) {
    const offset = index - 16;
    const red = Math.floor(offset / 36);
    const green = Math.floor(offset / 6) % 6;
    const blue = offset % 6;
    return rgbToHex(CUBE_LEVELS[red]!, CUBE_LEVELS[green]!, CUBE_LEVELS[blue]!);
  }
  const gray = 8 + (index - 232) * 10;
  return rgbToHex(gray, gray, gray);
}

/**
 * Extract the first SGR foreground color from a styled string.
 * Supports truecolor (38;2;r;g;b), 256-color (38;5;n), and basic 30-37/90-97
 * escapes. Returns undefined for default-foreground (39) or unstyled text.
 */
export function ansiForegroundHex(styled: string): string | undefined {
  const trueColor = TRUECOLOR_PATTERN.exec(styled);
  if (trueColor) {
    return rgbToHex(Number(trueColor[1]), Number(trueColor[2]), Number(trueColor[3]));
  }
  const indexed = INDEXED_PATTERN.exec(styled);
  if (indexed) return xtermPaletteHex(Number(indexed[1]));
  const basic = BASIC_PATTERN.exec(styled);
  if (basic) {
    const code = Number(basic[1]);
    return xtermPaletteHex(code >= 90 ? code - 90 + 8 : code - 30);
  }
  return undefined;
}

interface InteractiveThemeLike {
  name?: unknown;
  fg?: unknown;
  getFgAnsi?: unknown;
}

function interactiveTheme(): InteractiveThemeLike | undefined {
  const host = globalThis as unknown as Record<symbol, unknown>;
  for (const key of PI_THEME_KEYS) {
    const theme = host[key];
    if (theme && typeof theme === "object") return theme as InteractiveThemeLike;
  }
  return undefined;
}

/**
 * Built-in themes name themselves "dark" and "light"; use the name when the
 * text token resolves to the terminal's default foreground, which has no
 * inspectable RGB value.
 */
function themeNameFallback(theme: InteractiveThemeLike): string | undefined {
  if (typeof theme.name !== "string") return undefined;
  if (/light/i.test(theme.name)) return BUILTIN_LIGHT_TEXT;
  if (/dark/i.test(theme.name)) return BUILTIN_DARK_TEXT;
  return undefined;
}

/** Resolve the `text` token of Pi's active interactive theme to a hex color. */
export function themeTextHex(): string | undefined {
  const theme = interactiveTheme();
  if (!theme) return undefined;

  let styled: unknown;
  try {
    if (typeof theme.getFgAnsi === "function") {
      styled = (theme.getFgAnsi as (token: string) => string).call(theme, "text");
    } else if (typeof theme.fg === "function") {
      styled = (theme.fg as (token: string, text: string) => string).call(theme, "text", "x");
    }
  } catch {
    return themeNameFallback(theme);
  }
  const hex = typeof styled === "string" ? ansiForegroundHex(styled) : undefined;
  return hex ?? themeNameFallback(theme);
}

export interface FormulaColorSources {
  /** Styled-text sampler such as Markdown's defaultTextStyle.color. */
  sampleStyle?: (text: string) => string;
  environment?: NodeJS.ProcessEnv;
}

/**
 * Resolve the ink color used for formula rasters so rendered math matches the
 * text Pi draws around it:
 *
 * 1. PI_MATH_COLOR, an explicit #rrggbb override;
 * 2. the component's own default text color (e.g. thinking-block text);
 * 3. the active Pi theme's `text` token (light and dark themes included);
 * 4. a scheme-aware default for terminal-default theme text;
 * 5. Pi's built-in dark theme text color.
 */
export function resolveFormulaColor(sources: FormulaColorSources = {}): string {
  const environment = sources.environment ?? process.env;
  const override = environment.PI_MATH_COLOR;
  if (override && HEX_COLOR_PATTERN.test(override)) return override.toLowerCase();

  let styled: unknown;
  try {
    styled = sources.sampleStyle?.("x");
  } catch {
    styled = undefined;
  }
  const styledHex = typeof styled === "string" ? ansiForegroundHex(styled) : undefined;
  if (styledHex) return styledHex;

  return themeTextHex() ?? FALLBACK_TEXT_COLOR;
}
