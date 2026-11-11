import { beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../web/sksl.js";
import { WAVE_SOURCE, UNIFORMS, distance, picture, reference } from "./fixture.mjs";
import { png } from "./png.mjs";

setDefaultTimeout(120_000);
const here = dirname(fileURLToPath(import.meta.url)), apple = resolve(here, "../apple");
const swiftc = spawnSync("xcrun", ["--find", "swiftc"]).status === 0;
const dir = mkdtempSync(resolve(tmpdir(), "exact-shader-"));
const exe = resolve(dir, "render");

beforeAll(() => {
  if (!swiftc) return;
  const built = spawnSync("xcrun", ["swiftc", "-O", "-o", exe, resolve(here, "main.swift"), resolve(apple, "ShaderSkSL.swift"), resolve(apple, "ShaderRender.swift")], { encoding: "utf8" });
  if (built.status !== 0) throw new Error(built.stderr);
});

const pics = { image: { w: 105, h: 228, data: picture(105, 228, 1) }, huddle: { w: 105, h: 228, data: picture(105, 228, 4) } };
const files = {};
function render({ source = WAVE_SOURCE, box, scale, u, tile = "decal", extra = {} }) {
  for (const k of ["image", "huddle"]) { files[k] ??= resolve(dir, `${k}.png`); writeFileSync(files[k], png(105, 228, pics[k].data)); }
  const spec = resolve(dir, "spec.json");
  writeFileSync(spec, JSON.stringify({
    source, width: Math.round(box[0] * scale), height: Math.round(box[1] * scale), box,
    images: ["image", "huddle"].map(name => ({ name, file: files[name], sizing: "cover", tile })),
    uniforms: Object.entries(u ?? {}).map(([name, value]) => ({ name, value: [].concat(value) })), ...extra,
  }));
  const out = spawnSync(exe, [spec], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (out.status !== 0) throw new Error(out.stderr);
  return JSON.parse(out.stdout);
}

test.skipIf(!swiftc)("the ripple's source, as written for Skia, compiles for Metal and fills every pixel", () => {
  const out = render({ box: [420, 912], scale: 1, u: UNIFORMS });
  expect(out.problems).toEqual([]);
  expect(Buffer.from(out.rgba, "base64").length).toBe(420 * 912 * 4);
});

test.skipIf(!swiftc)("the Metal view draws the home ripple as its equations say", () => {
  const got = Uint8Array.from(Buffer.from(render({ box: [420, 912], scale: 1, u: UNIFORMS }).rgba, "base64"));
  const d = distance(got, reference({ box: [420, 912], scale: 1, ...pics, u: UNIFORMS }));
  expect(d.max).toBeLessThanOrEqual(2);
  expect(d.share).toBeLessThan(0.001);
});

test.skipIf(!swiftc)("a shader coordinate is a point of the box, whatever the screen's scale", () => {
  const u = { ...UNIFORMS, center: [129.335, 222], radius: 90, band: 48, amp: UNIFORMS.amp / 2 };
  const got = Uint8Array.from(Buffer.from(render({ box: [210, 456], scale: 2, u }).rgba, "base64"));
  const d = distance(got, reference({ box: [210, 456], scale: 2, ...pics, u }));
  expect(d.max).toBeLessThanOrEqual(2);
  expect(d.share).toBeLessThan(0.001);
});

test.skipIf(!swiftc)("an undeclared uniform and one of the wrong size are reported", () => {
  const out = render({ box: [420, 912], scale: 1, u: { ...UNIFORMS, radus: 3, center: [1, 2, 3] } });
  expect(out.problems).toEqual(["uniform `center` takes 2 finite numbers", "uniform `radus` is not declared by the shader"]);
});

test.skipIf(!swiftc)("a shader that does not compile is refused with the compiler's reason", () => {
  const out = spawnSync(exe, [(() => { const p = resolve(dir, "bad.json"); writeFileSync(p, JSON.stringify({ source: "half4 main(float2 p) { return half4(nope); }", width: 4, height: 4, box: [4, 4], images: [], uniforms: [] })); return p; })()], { encoding: "utf8" });
  expect(out.status).not.toBe(0);
  expect(out.stderr).toContain("the shader did not compile");
  expect(out.stderr).toContain("nope");
});

test.skipIf(!swiftc)("Apple reads the same declarations as the web, and the same refusals", () => {
  const msl = JSON.parse(spawnSync(exe, [(() => { const p = resolve(dir, "msl.json"); writeFileSync(p, JSON.stringify({ source: WAVE_SOURCE, msl: true })); return p; })()], { encoding: "utf8" }).stdout).msl;
  const d = parse(WAVE_SOURCE);
  for (const name of d.shaders) expect(msl).toContain(`ExactImage ${name};`);
  for (const f of d.floats) expect(msl).toContain(`${f.size === 1 ? "float" : `float${f.size}`} ${f.name};`);
  for (const bad of ["uniform float a, b;\nhalf4 main(float2 p) { return half4(1.0); }", "uniform int a;\nhalf4 main(float2 p) { return half4(1.0); }", "half4 shade(float2 p) { return half4(1.0); }"]) {
    let web = "";
    try { parse(bad); } catch (e) { web = e.message; }
    const p = resolve(dir, "refuse.json");
    writeFileSync(p, JSON.stringify({ source: bad, msl: true }));
    expect(spawnSync(exe, [p], { encoding: "utf8" }).stderr.trim()).toBe(web);
  }
});

test.skipIf(!swiftc)("the package typechecks against the iOS simulator SDK and the macOS SDK", () => {
  const root = resolve(here, "../../..");
  for (const [sdk, triple] of [["iphonesimulator", "arm64-apple-ios17.0-simulator"], ["macosx", "arm64-apple-macos14.0"]]) {
    const modules = mkdtempSync(resolve(tmpdir(), "exact-shader-seam-"));
    const flags = ["--sdk", sdk, "swiftc", "-swift-version", "5", "-target", triple, "-module-cache-path", resolve(modules, "cache")];
    const seam = spawnSync("xcrun", [...flags, "-parse-as-library", "-module-name", "ExactPackage", "-emit-module", "-emit-module-path", resolve(modules, "ExactPackage.swiftmodule"), "-c", resolve(root, "host/apple/modules/ExactPackage.swift"), "-o", resolve(modules, "seam.o")], { encoding: "utf8" });
    expect(seam.stderr.replace(/warning:.*\n/g, "")).not.toContain("error:");
    const check = spawnSync("xcrun", [...flags, "-parse-as-library", "-typecheck", "-I", modules, ...["Shader", "ShaderRender", "ShaderSkSL"].map(f => resolve(apple, `${f}.swift`))], { encoding: "utf8" });
    expect(check.stderr).not.toContain("error:");
    expect(check.status).toBe(0);
  }
});
