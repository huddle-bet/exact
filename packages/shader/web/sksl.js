const FLOATS = { float: 1, float2: 2, float3: 3, float4: 4, half: 1, half2: 2, half3: 3, half4: 4 };

/** The declarations of `source`: its images, its numeric uniforms with their sizes, and the body left over. */
export function parse(source) {
  const text = String(source).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
  const shaders = [], floats = [];
  const body = text.replace(/^[ \t]*uniform[ \t]+(\w+)[ \t]+(\w+)[ \t]*;[ \t]*$/gm, (_, type, name) => {
    if (shaders.includes(name) || floats.some(f => f.name === name)) throw new Error(`uniform \`${name}\` is declared twice`);
    if (type === 'shader') shaders.push(name);
    else if (FLOATS[type]) floats.push({ name, size: FLOATS[type] });
    else throw new Error(`uniform \`${name}\` has type \`${type}\`; exact-shader takes shader, float, float2..4 and half, half2..4`);
    return '';
  });
  if (/\buniform\b/.test(body)) throw new Error('a uniform is declared one to a line, as `uniform float2 center;`');
  if (!/\b(half4|float4)\s+main\s*\(\s*float2\s+\w+\s*\)/.test(body)) throw new Error('the source needs `half4 main(float2 p)`');
  return { shaders, floats, body };
}

/** The GLSL ES 3.00 fragment shader for `source`; `exact_box` and `exact_view` are the box in points and the canvas in pixels. */
export function toGLSL(source) {
  const { shaders, floats, body } = parse(source);
  let code = body
    .replace(/\b(float|half)([234])x\2\b/g, 'mat$2')
    .replace(/\b(float|half)([234])\b/g, 'vec$2')
    .replace(/\bhalf\b/g, 'float')
    .replace(/\bmain\b/g, 'exact_main');
  for (const name of shaders) code = code.replace(new RegExp(`\\b${name}\\.eval\\(`, 'g'), `${name}_eval(`);
  const images = shaders.map(name => `uniform sampler2D ${name};
uniform vec4 ${name}_m;
uniform float ${name}_tile;
vec4 ${name}_eval(vec2 p) { return exact_sample(${name}, ${name}_m, ${name}_tile, p); }`).join('\n');
  const values = floats.map(f => `uniform ${f.size === 1 ? 'float' : `vec${f.size}`} ${f.name};`).join('\n');
  return `#version 300 es
precision highp float;
precision highp int;
uniform vec2 exact_box;
uniform vec2 exact_view;
out vec4 exact_out;
vec4 exact_texel(sampler2D t, ivec2 c, ivec2 n, float tile) {
  if (tile > 0.5) return texelFetch(t, clamp(c, ivec2(0), n - 1), 0);
  if (c.x < 0 || c.y < 0 || c.x >= n.x || c.y >= n.y) return vec4(0.0);
  return texelFetch(t, c, 0);
}
vec4 exact_sample(sampler2D t, vec4 m, float tile, vec2 p) {
  ivec2 n = textureSize(t, 0);
  vec2 q = (p * m.xy + m.zw) * vec2(n) - 0.5;
  vec2 b = floor(q), f = q - b;
  ivec2 c = ivec2(b);
  return mix(mix(exact_texel(t, c, n, tile), exact_texel(t, c + ivec2(1, 0), n, tile), f.x),
             mix(exact_texel(t, c + ivec2(0, 1), n, tile), exact_texel(t, c + ivec2(1, 1), n, tile), f.x), f.y);
}
${images}
${values}
${code}
void main() {
  vec2 p = vec2(gl_FragCoord.x, exact_view.y - gl_FragCoord.y) * exact_box / exact_view;
  exact_out = exact_main(p);
}
`;
}

/** The map from box points to an image's texture coordinates: `uv = p * [0..1] + [2..3]`, for sizing cover, contain or fill. */
export function placement(sizing, box, image) {
  const [w, h] = box, [iw, ih] = image;
  const sx = sizing === 'fill' ? w / iw : (sizing === 'contain' ? Math.min : Math.max)(w / iw, h / ih);
  const sy = sizing === 'fill' ? h / ih : sx;
  const ox = (w - iw * sx) / 2, oy = (h - ih * sy) / 2;
  return [1 / (sx * iw), 1 / (sy * ih), -ox / (sx * iw), -oy / (sy * ih)];
}
