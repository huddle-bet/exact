// An image's `load` record, `ImageLoadEvent` (contract/types/src/selection.rs), as the Apple hosts read it
// (host/apple/Sources/ExactKit/ImageInk.swift): the natural size, then the ink read on a copy whose longer side is at
// most 150 pixels, each read pixel the source pixel under its centre. Ink is alpha >= 24, solid alpha > 128. An image
// from another origin is read through a CORS request for the same source; one the page cannot read reports zeros.
const MAX_SIDE = 150, INK = 24, SOLID = 128, FOOT_ROW = 0.98, KEPT = 500;
const Read = new Map(); // source -> Promise of the eight fractions, or null

const pixels = (img, w, h) => {
  const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true }); ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data; // throws on a tainted canvas
};
const cors = src => new Promise(ok => { const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => ok(i); i.onerror = () => ok(null); i.src = src; });
const hullArea = points => {
  if (points.length < 3) return 0;
  const s = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1]), cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const lower = [], upper = [];
  for (const p of s) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop(); lower.push(p); }
  for (const p of [...s].reverse()) { while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop(); upper.push(p); }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  let twice = 0; for (let i = 0; i < hull.length; i++) { const a = hull[i], b = hull[(i + 1) % hull.length]; twice += a[0] * b[1] - b[0] * a[1]; }
  return Math.abs(twice) / 2;
};

/** The eight fractions of `alpha` (one byte per pixel, RGBA stride 4), or null when it holds no ink. */
export function measure(data, w, h) {
  const a = (x, y) => data[(y * w + x) * 4 + 3];
  let x0 = w, y0 = h, x1 = -1, y1 = -1; const rows = [];
  for (let y = 0; y < h; y++) {
    let first = -1, last = -1;
    for (let x = 0; x < w; x++) if (a(x, y) >= INK) { if (first < 0) first = x; last = x; }
    if (first < 0) continue;
    rows.push([y, first, last]); x0 = Math.min(x0, first); x1 = Math.max(x1, last); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  if (x1 < 0) return null;
  const r4 = n => Math.round(n * 10000) / 10000, r3 = n => Math.round(n * 1000) / 1000;
  const points = rows.flatMap(([y, l, r]) => [[l, y], [r + 1, y], [l, y + 1], [r + 1, y + 1]]);
  const boxArea = (x1 + 1 - x0) * (y1 + 1 - y0), hull = hullArea(points), fill = boxArea > 0 && hull > 0 ? r3(Math.min(1, hull / boxArea)) : 1;
  let solidTop = 0, footLeft = 0, footRight = 0;
  for (let y = 0; y < h; y++) {
    let any = false; for (let x = 0; x < w; x++) if (a(x, y) > SOLID) { any = true; break; }
    if (!any) continue;
    solidTop = y / h; const row = Math.min(h - 1, Math.round(h * FOOT_ROW)); let l = -1, r = -1;
    for (let x = 0; x < w; x++) if (a(x, row) > SOLID) { if (l < 0) l = x; r = x; }
    if (l >= 0) { footLeft = l / w; footRight = (r + 1) / w; }
    break;
  }
  return [r4(x0 / w), r4(y0 / h), r4(Math.min(1, (x1 + 1) / w)), r4(Math.min(1, (y1 + 1) / h)), fill, r4(solidTop), r4(footLeft), r4(footRight)];
}

/** The ten numbers of `img`'s `ImageLoadEvent`, once it has loaded. */
export function imageLoadRecord(img) {
  const nw = img.naturalWidth, nh = img.naturalHeight, src = img.currentSrc || img.src;
  if (!nw || !nh || !globalThis.document) return Promise.resolve([nw || 0, nh || 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const k = Math.min(1, MAX_SIDE / Math.max(nw, nh)), w = Math.max(1, Math.round(nw * k)), h = Math.max(1, Math.round(nh * k));
  let job = Read.get(src);
  if (!job) {
    job = (async () => {
      try { return measure(pixels(img, w, h), w, h); } catch {}
      const again = /^(data|blob):/.test(src) ? null : await cors(src);
      try { return again ? measure(pixels(again, w, h), w, h) : null; } catch { return null; }
    })();
    if (Read.size >= KEPT) Read.delete(Read.keys().next().value);
    Read.set(src, job);
  }
  return job.then(m => [nw, nh, ...(m ?? [0, 0, 0, 0, 0, 0, 0, 0])]);
}
