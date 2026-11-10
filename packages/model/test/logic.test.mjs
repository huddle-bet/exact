// The Apple side's numbers (apple/ModelMotion.swift, ModelGLB.swift, ModelLight.swift) against the web's
// (web/motion.js, glb.js, ktx.js): one set of values on both. Compiles test/main.swift with swiftc and
// runs it; skipped where there is no swiftc. A glb and a ktx named by MODEL_GLB and MODEL_KTX are read too.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { leanGoal, poseMatrix, screenPlacement, kelvinToLinear, lightDirection, newTilt, springStep, swayAt, tiltStep, cameraDistance, sheenCoord, sheenAlpha } from "../web/motion.js";
import { bounds, parseGLB, readAccessor, drawables, rectOf } from "../web/glb.js";
import { packR11G11B10, parseKTX } from "../web/ktx.js";

const here = dirname(fileURLToPath(import.meta.url)), apple = resolve(here, "../apple");
const swiftc = spawnSync("xcrun", ["--find", "swiftc"]).status === 0;
const glbPath = process.env.MODEL_GLB, ktxPath = process.env.MODEL_KTX;

const run = () => {
  const dir = mkdtempSync(resolve(tmpdir(), "exact-model-"));
  const exe = resolve(dir, "logic");
  const built = spawnSync("xcrun", ["swiftc", "-o", exe, resolve(here, "main.swift"), ...["ModelMotion", "ModelGLB", "ModelLight"].map(f => resolve(apple, `${f}.swift`))], { encoding: "utf8" });
  if (built.status !== 0) throw new Error(built.stderr);
  const out = spawnSync(exe, [glbPath ?? "", ktxPath ?? ""].filter(Boolean), { encoding: "utf8" });
  if (out.status !== 0) throw new Error(out.stderr);
  return JSON.parse(out.stdout);
};

const close = (a, b, digits = 9) => { expect(a).toHaveLength(b.length); a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits)); };

// Apple and web that disagree on a number: the app looks right on one and wrong on the other.
test.skipIf(!swiftc)("Apple's motion numbers equal the web's", () => {
  const apple = run();
  close(apple.light, lightDirection(-34.7, 18));
  close(apple.kelvin, kelvinToLinear(5500));
  let x = 0, v = 0;
  for (let i = 0; i < 10; i++) [x, v] = springStep(x, v, 1, 850, 1 / 60);
  close(apple.spring, [x, v]);
  const t = newTilt();
  for (let i = 0; i < 20; i++) tiltStep(t, 1.2 + i * 0.01, 0.05 * i, 1 / 60);
  close(apple.tilt, [t.pitch, t.yaw, t.vPitch, t.vYaw]);
  close(apple.sway, [swayAt(600, 5200), swayAt(3000, 5200)]);
  close(apple.distance, [cameraDistance({ fit: 0.74, fov: 24, half: 0.0783, front: 0.00566 }), 0.5]);
  close(apple.sheen, [sheenCoord(0.3, 0.6, -0.6, 420, 912), sheenAlpha(0.52, 0.12, 0.06)]);
  expect(apple.pack).toEqual([packR11G11B10(0.5, 1, 2), 0, packR11G11B10(60000, 1, 1)]);
  expect(apple.studio).toEqual({ size: 32, levels: 4 });
  const rect = { c: [-0.0028, 0, 0.00566], hw: 0.03482, hh: 0.07573 };
  const { height, ...web } = screenPlacement({ pose: poseMatrix(-0.05, 0.28, 0.1, 0.99, 0.004, -0.01), rect, fov: 24, distance: 0.503, viewW: 420, viewH: 700, w: 420, h: 912 });
  expect(apple.placement.translate).toBe(web.translate);
  expect(apple.placement.rotate).toBe(web.rotate);
  expect(apple.placement.facing).toBe(web.facing);
  close([apple.placement.perspective, apple.placement.scale, ...apple.placement.quad], [web.perspective, web.scale, ...web.quad], 3);
  const l = leanGoal({ yaw: 0.2, pitch: 0, roll: 0, scale: 1, x: 0, y: 0 }, { yaw: -0.4, pitch: -0.1, roll: 0, scale: 0.6, x: 0.01, y: 0 }, 0.5);
  close(apple.lean, [l.yaw, l.pitch, l.roll, l.scale, l.x, l.y]);
});

test.skipIf(!swiftc || !glbPath || !ktxPath)("Apple reads the glb and the ktx as the web does", () => {
  const apple = run();
  const doc = parseGLB(readFileSync(glbPath).buffer.slice(0));
  const d = drawables(doc), b = bounds(doc);
  expect(apple.glb.drawables).toBe(d.length);
  close(apple.glb.min, b.min, 6);
  close(apple.glb.max, b.max, 6);
  const r = rectOf(doc, "tppzCQmnlKcHIpP");
  close(apple.rect, [...r.c, r.hw, r.hh], 6);
  expect(apple.glb.chain).toEqual(d.at(-1).chain);
  const pos = readAccessor(doc, doc.json.meshes[d[0].mesh].primitives[d[0].primitive].attributes.POSITION).array;
  close(apple.glb.firstVertex, Array.from(pos.slice(0, 3)), 7);
  const k = parseKTX(readFileSync(ktxPath).buffer.slice(0));
  expect(apple.ktx.sizes).toEqual(k.mips.map(m => m.size));
  expect(apple.ktx.firstTexel).toEqual(Array.from(new Uint8Array(k.mips[0].texels[0].buffer, 0, 4)));
});
