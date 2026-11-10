// What each test catches is named above it. Run: bun test packages/model/web
import { expect, test } from "bun:test";
import { parseGLB, readAccessor, drawables, bounds, fromTRS, multiply } from "./glb.js";
import { parseKTX, packR11G11B10, studioLight } from "./ktx.js";
import { DEG, TILT_DEFAULTS, cameraDistance, kelvinToLinear, lightDirection, newTilt, poseMatrix, sheenAlong, sheenAlpha, sheenCoord, springStep, sprung, swayAt, tiltStep } from "./motion.js";

const near = (a, b, digits = 6) => { expect(a.length).toBe(b.length); a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits)); };

// A light that shines from below or behind the camera instead of from the upper left front.
test("the key light travels down and away from the camera on its upper left", () => {
  near(lightDirection(-34.7, 18), [0.541417, -0.309017, -0.781905]);
});

// Linear light written as sRGB: a 5500 K rim light that is too dark and too orange.
test("a 5500 K light is linear sRGB, warm but not orange", () => {
  near(kelvinToLinear(5500), [1, 0.850871, 0.732285]);
});

// A wrong omega: the pose arrives in a different time than `response` says, or rings past its goal.
test("a spring with response 850 ms reaches its goal without overshoot and reports settled", () => {
  let x = 0, v = 0, peak = 0, at = -1;
  for (let i = 0; i < 180; i++) {
    [x, v] = springStep(x, v, 1, 850, 1 / 60);
    peak = Math.max(peak, x);
    if (at < 0 && sprung(x, v, 1, 850, 0.012)) at = i;
  }
  expect(peak).toBeLessThanOrEqual(1.000001);
  expect(Math.abs(x - 1)).toBeLessThan(1e-3);
  expect(at).toBeGreaterThan(40);
  expect(at).toBeLessThan(65);
});

// A tilt that never recentres drifts off for good when the phone is held at an angle, or one that is
// not clamped leans the phone far past the app's limit.
test("a held device leans the model back to rest and a sharp turn is clamped to tiltMaxDeg", () => {
  const held = newTilt();
  for (let i = 0; i < 600; i++) tiltStep(held, 1.2, 0.3, 1 / 60);
  expect(Math.abs(held.pitch)).toBeLessThan(1e-6);
  expect(Math.abs(held.yaw)).toBeLessThan(1e-6);
  const swung = newTilt();
  tiltStep(swung, 1.2, 0, 1 / 60);
  let worst = 0;
  for (let i = 0; i < 120; i++) { tiltStep(swung, 2.4, 1.5, 1 / 60); worst = Math.max(worst, Math.abs(swung.pitch), Math.abs(swung.yaw)); }
  expect(worst).toBeGreaterThan(0.5 * TILT_DEFAULTS.maxDeg * DEG);
  expect(worst).toBeLessThan(TILT_DEFAULTS.maxDeg * DEG * 1.35);
});

// Tilt with the wrong sign: the phone leans toward the thumb instead of away from it.
test("the model turns against the device's roll and pitch", () => {
  const s = newTilt();
  tiltStep(s, 1, 0, 1 / 60);
  for (let i = 0; i < 10; i++) tiltStep(s, 1.1, 0.2, 1 / 60);
  expect(s.pitch).toBeLessThan(0);
  expect(s.yaw).toBeLessThan(0);
});

// A sway that starts at full swing jolts the model on the first frame.
test("the sway starts at rest, peaks a quarter period in and swings on the period", () => {
  expect(swayAt(0, 5200)).toBe(0);
  expect(swayAt(1300, 5200)).toBeCloseTo(1, 6);
  expect(swayAt(1300 + 5200, 5200)).toBeCloseTo(1, 6);
  expect(swayAt(1300 + 2600, 5200)).toBeCloseTo(-1, 6);
});

// `distance` ignored, or `fit` measured to the model's middle instead of its front face.
test("an authored distance wins; otherwise the model's height takes `fit` of the view", () => {
  expect(cameraDistance({ distance: 0.5, fit: 0.74, fov: 24, half: 0.0783, front: 0.00566 })).toBe(0.5);
  const d = cameraDistance({ distance: NaN, fit: 0.74, fov: 24, half: 0.0783, front: 0.00566 });
  expect(d).toBeCloseTo(0.503461, 5);
  expect(2 * 0.0783 / (2 * (d - 0.00566) * Math.tan(12 * DEG))).toBeCloseTo(0.74, 6);
});

// The app's projectPhonePoint turns the model about y, then x, scaled first and moved last. A pose
// that rotates in another order puts each tour pose's screen corners elsewhere.
test("the pose matrix is the app's: yaw, then pitch, then roll, scaled, then moved", () => {
  const rn = ([px, py, pz], pitch, yaw, s, shift, lift) => {
    const [x0, y0, z0] = [px * s, py * s, pz * s];
    const x1 = x0 * Math.cos(yaw) + z0 * Math.sin(yaw), z1 = -x0 * Math.sin(yaw) + z0 * Math.cos(yaw);
    return [x1 + shift, y0 * Math.cos(pitch) - z1 * Math.sin(pitch) + lift, y0 * Math.sin(pitch) + z1 * Math.cos(pitch)];
  };
  for (const [pitch, yaw, s] of [[-2 * DEG, 16 * DEG, 1], [-3 * DEG, -9 * DEG, 0.99], [0.7, -1.1, 1.4]]) {
    const m = poseMatrix(pitch, yaw, 0, s, 0.01, -0.02);
    const p = [0.03482, 0.07573, 0.00566];
    const got = [0, 1, 2].map(k => m[k] * p[0] + m[4 + k] * p[1] + m[8 + k] * p[2] + m[12 + k]);
    near(got, rn(p, pitch, yaw, s, 0.01, -0.02), 9);
  }
  const rolled = poseMatrix(0, 0, Math.PI / 2, 1, 0, 0);
  near([rolled[0], rolled[1], rolled[4], rolled[5]], [0, 1, -1, 0], 9);
});

// The sheen band that does not move with the pose, or one that is not centred on its coordinate.
test("a sheen band peaks at its coordinate and travels with yaw and pitch", () => {
  near([sheenCoord(0.3, 0.6, -0.6, 420, 912)], [0.715836], 6);
  expect(sheenAlpha(0.5, 0.12, 0.06)).toBeCloseTo(0.06, 9);
  expect(sheenAlpha(0.58, 0.12, 0.06)).toBe(0);
  expect(sheenAlong(1.6, -0.6, 4, 3, 0.1, -0.05)).toBeCloseTo(1.25, 9);
});

function glb(json, bin) {
  const enc = new TextEncoder();
  let j = enc.encode(JSON.stringify(json));
  const pad = (n, to) => (to - (n % to)) % to;
  const jpad = new Uint8Array(j.length + pad(j.length, 4)).fill(0x20); jpad.set(j);
  const bpad = new Uint8Array(bin.length + pad(bin.length, 4)); bpad.set(bin);
  const out = new Uint8Array(12 + 8 + jpad.length + 8 + bpad.length), v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true); v.setUint32(4, 2, true); v.setUint32(8, out.length, true);
  v.setUint32(12, jpad.length, true); v.setUint32(16, 0x4e4f534a, true); out.set(jpad, 20);
  v.setUint32(20 + jpad.length, bpad.length, true); v.setUint32(24 + jpad.length, 0x004e4942, true); out.set(bpad, 28 + jpad.length);
  return out.buffer;
}

// A byteStride ignored: interleaved positions read as garbage, so the model's bounds and shape are wrong.
test("a glb's interleaved accessor is read by its stride, its scene by node transforms", () => {
  const bin = new Uint8Array(3 * 20), f = new Float32Array(bin.buffer);
  [[0, 0, 0, 9, 9], [2, 0, 0, 9, 9], [0, 4, 0, 9, 9]].forEach((p, i) => f.set(p, i * 5));
  const doc = parseGLB(glb({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'root', translation: [1, 0, 0], rotation: [0, 0.7071067811865476, 0, 0.7071067811865476], children: [1] }, { name: 'tri', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [2, 4, 0] }],
    bufferViews: [{ buffer: 0, byteLength: 60, byteStride: 20 }], buffers: [{ byteLength: 60 }],
  }, bin));
  expect(Array.from(readAccessor(doc, 0).array)).toEqual([0, 0, 0, 2, 0, 0, 0, 4, 0]);
  const [d] = drawables(doc);
  expect(d.chain).toEqual(['root', 'tri']);
  const b = bounds(doc);
  near(b.min, [1, 0, -2], 6);
  near(b.max, [1, 4, 0], 6);
});

test("a file that is not a glb 2.0 is refused by name", () => {
  expect(() => parseGLB(new ArrayBuffer(40))).toThrow("not a binary glTF");
});

test("TRS and matrix composition agree", () => {
  const m = multiply(fromTRS([1, 2, 3]), fromTRS([0, 0, 0], [0, 0, 0, 1], [2, 2, 2]));
  near([m[0], m[5], m[10], m[12], m[13], m[14]], [2, 2, 2, 1, 2, 3], 9);
});

function ktx({ format = 35898, faces = 6, sh = '1 1 1\n0 0 0\n0 0 0\n0 0 0\n0 0 0\n0 0 0\n0 0 0\n0 0 0\n0 0 0\n' } = {}) {
  const key = new TextEncoder().encode('sh\0' + sh + '\0');
  const entry = new Uint8Array(4 + key.length + ((4 - (key.length % 4)) % 4)); new DataView(entry.buffer).setUint32(0, key.length, true); entry.set(key, 4);
  const levels = [[4, 4 * 4 * 4], [2, 4 * 4]].map(([n, bytes]) => ({ n, bytes }));
  const total = 64 + entry.length + levels.reduce((a, l) => a + 4 + 6 * l.bytes, 0);
  const out = new Uint8Array(total), v = new DataView(out.buffer);
  out.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x31, 0x31, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  [0x04030201, format, 1, 6407, format, format, 4, 4, 0, 0, faces, 2, entry.length].forEach((x, i) => v.setUint32(12 + i * 4, x, true));
  out.set(entry, 64);
  let at = 64 + entry.length;
  levels.forEach((l, level) => {
    v.setUint32(at, l.bytes, true); at += 4;
    for (let face = 0; face < 6; face++) { for (let i = 0; i < l.bytes / 4; i++) v.setUint32(at + i * 4, packR11G11B10(level + face + 1, 0, 0), true); at += l.bytes; }
  });
  return out.buffer;
}

// Faces read at the wrong offset (the size field of a level counted once, not per level) scramble the light.
test("a cmgen ktx's mips, faces and sh rows are read", () => {
  const light = parseKTX(ktx());
  expect(light.mips.map(m => m.size)).toEqual([4, 2]);
  expect(light.mips[1].texels).toHaveLength(6);
  expect(light.mips[1].texels[5][0]).toBe(packR11G11B10(7, 0, 0));
  expect(light.mips[0].texels[2][0]).toBe(packR11G11B10(3, 0, 0));
  expect(light.sh).toHaveLength(9);
  expect(light.sh[0]).toEqual([1, 1, 1]);
});

test("a ktx that is not R11G11B10F, or has no sh, is refused by name", () => {
  expect(() => parseKTX(ktx({ format: 32856 }))).toThrow("not read");
  expect(() => parseKTX(ktx({ sh: '1 1 1\n' }))).toThrow("sh entry");
});

// A packer that rounds the exponent wrongly writes a light of the wrong brightness.
test("R11G11B10F packs the values the GPU unpacks", () => {
  expect(packR11G11B10(1, 1, 1)).toBe(((15 << 6) | ((15 << 6) << 11) | (15 << 5 << 22)) >>> 0);
  expect(packR11G11B10(0, 0, 0)).toBe(0);
  expect(packR11G11B10(1e9, 0, 0) & 0x7ff).toBe((30 << 6) | 63);
});

test("the studio light has a bright sky, a brighter window and mips down to 4 texels", () => {
  const light = studioLight();
  expect(light.mips.map(m => m.size)).toEqual([32, 16, 8, 4]);
  expect(light.sh[0][0]).toBeGreaterThan(0.4);
  expect(light.sh[2][0]).toBeGreaterThan(0);
});
