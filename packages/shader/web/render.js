// The WebGL2 side of exact-shader: one full-canvas triangle whose fragment shader is the app's, translated by sksl.js.
import { toGLSL, parse } from './sksl.js';

const VERTEX = `#version 300 es
void main() { gl_Position = vec4(float((gl_VertexID << 1) & 2) * 2.0 - 1.0, float(gl_VertexID & 2) * 2.0 - 1.0, 0.0, 1.0); }`;

export class ShaderRenderer {
  constructor(canvas, source) {
    this.declared = parse(source);
    const gl = this.gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is not available');
    const compile = (type, code) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, code); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`the shader did not compile: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const program = this.program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, toGLSL(source)));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`the shader did not link: ${gl.getProgramInfoLog(program)}`);
    this.at = name => gl.getUniformLocation(program, name);
    this.textures = new Map();
    gl.disable(gl.BLEND);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  /** Make `bitmap` (premultiplied, top row first) the image `name`. */
  setImage(name, bitmap) {
    const gl = this.gl;
    const texture = this.textures.get(name)?.texture ?? gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // No mips: texelFetch on a texture whose default minification filter wants them reads zero.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    this.textures.set(name, { texture, w: bitmap.width, h: bitmap.height });
  }

  size(name) { const t = this.textures.get(name); return t ? [t.w, t.h] : null; }

  /** Draw: `box` in points, `placements` and `tiles` by image name, `values` by uniform name (arrays of floats). */
  draw({ box, placements, tiles, values }) {
    const gl = this.gl, canvas = gl.canvas;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(this.program);
    gl.uniform2f(this.at('exact_box'), box[0], box[1]);
    gl.uniform2f(this.at('exact_view'), canvas.width, canvas.height);
    this.declared.shaders.forEach((name, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, this.textures.get(name).texture);
      gl.uniform1i(this.at(name), unit);
      gl.uniform4fv(this.at(`${name}_m`), placements[name]);
      gl.uniform1f(this.at(`${name}_tile`), tiles[name] === 'clamp' ? 1 : 0);
    });
    for (const { name, size } of this.declared.floats) {
      const v = values[name] ?? new Array(size).fill(0);
      gl[`uniform${size}fv`](this.at(name), v);
    }
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  destroy() {
    for (const { texture } of this.textures.values()) this.gl.deleteTexture(texture);
    this.gl.deleteProgram(this.program);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
