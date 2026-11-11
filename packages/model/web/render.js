import { drawables, imageBlob, readAccessor, multiply } from './glb.js';
import { DEG } from './motion.js';

const VERT = `#version 300 es
in vec3 aPos; in vec3 aNormal; in vec2 aUv;
uniform mat4 uModel; uniform mat4 uViewProj; uniform mat3 uNormalMat;
out vec3 vPos; out vec3 vNormal; out vec2 vUv;
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vPos = world.xyz; vNormal = uNormalMat * aNormal; vUv = aUv;
  gl_Position = uViewProj * world;
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 vPos; in vec3 vNormal; in vec2 vUv;
uniform vec3 uCam;
uniform vec4 uBase; uniform float uMetal; uniform float uRough; uniform vec3 uEmissive;
uniform float uNormalScale; uniform float uOcc; uniform float uClear; uniform float uClearRough;
uniform int uUnlit; uniform int uBlend; uniform int uHas;
uniform sampler2D tBase; uniform sampler2D tMR; uniform sampler2D tNormal; uniform sampler2D tOcc; uniform sampler2D tEmis;
uniform samplerCube tEnv; uniform float uLodMax; uniform float uAmbient; uniform vec3 uSH[9];
uniform vec3 uLightDir[4]; uniform vec3 uLightColor[4]; uniform int uLights;
uniform vec4 uSheen[4]; uniform int uSheenCount; uniform float uSheenWeight; uniform float uSheenWu;
out vec4 outColor;
const float PI = 3.14159265359;

vec3 irradianceSH(vec3 n) {
  return max(uSH[0] + uSH[1] * n.y + uSH[2] * n.z + uSH[3] * n.x + uSH[4] * (n.y * n.x) + uSH[5] * (n.y * n.z)
    + uSH[6] * (3.0 * n.z * n.z - 1.0) + uSH[7] * (n.z * n.x) + uSH[8] * (n.x * n.x - n.y * n.y), 0.0);
}
float dGGX(float NoH, float a) { float a2 = a * a; float d = NoH * NoH * (a2 - 1.0) + 1.0; return a2 / (PI * d * d); }
float vSmith(float NoV, float NoL, float a) {
  float a2 = a * a;
  float gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  float gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}
vec3 fSchlick(vec3 f0, float VoH) { return f0 + (1.0 - f0) * pow(1.0 - VoH, 5.0); }
vec2 dfgApprox(float rough, float NoV) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = rough * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  return vec2(-1.04, 1.04) * a004 + r.zw;
}
vec3 perturb(vec3 n, vec3 p, vec2 uv, vec3 tn) {
  vec3 dp1 = dFdx(p); vec3 dp2 = dFdy(p); vec2 duv1 = dFdx(uv); vec2 duv2 = dFdy(uv);
  vec3 dp2perp = cross(dp2, n); vec3 dp1perp = cross(n, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x; vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float invmax = inversesqrt(max(max(dot(T, T), dot(B, B)), 1e-12));
  return normalize(mat3(T * invmax, B * invmax, n) * tn);
}
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 oetf(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

void main() {
  vec4 base = uBase;
  if ((uHas & 1) != 0) base *= texture(tBase, vUv);
  if (uUnlit == 1) {
    vec3 c = base.rgb;
    for (int i = 0; i < 4; i++) {
      if (i >= uSheenCount) break;
      float along = uSheen[i].w;
      float t = (uSheenWu * (vUv.x + 1.0 - along) + (1.0 - uSheenWu) * (vUv.y + 1.0 - along)) / 3.0;
      float a = uSheen[i].z * uSheenWeight * max(0.0, 1.0 - abs(t - 0.5) / (uSheen[i].y * 0.5));
      c = mix(c, vec3(1.0), clamp(a, 0.0, 1.0));
    }
    outColor = vec4(oetf(c) * base.a, base.a);
    return;
  }
  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  if ((uHas & 4) != 0) {
    vec3 tn = texture(tNormal, vUv).xyz * 2.0 - 1.0; tn.xy *= uNormalScale;
    N = perturb(N, vPos, vUv, normalize(tn));
  }
  vec3 V = normalize(uCam - vPos);
  float NoV = max(dot(N, V), 1e-4);
  float rough = uRough, metal = uMetal;
  if ((uHas & 2) != 0) { vec4 mr = texture(tMR, vUv); rough *= mr.g; metal *= mr.b; }
  float pr = clamp(rough, 0.045, 1.0); float a = pr * pr;
  float ao = 1.0;
  if ((uHas & 8) != 0) ao = 1.0 + uOcc * (texture(tOcc, vUv).r - 1.0);
  vec3 f0 = mix(vec3(0.04), base.rgb, metal);
  vec3 diffuse = base.rgb * (1.0 - metal);
  float clear = uClear; float cpr = clamp(uClearRough, 0.045, 1.0); float ca = cpr * cpr;
  vec3 color = vec3(0.0);
  float cAtten = 1.0;
  for (int i = 0; i < 4; i++) {
    if (i >= uLights) break;
    vec3 L = -uLightDir[i];
    float NoL = max(dot(N, L), 0.0);
    if (NoL <= 0.0) continue;
    vec3 H = normalize(V + L);
    float NoH = max(dot(N, H), 0.0); float VoH = max(dot(V, H), 0.0);
    vec3 Fr = dGGX(NoH, a) * vSmith(NoV, NoL, a) * fSchlick(f0, VoH);
    float Fc = clear * fSchlick(vec3(0.04), VoH).x;
    vec3 Frc = vec3(dGGX(NoH, ca) * vSmith(NoV, NoL, ca) * Fc);
    vec3 Fd = diffuse / PI;
    color += ((Fd + Fr) * (1.0 - Fc) + Frc) * uLightColor[i] * NoL;
  }
  vec3 R = reflect(-V, N);
  vec2 dfg = dfgApprox(pr, NoV);
  vec3 specular = textureLod(tEnv, R, uLodMax * pr).rgb * (f0 * dfg.x + dfg.y);
  float Fci = clear * (0.04 + 0.96 * pow(1.0 - NoV, 5.0));
  vec3 coat = textureLod(tEnv, R, uLodMax * cpr).rgb * Fci;
  vec3 ibl = (irradianceSH(N) * diffuse + specular) * (1.0 - Fci) + coat;
  color += ibl * uAmbient * ao;
  if ((uHas & 16) != 0) color += texture(tEmis, vUv).rgb * uEmissive;
  else color += uEmissive;
  float alpha = uBlend == 1 ? base.a : 1.0;
  outColor = vec4(oetf(aces(color)) * alpha, alpha);
}`;

const WRAP = { 33071: 'CLAMP_TO_EDGE', 33648: 'MIRRORED_REPEAT', 10497: 'REPEAT' };

function compile(gl, type, source) {
  const s = gl.createShader(type);
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`exact-model shader: ${gl.getShaderInfoLog(s)}`);
  return s;
}

export function perspective(fovRad, aspect, near, far) {
  const f = 1 / Math.tan(fovRad / 2), nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}

function normalMatrix(m) {
  const [a, b, c, d, e, f, g, h, i] = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C || 1;
  return [A / det, B / det, C / det, (c * h - b * i) / det, (a * i - c * g) / det, (b * g - a * h) / det, (b * f - c * e) / det, (c * d - a * f) / det, (a * e - b * d) / det];
}

export class ModelRenderer {
  constructor(canvas, doc) {
    this.canvas = canvas;
    this.doc = doc;
    this.gl = canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: true });
    if (!this.gl) throw new Error('WebGL2 is not available');
    const gl = this.gl;
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(program, 0, 'aPos'); gl.bindAttribLocation(program, 1, 'aNormal'); gl.bindAttribLocation(program, 2, 'aUv');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`exact-model program: ${gl.getProgramInfoLog(program)}`);
    this.program = program;
    this.u = new Proxy({}, { get: (cache, name) => (name in cache ? cache[name] : (cache[name] = gl.getUniformLocation(program, name))) });
    this.textures = new Map();
    this.overrides = new Map();
    this.white = this.solid([255, 255, 255, 255]);
    this.items = this.build(doc);
  }

  solid(rgba) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba));
    return t;
  }

  build(doc) {
    const gl = this.gl, items = [];
    const meshes = new Map();
    for (const d of drawables(doc)) {
      const prim = doc.json.meshes[d.mesh].primitives[d.primitive];
      if ((prim.mode ?? 4) !== 4) continue;
      const key = `${d.mesh}:${d.primitive}`;
      if (!meshes.has(key)) {
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        const attr = (name, loc, width, fallback) => {
          const index = prim.attributes[name];
          const buffer = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
          if (index === undefined) { gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(fallback), gl.STATIC_DRAW); }
          else { const a = readAccessor(doc, index); gl.bufferData(gl.ARRAY_BUFFER, a.array, gl.STATIC_DRAW); }
          gl.enableVertexAttribArray(loc);
          gl.vertexAttribPointer(loc, width, gl.FLOAT, false, 0, 0);
        };
        const pos = readAccessor(doc, prim.attributes.POSITION);
        attr('POSITION', 0, 3);
        attr('NORMAL', 1, 3, new Array(pos.count * 3).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0)));
        attr('TEXCOORD_0', 2, 2, new Array(pos.count * 2).fill(0));
        let count = pos.count, type = null;
        if (prim.indices !== undefined) {
          const idx = readAccessor(doc, prim.indices);
          const buffer = gl.createBuffer();
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer);
          gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx.array, gl.STATIC_DRAW);
          count = idx.count;
          type = idx.array instanceof Uint32Array ? gl.UNSIGNED_INT : idx.array instanceof Uint16Array ? gl.UNSIGNED_SHORT : null;
          if (type === null) throw new Error('a byte index is not read');
        }
        gl.bindVertexArray(null);
        const a = doc.json.accessors[prim.attributes.POSITION];
        const mid = a.min && a.max ? [0, 1, 2].map(k => (a.min[k] + a.max[k]) / 2) : [0, 0, 0];
        meshes.set(key, { vao, count, type, mid });
      }
      const mesh = meshes.get(key);
      const material = doc.json.materials?.[prim.material] ?? {};
      const pbr = material.pbrMetallicRoughness ?? {};
      const ext = material.extensions ?? {};
      const mid = mesh.mid;
      items.push({
        d, mesh, normal: normalMatrix(d.world), model: d.world,
        center: [0, 1, 2].map(k => d.world[k] * mid[0] + d.world[4 + k] * mid[1] + d.world[8 + k] * mid[2] + d.world[12 + k]),
        base: pbr.baseColorFactor ?? [1, 1, 1, 1], metal: pbr.metallicFactor ?? 1, rough: pbr.roughnessFactor ?? 1,
        emissive: material.emissiveFactor ?? [0, 0, 0],
        normalScale: material.normalTexture?.scale ?? 1, occ: material.occlusionTexture?.strength ?? 1,
        clear: ext.KHR_materials_clearcoat?.clearcoatFactor ?? 0, clearRough: ext.KHR_materials_clearcoat?.clearcoatRoughnessFactor ?? 0,
        unlit: ext.KHR_materials_unlit !== undefined, blend: material.alphaMode === 'BLEND', double: !!material.doubleSided,
        tex: {
          base: pbr.baseColorTexture?.index, mr: pbr.metallicRoughnessTexture?.index, normal: material.normalTexture?.index,
          occ: material.occlusionTexture?.index, emissive: material.emissiveTexture?.index,
        },
      });
    }
    return items;
  }

  async loadTextures() {
    const gl = this.gl, { json } = this.doc;
    const wanted = new Map();
    for (const it of this.items) {
      for (const [slot, index] of Object.entries(it.tex)) if (index !== undefined) wanted.set(`${index}:${slot === 'base' || slot === 'emissive'}`, [index, slot === 'base' || slot === 'emissive']);
    }
    await Promise.all([...wanted].map(async ([key, [index, srgb]]) => {
      const texture = json.textures[index], blob = imageBlob(this.doc, texture.source);
      const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' });
      this.textures.set(key, this.upload(bitmap, srgb, json.samplers?.[texture.sampler ?? -1]));
      bitmap.close?.();
    }));
  }

  upload(source, srgb, sampler = {}, existing = null) {
    const gl = this.gl, t = existing ?? gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl[WRAP[sampler.wrapS] ?? 'REPEAT']);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl[WRAP[sampler.wrapT] ?? 'REPEAT']);
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 4);
    return t;
  }

  setPicture(name, bitmap) {
    const had = this.overrides.get(name);
    this.overrides.set(name, this.upload(bitmap, true, { wrapS: 33071, wrapT: 33071 }, had ?? null));
  }
  clearPicture(name) {
    const t = this.overrides.get(name);
    if (t) this.gl.deleteTexture(t);
    this.overrides.delete(name);
  }

  setLight(light) {
    const gl = this.gl;
    if (this.env) gl.deleteTexture(this.env);
    const env = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, env);
    light.mips.forEach((mip, level) => mip.texels.forEach((texels, face) => {
      gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, level, gl.R11F_G11F_B10F, mip.size, mip.size, 0, gl.RGB, gl.UNSIGNED_INT_10F_11F_11F_REV, texels);
    }));
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAX_LEVEL, light.mips.length - 1);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    this.env = env;
    this.lodMax = light.mips.length - 1;
    this.sh = light.sh.flat();
  }

  draw(scene) {
    const gl = this.gl, { canvas } = this;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.env) return 0;
    gl.useProgram(this.program);
    const u = this.u, aspect = canvas.width / Math.max(1, canvas.height);
    const proj = perspective(scene.fov * DEG, aspect, 0.01, 10);
    const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -scene.distance, 1];
    gl.uniformMatrix4fv(u.uViewProj, false, multiply(proj, view));
    gl.uniform3f(u.uCam, 0, 0, scene.distance);
    gl.uniform1f(u.uAmbient, scene.ambient);
    gl.uniform1f(u.uLodMax, this.lodMax);
    gl.uniform3fv(u['uSH[0]'], this.sh);
    const lights = scene.lights.slice(0, 4);
    gl.uniform1i(u.uLights, lights.length);
    if (lights.length) {
      gl.uniform3fv(u['uLightDir[0]'], lights.flatMap(l => l.direction));
      gl.uniform3fv(u['uLightColor[0]'], lights.flatMap(l => l.color));
    }
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.env);
    gl.uniform1i(u.tEnv, 5);
    for (const [k, name] of ['tBase', 'tMR', 'tNormal', 'tOcc', 'tEmis'].entries()) gl.uniform1i(u[name], k);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    const visible = this.items.filter(it => !it.d.chain.some(n => scene.hidden.has(n)));
    const depth = it => { const m = scene.pose; return m[2] * it.center[0] + m[6] * it.center[1] + m[10] * it.center[2] + m[14]; };
    const opaque = visible.filter(it => !it.blend), blended = visible.filter(it => it.blend).sort((a, b) => depth(a) - depth(b));
    let drawn = 0;
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    for (const it of opaque) drawn += this.drawItem(it, scene);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    for (const it of blended) drawn += this.drawItem(it, scene);
    gl.depthMask(true);
    return drawn;
  }

  drawItem(it, scene) {
    const gl = this.gl, u = this.u, pose = scene.pose;
    gl.uniformMatrix4fv(u.uModel, false, multiply(pose, it.model));
    const n = normalMatrix(multiply(pose, it.model));
    gl.uniformMatrix3fv(u.uNormalMat, false, n);
    gl.uniform4fv(u.uBase, it.base);
    gl.uniform1f(u.uMetal, it.metal); gl.uniform1f(u.uRough, it.rough);
    gl.uniform3fv(u.uEmissive, it.emissive);
    gl.uniform1f(u.uNormalScale, it.normalScale); gl.uniform1f(u.uOcc, it.occ);
    gl.uniform1f(u.uClear, it.clear); gl.uniform1f(u.uClearRough, it.clearRough);
    gl.uniform1i(u.uUnlit, it.unlit ? 1 : 0); gl.uniform1i(u.uBlend, it.blend ? 1 : 0);
    let has = 0;
    const bind = (unit, bit, key, slot, srgb) => {
      const t = key ?? this.textures.get(`${it.tex[slot]}:${srgb}`);
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t ?? this.white);
      if (t) has |= bit;
    };
    const picture = it.d.chain.map(name => this.overrides.get(name)).find(Boolean);
    bind(0, 1, picture, 'base', true);
    if (picture) has |= 1;
    bind(1, 2, null, 'mr', false); bind(2, 4, null, 'normal', false); bind(3, 8, null, 'occ', false); bind(4, 16, null, 'emissive', true);
    gl.uniform1i(u.uHas, has);
    const sheen = scene.sheen;
    const onScreen = sheen && it.unlit && (picture || it.tex.base !== undefined);
    gl.uniform1i(u.uSheenCount, onScreen ? sheen.bands.length : 0);
    if (onScreen) {
      gl.uniform1f(u.uSheenWeight, sheen.weight);
      gl.uniform1f(u.uSheenWu, sheen.wu);
      gl.uniform4fv(u['uSheen[0]'], sheen.bands.flatMap(([along, width, peak]) => [0, width, peak, along]));
    }
    if (it.double) gl.disable(gl.CULL_FACE); else gl.enable(gl.CULL_FACE);
    gl.bindVertexArray(it.mesh.vao);
    if (it.mesh.type) gl.drawElements(gl.TRIANGLES, it.mesh.count, it.mesh.type, 0);
    else gl.drawArrays(gl.TRIANGLES, 0, it.mesh.count);
    return 1;
  }

  destroy() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
