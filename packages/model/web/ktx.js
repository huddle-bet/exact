// An image-based light as Filament's `cmgen` writes it: a KTX 1 cubemap of R11G11B10F texels, its
// mips prefiltered by roughness (the last is roughness 1), and the diffuse light as nine
// spherical-harmonic coefficients in the file's `sh` entry, ready to evaluate (`irradianceSH`).

const IDENT = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x31, 0x31, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
export const R11G11B10F = 35898;

export function parseKTX(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  if (buffer.byteLength < 64 || IDENT.some((b, i) => bytes[i] !== b)) throw new Error('not a KTX 1 file');
  const [endian, , , , internalFormat, , width, height, , , faces, levels, keyBytes] = Array.from({ length: 13 }, (_, i) => view.getUint32(12 + i * 4, true));
  if (endian !== 0x04030201) throw new Error('a big-endian KTX is not read');
  if (internalFormat !== R11G11B10F) throw new Error(`a KTX of format ${internalFormat} is not read: the light is R11G11B10F`);
  if (faces !== 6 || width !== height) throw new Error('the light is a cubemap');
  let sh = null;
  for (let at = 64; at < 64 + keyBytes;) {
    const length = view.getUint32(at, true), entry = bytes.subarray(at + 4, at + 4 + length);
    const zero = entry.indexOf(0);
    if (new TextDecoder().decode(entry.subarray(0, zero)) === 'sh') {
      const rows = new TextDecoder().decode(entry.subarray(zero + 1)).replace(/\0+$/, '').trim().split('\n');
      sh = rows.map(r => r.trim().split(/\s+/).map(Number));
    }
    at += 4 + ((length + 3) & ~3);
  }
  const mips = [];
  let at = 64 + keyBytes;
  for (let level = 0; level < Math.max(1, levels); level++) {
    const size = view.getUint32(at, true);
    at += 4;
    const texels = [];
    for (let face = 0; face < 6; face++) {
      texels.push(new Uint32Array(buffer.slice(at, at + size)));
      at += (size + 3) & ~3;
    }
    mips.push({ size: Math.max(1, width >> level), texels });
  }
  if (!sh || sh.length < 9 || sh.some(r => r.length !== 3 || r.some(v => !Number.isFinite(v)))) throw new Error('the light has no sh entry of nine coefficients');
  return { size: width, mips, sh: sh.slice(0, 9) };
}

const mix = (a, b, t) => a + (b - a) * t;
const smooth = x => x * x * (3 - 2 * x);
const box = (u, v, [u0, u1, v0, v1]) => smooth(Math.min(1, Math.max(0, (Math.min(u - u0, u1 - u) + 0.04) / 0.08))) * smooth(Math.min(1, Math.max(0, (Math.min(v - v0, v1 - v) + 0.04) / 0.08)));

/** A plain studio when the app names no light: a grey room with a brighter sky and one soft window,
 * as the cubemap and sh a file would hold. */
export function studioLight(size = 32) {
  const levels = Math.log2(size) - 1;
  const mips = [];
  const face = (f, u, v) => [[1, -v, -u], [-1, -v, u], [u, 1, v], [u, -1, -v], [u, -v, 1], [-u, -v, -1]][f];
  const radiance = d => {
    const l = Math.hypot(...d), y = d[1] / l, z = d[2] / l, x = d[0] / l;
    const base = mix(0.45, 1.0, 0.5 + 0.5 * y);
    const window = z > 0.2 ? box(x * 0.5 / z + 0.5, 0.5 - y * 0.5 / z, [0.3, 0.7, 0.25, 0.65]) : 0;
    return base + 8 * window;
  };
  const sum = new Array(9).fill(0);
  let total = 0;
  for (let level = 0, n = size; level < levels; level++, n >>= 1) {
    const texels = [];
    for (let f = 0; f < 6; f++) {
      const t = new Uint32Array(n * n);
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const d = face(f, (2 * (i + 0.5)) / n - 1, (2 * (j + 0.5)) / n - 1);
        const blur = level === 0 ? 0 : level / levels;
        const r = mix(radiance(d), 0.9, blur * 0.8);
        t[j * n + i] = packR11G11B10(r, r, r);
        if (level === 0) {
          const l = Math.hypot(...d), w = 1 / (l * l * l), [x, y, z] = [d[0] / l, d[1] / l, d[2] / l];
          const b = [1, y, z, x, y * x, y * z, 3 * z * z - 1, z * x, x * x - y * y];
          for (let k = 0; k < 9; k++) sum[k] += r * w * b[k];
          total += w;
        }
      }
      texels.push(t);
    }
    mips.push({ size: n, texels });
  }
  // Irradiance over pi: each band's cosine weight (1, 2/3, 1/4) and the basis constant, twice, with the sphere's 4 pi.
  const K = [0.282095, 0.488603, 0.488603, 0.488603, 1.092548, 1.092548, 0.315392, 1.092548, 0.546274];
  const A = [1, 2 / 3, 2 / 3, 2 / 3, 0.25, 0.25, 0.25, 0.25, 0.25];
  const sh = sum.map((s, k) => { const v = A[k] * K[k] * K[k] * 4 * Math.PI * (s / total); return [v, v, v]; });
  return { size, mips, sh };
}

const f16 = new Float32Array(1), u32 = new Uint32Array(f16.buffer);
function packFloat(value, exponentBits, mantissaBits) {
  const bias = (1 << (exponentBits - 1)) - 1, maxExponent = (1 << exponentBits) - 2;
  if (!(value > 0)) return 0;
  f16[0] = value;
  let e = ((u32[0] >> 23) & 0xff) - 127 + bias, m = u32[0] & 0x7fffff;
  if (e > maxExponent) return (maxExponent << mantissaBits) | ((1 << mantissaBits) - 1);
  if (e <= 0) return 0;
  m >>= 23 - mantissaBits;
  return (e << mantissaBits) | m;
}
export function packR11G11B10(r, g, b) {
  return (packFloat(r, 5, 6) | (packFloat(g, 5, 6) << 11) | (packFloat(b, 5, 5) << 22)) >>> 0;
}
