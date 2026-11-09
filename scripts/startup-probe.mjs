import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const lazy = process.argv.includes('--assert-lazy');
const count = () => Object.keys(require.cache).filter(p => /\/(?:mathjax-full|@resvg)\//.test(p)).length;
const start = performance.now();
const { default: extension } = await import('../src/index.ts');
const imported = performance.now();
const hooks = new Map();
const commands = new Map();
await extension({ on: (name, fn) => hooks.set(name, fn), registerCommand: (name, command) => commands.set(name, command) });
const discovered = performance.now();
const { Markdown, setCapabilities, setCellDimensions } = await import('@earendil-works/pi-tui');
const identity = x => x;
const theme = Object.fromEntries(['heading','link','linkUrl','code','codeBlock','codeBlockBorder','quote','quoteBorder','hr','listBullet','bold','italic','strikethrough','underline'].map(k => [k, identity]));
const ctx = { mode: 'tui', ui: { notify() {} } };
const stock = Markdown.prototype.render;
setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
setCellDimensions({ widthPx: 8, heightPx: 16 });
try {
  for (const mode of ['rpc', 'json', 'print']) {
    await hooks.get('session_start')({}, { ...ctx, mode });
    await hooks.get('session_shutdown')({}, { ...ctx, mode });
  }
  await hooks.get('session_start')({}, ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(new Markdown('ordinary text', 0, 0, theme).render(60).length);
  for (const action of ['status', 'clear', 'off', 'on']) await commands.get('math-render').handler(action, ctx);
  const idleModules = count();
  if (lazy) assert.equal(idleModules, 0, 'discovery, non-TUI, text-only TUI and commands must not load engines');
  const firstStart = performance.now();
  const component = new Markdown('$$x^2$$', 0, 0, theme);
  const lines = component.render(60);
  const firstMs = performance.now() - firstStart;
  assert.ok(Array.isArray(lines), 'render remains synchronous');
  assert.ok(lines.some(line => line.includes('\x1b_G')), 'first formula must rasterize');
  assert.deepEqual(component.render(60), lines);
  const afterModules = count();
  assert.ok(afterModules > 0);
  console.log(JSON.stringify({ importMs: imported-start, discoveryMs: discovered-start, idleModules, firstMs, afterModules }));
} finally {
  await hooks.get('session_shutdown')({}, ctx);
  assert.equal(Markdown.prototype.render, stock);
}
