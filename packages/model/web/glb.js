// A binary glTF 2.0 file read into plain arrays: the scene's nodes with their world matrices, each
// mesh primitive's attributes and indices, and the document's materials, textures and images.
// What `exact-model` draws: triangle meshes with POSITION, NORMAL, TEXCOORD_0; no skins, morphs,
// animations or sparse accessors.

const MAGIC = 0x46546c67;
const COMPONENT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

export function parseGLB(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 20 || view.getUint32(0, true) !== MAGIC) throw new Error('not a binary glTF (glb) file');
  if (view.getUint32(4, true) !== 2) throw new Error('only glTF 2.0 is read');
  let json = null, bin = null;
  for (let at = 12; at + 8 <= buffer.byteLength;) {
    const length = view.getUint32(at, true), type = view.getUint32(at + 4, true);
    const body = buffer.slice(at + 8, at + 8 + length);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(body));
    else if (type === 0x004e4942 && !bin) bin = body;
    at += 8 + length + ((4 - (length % 4)) % 4);
  }
  if (!json) throw new Error('the glb has no JSON chunk');
  return { json, bin };
}

/** Accessor `index` as a packed typed array (stride removed), with its component count. */
export function readAccessor({ json, bin }, index) {
  const a = json.accessors[index];
  if (a.sparse) throw new Error('a sparse accessor is not read');
  const Type = COMPONENT[a.componentType], width = WIDTH[a.type];
  const out = new Type(a.count * width);
  if (a.bufferView === undefined) return { array: out, width, count: a.count, min: a.min, max: a.max, normalized: !!a.normalized };
  const bv = json.bufferViews[a.bufferView];
  const offset = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const size = Type.BYTES_PER_ELEMENT * width, stride = bv.byteStride || size;
  const src = new Uint8Array(bin, offset, stride * (a.count - 1) + size);
  const dst = new Uint8Array(out.buffer);
  for (let i = 0; i < a.count; i++) dst.set(src.subarray(i * stride, i * stride + size), i * size);
  return { array: out, width, count: a.count, min: a.min, max: a.max, normalized: !!a.normalized };
}

/** The bytes of image `index`: its mime type and a `Blob`. */
export function imageBlob({ json, bin }, index) {
  const image = json.images[index];
  if (image.bufferView === undefined) throw new Error('an image that is a uri is not read');
  const bv = json.bufferViews[image.bufferView];
  return new Blob([new Uint8Array(bin, bv.byteOffset ?? 0, bv.byteLength)], { type: image.mimeType });
}

// Column-major 4x4 matrices.
export const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function multiply(a, b) {
  const out = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return out;
}
export function fromTRS(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) {
  const [x, y, z, w] = q;
  return [
    (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
    2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
    2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}
const local = n => n.matrix ?? fromTRS(n.translation, n.rotation, n.scale);

/** Every mesh primitive of the default scene: its node's name, its chain of ancestor names, and
 * the node's world matrix. */
export function drawables({ json }) {
  const out = [];
  const walk = (index, parent, names) => {
    const n = json.nodes[index];
    const world = multiply(parent, local(n));
    const chain = n.name === undefined ? names : [...names, n.name];
    if (n.mesh !== undefined) json.meshes[n.mesh].primitives.forEach((primitive, p) => out.push({ node: index, primitive: p, name: n.name ?? '', chain, world, mesh: n.mesh }));
    for (const child of n.children ?? []) walk(child, world, chain);
  };
  const scene = json.scenes?.[json.scene ?? 0];
  for (const root of scene?.nodes ?? []) walk(root, identity(), []);
  return out;
}

/** The scene's bounds after the nodes' transforms: min, max, from the accessors' bounding boxes. */
export function bounds(doc) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const d of drawables(doc)) {
    const a = doc.json.accessors[doc.json.meshes[d.mesh].primitives[d.primitive].attributes.POSITION];
    if (!a.min || !a.max) continue;
    for (let corner = 0; corner < 8; corner++) {
      const p = [corner & 1 ? a.max[0] : a.min[0], corner & 2 ? a.max[1] : a.min[1], corner & 4 ? a.max[2] : a.min[2]];
      for (let k = 0; k < 3; k++) {
        const v = d.world[k] * p[0] + d.world[4 + k] * p[1] + d.world[8 + k] * p[2] + d.world[12 + k];
        min[k] = Math.min(min[k], v); max[k] = Math.max(max[k], v);
      }
    }
  }
  return { min, max };
}

/** The flat rectangle of the surfaces under node `name`, before any pose: the centre of their bounds,
 * and the half width (x) and half height (y), the rectangle facing +z. Null when no surface is named so. */
export function rectOf(doc, name) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const d of drawables(doc)) {
    if (!d.chain.includes(name)) continue;
    const a = doc.json.accessors[doc.json.meshes[d.mesh].primitives[d.primitive].attributes.POSITION];
    if (!a.min || !a.max) continue;
    for (let corner = 0; corner < 8; corner++) {
      const p = [corner & 1 ? a.max[0] : a.min[0], corner & 2 ? a.max[1] : a.min[1], corner & 4 ? a.max[2] : a.min[2]];
      for (let k = 0; k < 3; k++) {
        const v = d.world[k] * p[0] + d.world[4 + k] * p[1] + d.world[8 + k] * p[2] + d.world[12 + k];
        min[k] = Math.min(min[k], v); max[k] = Math.max(max[k], v);
      }
    }
  }
  if (!Number.isFinite(min[0])) return null;
  return { c: [0, 1, 2].map(k => (min[k] + max[k]) / 2), hw: (max[0] - min[0]) / 2, hh: (max[1] - min[1]) / 2 };
}
