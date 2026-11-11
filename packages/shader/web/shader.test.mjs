import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { WAVE_SOURCE, UNIFORMS, distance, picture, reference } from "../test/fixture.mjs";
import { png } from "../test/png.mjs";
import { parse, placement, toGLSL } from "./sksl.js";

setDefaultTimeout(60_000);
const here = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chrome = existsSync(CHROME);

test("the declarations of the ripple's source are its two images and seven values, in order", () => {
  const d = parse(WAVE_SOURCE);
  expect(d.shaders).toEqual(["image", "huddle"]);
  expect(d.floats).toEqual([["label", 1], ["band", 1], ["amp", 1], ["spread", 1], ["center", 2], ["radius", 1], ["power", 1]].map(([name, size]) => ({ name, size })));
});

test("the GLSL has no SkSL type, no eval call and renames main", () => {
  const glsl = toGLSL(WAVE_SOURCE);
  expect(glsl).not.toMatch(/\b(half\d?|float[234]|uniform shader)\b|\.eval\(/);
  expect(glsl).toContain("vec4 exact_main(vec2 p)");
  expect(glsl).toContain("image_eval(p + sr).r");
  expect(glsl).toContain("uniform vec2 center;");
});

test("comments are not declarations, and a declaration with two names is refused", () => {
  expect(parse("// uniform float ghost;\n/* uniform shader other; */\nuniform float a;\nhalf4 main(float2 p) { return half4(a); }").floats).toEqual([{ name: "a", size: 1 }]);
  expect(() => parse("uniform float a, b;\nhalf4 main(float2 p) { return half4(1.0); }")).toThrow("one to a line");
  expect(() => parse("uniform int a;\nhalf4 main(float2 p) { return half4(1.0); }")).toThrow("`a` has type `int`");
  expect(() => parse("uniform float a;\nuniform float2 a;\nhalf4 main(float2 p) { return half4(1.0); }")).toThrow("declared twice");
  expect(() => parse("half4 shade(float2 p) { return half4(1.0); }")).toThrow("half4 main(float2 p)");
});

test("an image fills the box by cover, contain or fill", () => {
  const near = (a, b) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9));
  near(placement("cover", [420, 912], [100, 100]), [1 / 912, 1 / 912, -(420 - 912) / 2 / 912, 0]);
  near(placement("contain", [420, 912], [100, 100]), [1 / 420, 1 / 420, 0, -(912 - 420) / 2 / 420]);
  near(placement("fill", [420, 912], [100, 100]), [1 / 420, 1 / 912, 0, 0]);
});

let server, browser;
const images = new Map();
beforeAll(async () => {
  if (!chrome) return;
  const page = `<!doctype html><html><body style="margin:0"><div id="host" style="position:relative"></div><script type="module">
    import { roster, implementation } from "/web/index.js";
    window.events = [];
    window.start = (props, box, assets) => {
      const host = document.getElementById("host");
      host.style.width = box[0] + "px"; host.style.height = box[1] + "px";
      const impl = implementation({ asset: async path => assets.includes(path) ? new Uint8Array(await (await fetch("/png/" + path)).arrayBuffer()) : null });
      const events = { emit: (name, args) => window.events.push([name, args]), load: () => window.events.push(["load", []]) };
      window.shader = new roster["exact-shader"].view({ implementation: impl, element: host, props, events, view: 1 });
    };
    window.ready = () => window.shader.renderer && window.shader.drawn > 0 && window.shader.renderer.gl.finish() === undefined;
    window.read = () => {
      const gl = window.shader.renderer.gl, w = gl.canvas.width, h = gl.canvas.height, px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let s = ""; for (let i = 0; i < px.length; i += 8192) s += String.fromCharCode(...px.subarray(i, i + 8192));
      return { w, h, data: btoa(s), draws: window.shader.drawn };
    };
  </script></body></html>`;
  server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/") return new Response(page, { headers: { "content-type": "text/html" } });
      if (url.pathname.startsWith("/web/")) return new Response(Bun.file(resolve(here, url.pathname.slice(5))), { headers: { "content-type": "text/javascript" } });
      const name = url.pathname.replace(/^\/(png\/)?/, "");
      return images.has(name) ? new Response(images.get(name), { headers: { "content-type": "image/png" } }) : new Response("no", { status: 404 });
    },
  });
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
afterAll(async () => { await browser?.close(); server?.stop(true); });

const flip = (px, w, h) => { const out = new Uint8Array(px.length); for (let y = 0; y < h; y++) out.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4); return out; };

async function open({ box, scale, props }) {
  const context = await browser.newContext({ deviceScaleFactor: scale, viewport: { width: Math.ceil(box[0]), height: Math.ceil(box[1]) } });
  const page = await context.newPage();
  page.on("pageerror", e => { throw e; });
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.evaluate(([p, b]) => window.start(p, b, ["home-empty.png"]), [props, box]);
  return { page, context };
}
const pixels = async (page, after = 0) => {
  await page.waitForFunction(n => window.ready?.() && window.shader.drawn > n, after, { timeout: 8000 }).catch(async e => { throw new Error(`no draw; events ${JSON.stringify(await events(page))}`); });
  const r = await page.evaluate(() => window.read());
  return { ...r, rgba: flip(Uint8Array.from(Buffer.from(r.data, "base64")), r.w, r.h) };
};
const events = page => page.evaluate(() => window.events);

const pics = { image: { w: 105, h: 228, data: picture(105, 228, 1) }, huddle: { w: 105, h: 228, data: picture(105, 228, 4) } };
const ripple = (u, extra = {}) => ({
  source: WAVE_SOURCE,
  images: JSON.stringify([{ name: "image", source: "home-empty.png", sizing: "cover", tile: "decal" }, { name: "huddle", source: "home-huddle.png", sizing: "cover", tile: "decal" }]),
  uniforms: JSON.stringify(Object.entries(u).map(([name, value]) => ({ name, value: [].concat(value) }))),
  ...extra,
});
const setup = () => { images.set("home-empty.png", png(105, 228, pics.image.data)); images.set("home-huddle.png", png(105, 228, pics.huddle.data)); };

test.skipIf(!chrome)("the web view draws the home ripple as its equations say", async () => {
  setup();
  const { page, context } = await open({ box: [420, 912], scale: 1, props: ripple(UNIFORMS) });
  const got = await pixels(page);
  expect([got.w, got.h]).toEqual([420, 912]);
  const d = distance(got.rgba, reference({ box: [420, 912], scale: 1, ...pics, u: UNIFORMS }));
  expect(d.max).toBeLessThanOrEqual(2);
  expect(d.share).toBeLessThan(0.001);
  expect((await events(page)).filter(e => e[0] === "load")).toHaveLength(1);
  await context.close();
});

test.skipIf(!chrome)("a shader coordinate is a point of the box, whatever the pixel density", async () => {
  setup();
  const u = { ...UNIFORMS, center: [129.335, 222], radius: 90, band: 48, amp: UNIFORMS.amp / 2 };
  const { page, context } = await open({ box: [210, 456], scale: 2, props: ripple(u) });
  const got = await pixels(page);
  expect([got.w, got.h]).toEqual([420, 912]);
  const d = distance(got.rgba, reference({ box: [210, 456], scale: 2, ...pics, u }));
  expect(d.max).toBeLessThanOrEqual(2);
  expect(d.share).toBeLessThan(0.001);
  await context.close();
});

test.skipIf(!chrome)("new uniform values draw again, and the first picture differs from the second", async () => {
  setup();
  const { page, context } = await open({ box: [420, 912], scale: 1, props: ripple(UNIFORMS) });
  const first = await pixels(page);
  const later = { ...UNIFORMS, radius: 260, label: 1, amp: 8 };
  await page.evaluate(p => window.shader.setProps(p), ripple(later));
  const second = await pixels(page, first.draws);
  expect(second.draws).toBeGreaterThan(first.draws);
  expect(distance(first.rgba, second.rgba).max).toBeGreaterThan(60);
  const d = distance(second.rgba, reference({ box: [420, 912], scale: 1, ...pics, u: later }));
  expect(d.max).toBeLessThanOrEqual(2);
  expect(d.share).toBeLessThan(0.001);
  await context.close();
});

test.skipIf(!chrome)("a uniform the shader lacks, or of the wrong size, is reported once and the rest still draws", async () => {
  setup();
  const bad = ripple({ ...UNIFORMS, radus: 3, center: [1, 2, 3] });
  const { page, context } = await open({ box: [420, 912], scale: 1, props: bad });
  await pixels(page);
  await page.evaluate(p => window.shader.setProps(p), bad);
  const failed = (await events(page)).filter(e => e[0] === "failed").map(e => e[1][0]);
  expect(failed).toEqual(["uniform `center` takes 2 finite numbers", "uniform `radus` is not declared by the shader"]);
  await context.close();
});

test.skipIf(!chrome)("a shader that does not compile fails with the driver's reason", async () => {
  const { page, context } = await open({ box: [100, 100], scale: 1, props: { source: "half4 main(float2 p) { return half4(nope); }" } });
  await page.waitForFunction(() => window.events.length > 0);
  const [name, args] = (await events(page))[0];
  expect(name).toBe("failed");
  expect(args[0]).toContain("the shader did not compile");
  expect(args[0]).toContain("nope");
  await context.close();
});

test.skipIf(!chrome)("an image the shader reads but images does not list is reported by name", async () => {
  const { page, context } = await open({ box: [100, 100], scale: 1, props: { source: "uniform shader tex;\nhalf4 main(float2 p) { return tex.eval(p); }", images: "[]" } });
  await page.waitForFunction(() => window.events.length > 0);
  expect((await events(page))[0][1][0]).toBe("the shader reads image `tex`, which `images` does not list");
  await context.close();
});
