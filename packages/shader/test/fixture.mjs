// What the web and Apple pixel tests share: the React Native home-screen ripple as its app writes it, two test images,
// and a CPU reference of that shader built from the ripple's equations (not from the translators), so a GPU picture is
// checked against the maths rather than against the other host.

// huddle-client apps/mobile/src/onboarding/native-phone/ripple.ts RIPPLE_FIELD and home-screen.tsx WAVE_SOURCE, verbatim.
export const RIPPLE_FIELD = `
uniform float2 center;
uniform float radius;
uniform float power;

float field(float2 q) {
  float2 a = abs(q - center);
  return pow(pow(a.x, power) + pow(a.y, power), 1.0 / power) - radius;
}

float box(float2 q, float2 c, float2 h, float r) {
  float2 d = abs(q - c) - h + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}
`;
export const WAVE_SOURCE = `
uniform shader image;
uniform shader huddle;
uniform float label;
uniform float band;
uniform float amp;
uniform float spread;
${RIPPLE_FIELD}

half4 main(float2 p) {
  float f = field(p);
  float2 grad = float2(field(p + float2(1.0, 0.0)) - f, field(p + float2(0.0, 1.0)) - f);
  float2 dir = length(grad) > 0.0001 ? normalize(grad) : float2(0.0, 0.0);
  float x = f / band;
  float2 shift = dir * amp * 2.0 * x * exp(-x * x);
  float2 sr = shift * (1.0 + spread);
  float2 sb = shift * (1.0 - spread);
  half r = mix(image.eval(p + sr).r, huddle.eval(p + sr).r, label);
  half g = mix(image.eval(p + shift).g, huddle.eval(p + shift).g, label);
  half b = mix(image.eval(p + sb).b, huddle.eval(p + sb).b, label);
  return half4(r, g, b, 1.0);
}
`;

// The values the app passes at a moment of the wave (T.HOME_SLOT's centre, WAVE_SQUIRCLE, WAVE_BAND, WAVE_AMP, WAVE_SPREAD).
export const UNIFORMS = { center: [258.67, 444], radius: 180, power: 5, band: 96, amp: 34 * Math.pow(0.6, 1.3), spread: 0.025, label: 0.6 };

/** An opaque w by h picture with smooth colour, a hard edge and no symmetry, so a flip, a swap or a shift shows. */
export function picture(w, h, seed) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, u = x / w, v = y / h;
    out[i] = 127.5 + 127.5 * Math.sin(u * 9 + seed) * Math.cos(v * 4);
    out[i + 1] = 255 * (v * 0.7 + 0.3 * Math.sin(u * 13 + seed * 2));
    out[i + 2] = (Math.floor(x / 7) + Math.floor(y / 11) + seed) % 2 === 0 ? 235 - 150 * u : 40 + 150 * v;
    out[i + 3] = 255;
  }
  return out;
}

const mix = (a, b, t) => a + (b - a) * t;

/** One channel of `img` ({w, h, data}) at box point (x, y) in cover sizing: bilinear, outside the picture 0 (decal). */
function sample(img, box, x, y, channel) {
  const s = Math.max(box[0] / img.w, box[1] / img.h);
  const ox = (box[0] - img.w * s) / 2, oy = (box[1] - img.h * s) / 2;
  const qx = (x - ox) / s - 0.5, qy = (y - oy) / s - 0.5;
  const x0 = Math.floor(qx), y0 = Math.floor(qy), fx = qx - x0, fy = qy - y0;
  const at = (cx, cy) => (cx < 0 || cy < 0 || cx >= img.w || cy >= img.h ? 0 : img.data[(cy * img.w + cx) * 4 + channel] / 255);
  return mix(mix(at(x0, y0), at(x0 + 1, y0), fx), mix(at(x0, y0 + 1), at(x0 + 1, y0 + 1), fx), fy);
}

/** The ripple's picture, RGBA bytes: `box` in points drawn at `scale` pixels to the point. */
export function reference({ box, scale, image, huddle, u }) {
  const w = Math.round(box[0] * scale), h = Math.round(box[1] * scale), out = new Uint8Array(w * h * 4);
  const field = (x, y) => Math.pow(Math.pow(Math.abs(x - u.center[0]), u.power) + Math.pow(Math.abs(y - u.center[1]), u.power), 1 / u.power) - u.radius;
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
    const x = (px + 0.5) / scale, y = (py + 0.5) / scale;
    const f = field(x, y), gx = field(x + 1, y) - f, gy = field(x, y + 1) - f, len = Math.hypot(gx, gy);
    const dx = len > 0.0001 ? gx / len : 0, dy = len > 0.0001 ? gy / len : 0;
    const k = f / u.band, gain = u.amp * 2 * k * Math.exp(-k * k);
    const channel = (c, split) => {
      const sx = x + dx * gain * split, sy = y + dy * gain * split;
      return mix(sample(image, box, sx, sy, c), sample(huddle, box, sx, sy, c), u.label);
    };
    const o = (py * w + px) * 4;
    out[o] = Math.round(channel(0, 1 + u.spread) * 255);
    out[o + 1] = Math.round(channel(1, 1) * 255);
    out[o + 2] = Math.round(channel(2, 1 - u.spread) * 255);
    out[o + 3] = 255;
  }
  return out;
}

/** How far two RGBA pictures are apart: the largest channel difference, and how many channels differ by more than 1. */
export function distance(a, b) {
  if (a.length !== b.length) throw new Error(`pictures of ${a.length} and ${b.length} bytes`);
  let max = 0, over = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > max) max = d; if (d > 1) over++; }
  return { max, over, share: over / a.length };
}
