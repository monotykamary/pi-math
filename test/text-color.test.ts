import assert from "node:assert/strict";
import test from "node:test";
import {
  ansiForegroundHex,
  FALLBACK_TEXT_COLOR,
  resolveFormulaColor,
  themeTextHex,
  xtermPaletteHex,
} from "../src/text-color.js";

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const THEME_KEY_OLD = Symbol.for("@mariozechner/pi-coding-agent:theme");

type GlobalWithTheme = typeof globalThis & Record<symbol, unknown>;

function setGlobalTheme(theme: unknown): () => void {
  const host = globalThis as GlobalWithTheme;
  const previous = host[THEME_KEY];
  const previousOld = host[THEME_KEY_OLD];
  host[THEME_KEY] = theme;
  delete host[THEME_KEY_OLD];
  return () => {
    if (previous === undefined) delete host[THEME_KEY];
    else host[THEME_KEY] = previous;
    if (previousOld === undefined) delete host[THEME_KEY_OLD];
    else host[THEME_KEY_OLD] = previousOld;
  };
}

function themed(token: string): string {
  return `\x1b[38;2;1;2;3m${token}\x1b[39m`;
}

test("extracts hex colors from truecolor, indexed, and basic SGR text", () => {
  assert.equal(ansiForegroundHex(themed("x")), "#010203");
  assert.equal(ansiForegroundHex("\x1b[38;2;212;212;212mx\x1b[39m"), "#d4d4d4");
  assert.equal(ansiForegroundHex("\x1b[38;5;196mx\x1b[39m"), "#ff0000");
  assert.equal(ansiForegroundHex("\x1b[38;5;242m"), "#6c6c6c");
  assert.equal(ansiForegroundHex("\x1b[34mx"), "#000080");
  assert.equal(ansiForegroundHex("\x1b[91mx"), "#ff0000");
  assert.equal(ansiForegroundHex("\x1b[39mx\x1b[39m"), undefined);
  assert.equal(ansiForegroundHex("plain text"), undefined);
  assert.equal(ansiForegroundHex(""), undefined);
});

test("maps xterm palette indices across all ranges", () => {
  assert.equal(xtermPaletteHex(0), "#000000");
  assert.equal(xtermPaletteHex(7), "#c0c0c0");
  assert.equal(xtermPaletteHex(8), "#808080");
  assert.equal(xtermPaletteHex(15), "#ffffff");
  assert.equal(xtermPaletteHex(16), "#000000");
  assert.equal(xtermPaletteHex(46), "#00ff00");
  assert.equal(xtermPaletteHex(231), "#ffffff");
  assert.equal(xtermPaletteHex(232), "#080808");
  assert.equal(xtermPaletteHex(255), "#eeeeee");
  assert.equal(xtermPaletteHex(-1), undefined);
  assert.equal(xtermPaletteHex(256), undefined);
  assert.equal(xtermPaletteHex(12.5), undefined);
});

test("resolves the dark and light theme text tokens", () => {
  const restoreDark = setGlobalTheme({
    name: "dark",
    getFgAnsi: (token: string) => {
      if (token === "text") return "\x1b[38;2;212;212;212m";
      throw new Error(`Unknown theme color: ${token}`);
    },
  });
  try {
    assert.equal(themeTextHex(), "#d4d4d4");
  } finally {
    restoreDark();
  }

  const restoreLight = setGlobalTheme({
    name: "light",
    getFgAnsi: (token: string) => {
      if (token === "text") return "\x1b[38;2;31;35;40m";
      throw new Error(`Unknown theme color: ${token}`);
    },
  });
  try {
    assert.equal(themeTextHex(), "#1f2328");
  } finally {
    restoreLight();
  }
});

test("falls back through fg() when getFgAnsi is unavailable", () => {
  const restore = setGlobalTheme({
    name: "dark",
    fg: (token: string, text: string) => `\x1b[38;2;212;212;212m${text}\x1b[39m`,
  });
  try {
    assert.equal(themeTextHex(), "#d4d4d4");
  } finally {
    restore();
  }
});

test("uses a scheme-aware default when theme text is the terminal default", () => {
  const restoreLight = setGlobalTheme({
    name: "light",
    getFgAnsi: () => "\x1b[39m",
  });
  try {
    assert.equal(themeTextHex(), "#1f2328");
  } finally {
    restoreLight();
  }

  const restoreDark = setGlobalTheme({
    name: "dark",
    getFgAnsi: () => "\x1b[39m",
  });
  try {
    assert.equal(themeTextHex(), "#d4d4d4");
  } finally {
    restoreDark();
  }

  const restoreCustom = setGlobalTheme({
    name: "solarized-splash",
    getFgAnsi: () => "\x1b[39m",
  });
  try {
    assert.equal(themeTextHex(), undefined);
  } finally {
    restoreCustom();
  }
});

test("theme text resolution is undefined without a global theme", () => {
  const restore = setGlobalTheme(undefined);
  try {
    assert.equal(themeTextHex(), undefined);
  } finally {
    restore();
  }
});

test("resolveFormulaColor priorities: override, component style, theme, fallback", () => {
  const restoreTheme = setGlobalTheme({
    name: "dark",
    getFgAnsi: () => "\x1b[38;2;212;212;212m",
  });
  const restoreNoOverride = setGlobalTheme(undefined);
  restoreNoOverride();
  try {
    assert.equal(
      resolveFormulaColor({ environment: { PI_MATH_COLOR: "#A0b1C2" as string | undefined } }),
      "#a0b1c2",
    );
    assert.equal(
      resolveFormulaColor({
        sampleStyle: (text) => `\x1b[38;2;128;128;128m${text}\x1b[39m`,
        environment: {},
      }),
      "#808080",
    );
    const restoreDark = setGlobalTheme({
      name: "dark",
      getFgAnsi: () => "\x1b[38;2;212;212;212m",
    });
    try {
      assert.equal(resolveFormulaColor({ environment: {} }), "#d4d4d4");
      assert.equal(
        resolveFormulaColor({
          sampleStyle: () => {
            throw new Error("style unavailable");
          },
          environment: {},
        }),
        "#d4d4d4",
      );
    } finally {
      restoreDark();
    }
    const restoreNone = setGlobalTheme(undefined);
    try {
      assert.equal(resolveFormulaColor({ environment: {} }), FALLBACK_TEXT_COLOR);
      assert.equal(resolveFormulaColor({ environment: { PI_MATH_COLOR: "not-hex" } }), FALLBACK_TEXT_COLOR);
    } finally {
      restoreNone();
    }
  } finally {
    restoreTheme();
  }
});
