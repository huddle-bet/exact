// The numbers `exact-model` moves by: the same on the web and in ModelMotion.swift, so the
// tests of both name one set of values.

export const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** The direction a light travels for a yaw and pitch in degrees: yaw turns about +y from -z, a
 * positive pitch aims the light down. */
export function lightDirection(yawDeg, pitchDeg) {
  const cp = Math.cos(pitchDeg * DEG);
  return [-cp * Math.sin(yawDeg * DEG), -Math.sin(pitchDeg * DEG), -cp * Math.cos(yawDeg * DEG)];
}

/** A black body's colour at `kelvin` in linear sRGB (Tanner Helland's fit, as the app's light is
 * coloured). */
export function kelvinToLinear(kelvin) {
  const t = kelvin / 100;
  const ch = v => clamp(v, 0, 255) / 255;
  const r = t <= 66 ? 1 : ch(329.698727446 * Math.pow(t - 60, -0.1332047592));
  const g = t <= 66 ? ch(99.4708025861 * Math.log(t) - 161.1195681661) : ch(288.1221695283 * Math.pow(t - 60, -0.0755148492));
  const b = t >= 66 ? 1 : t <= 19 ? 0 : ch(138.5177312231 * Math.log(t - 10) - 305.0447927307);
  const lin = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return [lin(r), lin(g), lin(b)];
}

/** One step of a critically damped spring, in closed form: it settles in about `responseMs`. */
export function springStep(x, v, goal, responseMs, dt) {
  const w = (2 * Math.PI) / Math.max(responseMs / 1000, 0.05);
  const decay = Math.exp(-w * dt);
  const e = x - goal;
  const k = (v + w * e) * dt;
  return [goal + (e + k) * decay, (v - w * k) * decay];
}

/** Whether a spring at `x`, `v` has reached `goal`: the position within `limit`, the speed within
 * `limit` per response. */
export function sprung(x, v, goal, responseMs, limit) {
  const w = (2 * Math.PI) / Math.max(responseMs / 1000, 0.05);
  return Math.abs(x - goal) <= limit && Math.abs(v) <= limit * w;
}

/** The idle sway, -1 to 1: it rises to 1 in a quarter of the period, then swings with the period
 * on an ease-in-out sine. `t` is ms since the sway began. */
export function swayAt(t, periodMs) {
  if (!(periodMs > 0) || t <= 0) return 0;
  const half = periodMs / 2;
  if (t < half / 2) return (1 - Math.cos((Math.PI * t) / (half / 2))) / 2;
  return Math.cos((2 * Math.PI * (t - half / 2)) / periodMs);
}

export const TILT_DEFAULTS = { gain: 0.5, maxDeg: 6, stiffness: 70, damping: 15, recenter: 0.02 };

export const newTilt = () => ({ ready: false, basePitch: 0, baseRoll: 0, pitch: 0, yaw: 0, vPitch: 0, vYaw: 0 });

/** One step of the device tilt from the device's `pitch` and `roll` (radians, `CMAttitude`'s):
 * the base follows the device by `recenter` per step, so a held pose is the centre; the offset from
 * the base, scaled and clamped, is the aim of a spring on the model's pitch and yaw. */
export function tiltStep(s, pitch, roll, dt, cfg = TILT_DEFAULTS) {
  if (!s.ready) { s.ready = true; s.basePitch = pitch; s.baseRoll = roll; }
  s.basePitch += (pitch - s.basePitch) * cfg.recenter;
  s.baseRoll += (roll - s.baseRoll) * cfg.recenter;
  const max = cfg.maxDeg * DEG;
  const toPitch = clamp(-(pitch - s.basePitch) * cfg.gain, -max, max);
  const toYaw = clamp(-(roll - s.baseRoll) * cfg.gain, -max, max);
  const h = Math.min(dt, 0.05);
  s.vPitch += (cfg.stiffness * (toPitch - s.pitch) - cfg.damping * s.vPitch) * h;
  s.vYaw += (cfg.stiffness * (toYaw - s.yaw) - cfg.damping * s.vYaw) * h;
  s.pitch += s.vPitch * h;
  s.yaw += s.vYaw * h;
  return s;
}

/** The camera's distance from the origin, in the model's units. An authored `distance` wins;
 * otherwise the model's bounds (`half` its half height, `front` its nearest z) take `fit` of the
 * view's height. */
export function cameraDistance({ distance, fit, fov, half, front }) {
  if (Number.isFinite(distance) && distance > 0) return distance;
  return front + half / (fit * Math.tan((fov * DEG) / 2));
}

/** The pose matrix, column-major: translate(x, y, 0) * Rz(roll) * Rx(pitch) * Ry(yaw) * scale(s),
 * the order the model is posed in (yaw first). */
export function poseMatrix(pitch, yaw, roll, s, x, y) {
  const [cy, sy, cp, sp, cr, sr] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch), Math.cos(roll), Math.sin(roll)];
  // Rx(pitch) * Ry(yaw)
  const a = [cy, sp * sy, -cp * sy, 0, 0, cp, sp, 0, sy, -sp * cy, cp * cy, 0];
  // Rz(roll) * (that), by columns
  const out = new Array(16).fill(0);
  for (let c = 0; c < 3; c++) {
    const [px, py, pz] = [a[c * 4], a[c * 4 + 1], a[c * 4 + 2]];
    out[c * 4] = (cr * px - sr * py) * s;
    out[c * 4 + 1] = (sr * px + cr * py) * s;
    out[c * 4 + 2] = pz * s;
  }
  out[12] = x; out[13] = y; out[15] = 1;
  return out;
}

/** The sheen's gradient coordinate for a screen point (`u`, `v` in 0..1, v down) after the band
 * moved `along` the diagonal, on a screen of `w` by `h` points. */
export function sheenCoord(u, v, along, w, h) {
  const wu = (w * w) / (w * w + h * h);
  return (wu * (u + 1 - along) + (1 - wu) * (v + 1 - along)) / 3;
}

/** A band's alpha at gradient coordinate `t`: zero beyond `width` of the middle, `peak` at it. */
export function sheenAlpha(t, width, peak) {
  return peak * Math.max(0, 1 - Math.abs(t - 0.5) / (width / 2));
}

/** Where each sheen band sits: its own place, the rest offset, and the travel of the pose's yaw
 * and pitch (radians) away from where the pose is aimed. */
export function sheenAlong(at, rest, travelYaw, travelPitch, yaw, pitch) {
  return at + rest + travelYaw * yaw + travelPitch * pitch;
}

export const LEAN_TIGHTEN = 3;
export const POSE_KEYS = ['yaw', 'pitch', 'roll', 'scale', 'x', 'y'];

/** The pose a drag leans toward: the aimed pose moved `t` (0..1) of the way to `toward`. While `t` is
 * above zero the spring is `LEAN_TIGHTEN` times quicker, so the model follows the finger. */
export function leanGoal(goal, toward, t) {
  const k = Math.max(0, Math.min(1, t));
  const out = {};
  for (const key of POSE_KEYS) out[key] = goal[key] + ((toward?.[key] ?? goal[key]) - goal[key]) * k;
  return out;
}
export const leanResponse = (response, t) => (t > 0 ? response / LEAN_TIGHTEN : response);

/** Axis and angle (degrees) of a rotation matrix given by rows. */
export function axisAngle(m) {
  const tr = m[0] + m[4] + m[8];
  const angle = Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
  if (angle < 1e-9) return { axis: [0, 0, 1], deg: 0 };
  let axis;
  if (Math.PI - angle < 1e-6) {
    const i = [m[0], m[4], m[8]].indexOf(Math.max(m[0], m[4], m[8]));
    const col = [m[i], m[3 + i], m[6 + i]];
    col[i] += 1;
    const n = Math.hypot(...col);
    axis = col.map(v => v / n);
  } else {
    const v = [m[7] - m[5], m[2] - m[6], m[3] - m[1]];
    const n = Math.hypot(...v);
    axis = v.map(x => x / n);
  }
  return { axis, deg: angle / DEG };
}

/** Where a flat rectangle of the model (`rect`: its centre `c` and half width and height, facing +z,
 * before the pose) is on screen, as the CSS a box of `w` by `h` points needs to cover it: a parent with
 * `perspective`, and the box with `translate`, `rotate` (axis and angle) and `scale`, centred in the
 * parent. `pose` is the column-major pose matrix, the camera sits at (0, 0, distance) looking down -z, and the
 * view is `viewW` by `viewH` px. `quad` is the rectangle's corners in view px, top left, top right,
 * bottom right, bottom left. */
export function screenPlacement({ pose, rect, fov, distance, viewW, viewH, w, h }) {
  const at = (x, y, z) => [0, 1, 2].map(k => pose[k] * x + pose[4 + k] * y + pose[8 + k] * z + pose[12 + k]);
  const s = Math.hypot(pose[0], pose[1], pose[2]);
  const c = at(...rect.c);
  const f = viewH / 2 / Math.tan((fov * DEG) / 2);
  const depth = distance - c[2];
  const k = f / depth;
  // The pose's rotation, as CSS sees it: y is down, so conjugate by diag(1, -1, 1).
  const r = [0, 1, 2].flatMap(row => [0, 1, 2].map(col => pose[col * 4 + row] / s));
  const flip = [1, -1, 1, -1, 1, -1, 1, -1, 1];
  const rc = r.map((v, i) => v * flip[i]);
  const { axis, deg } = axisAngle(rc);
  const project = p => [viewW / 2 + (p[0] * f) / (distance - p[2]), viewH / 2 - (p[1] * f) / (distance - p[2])];
  const [hw, hh] = [rect.hw, rect.hh];
  const quad = [[-hw, hh], [hw, hh], [hw, -hh], [-hw, -hh]].flatMap(([x, y]) => project(at(rect.c[0] + x, rect.c[1] + y, rect.c[2])));
  const normal = [pose[8] / s, pose[9] / s, pose[10] / s];
  const facing = normal[0] * -c[0] + normal[1] * -c[1] + normal[2] * (distance - c[2]) > 0;
  const n = v => Math.round(v * 1e4) / 1e4, n6 = v => Math.round(v * 1e6) / 1e6;
  return {
    perspective: n(f),
    translate: `${n(c[0] * k)}px ${n(-c[1] * k)}px 0px`,
    rotate: `${axis.map(n6).join(' ')} ${n6(deg)}deg`,
    scale: (s * 2 * hw * k) / w,
    facing, quad: quad.map(n), height: (s * 2 * hh * k) / h,
  };
}
