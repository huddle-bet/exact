import { ShaderRenderer } from './render.js';
import { placement } from './sksl.js';

const list = text => { try { const v = JSON.parse(text || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

async function readAsset(implementation, base, path) {
  if (implementation?.asset) {
    const bytes = await implementation.asset(path);
    if (bytes != null) return bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  const res = await fetch(new URL(path, base));
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.arrayBuffer();
}

class ExactShader {
  constructor({ implementation, element, props, events, view }) {
    const doc = element.ownerDocument;
    this.events = events; this.view = view; this.implementation = implementation; this.element = element;
    element.style.position ||= 'relative';
    this.canvas = doc.createElement('canvas');
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none';
    element.append(this.canvas);
    this.ticket = 0; this.told = false; this.failures = new Set(); this.drawn = 0;
    this.sources = { source: null, images: '' };
    this.loadedImages = new Set();
    this.resize = new ResizeObserver(() => { this.sizeCanvas(); this.draw(); });
    this.resize.observe(element);
    this.sizeCanvas();
    this.setProps(props, true);
    implementation?.made(view, this);
  }

  sizeCanvas() {
    const r = this.element.getBoundingClientRect(), dpr = Math.min(globalThis.devicePixelRatio || 1, 3);
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.box = [r.width, r.height];
  }

  fail(reason) {
    const text = String(reason?.message ?? reason);
    if (this.failures.has(text)) return;
    this.failures.add(text);
    this.events.emit('failed', [text]);
  }

  setProps(props, first = false) {
    const before = this.props;
    const changed = k => first || props[k] !== before?.[k];
    this.props = props;
    if (changed('source')) this.rebuild(props.source ?? '');
    if (changed('images') || changed('source')) this.loadImages();
    if (changed('uniforms')) {
      this.values = {};
      for (const u of list(props.uniforms)) if (u && typeof u.name === 'string' && Array.isArray(u.value)) this.values[u.name] = u.value.map(Number);
    }
    this.draw();
  }

  rebuild(source) {
    this.renderer?.destroy();
    this.renderer = null; this.loadedImages = new Set(); this.sources.images = '';
    this.canvas.replaceWith(this.canvas = this.canvas.cloneNode());
    this.sizeCanvas();
    try { this.renderer = new ShaderRenderer(this.canvas, source); } catch (error) { this.fail(error); }
  }

  async loadImages() {
    const r = this.renderer;
    if (!r) return;
    const wanted = list(this.props.images).filter(i => i && typeof i.name === 'string' && typeof i.source === 'string');
    const key = JSON.stringify(wanted);
    if (key === this.sources.images) return;
    this.sources.images = key;
    this.wanted = wanted;
    for (const name of r.declared.shaders) if (!wanted.some(i => i.name === name)) this.fail(`the shader reads image \`${name}\`, which \`images\` does not list`);
    const ticket = ++this.ticket;
    await Promise.all(wanted.filter(i => r.declared.shaders.includes(i.name)).map(async i => {
      try {
        const bytes = await readAsset(this.implementation, this.element.ownerDocument.baseURI, i.source);
        const bitmap = await createImageBitmap(new Blob([bytes]), { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none', imageOrientation: 'none' });
        if (ticket !== this.ticket || r !== this.renderer) return;
        r.setImage(i.name, bitmap);
        bitmap.close?.();
        this.loadedImages.add(i.name);
      } catch (error) { this.fail(error); }
    }));
    if (ticket === this.ticket) this.draw();
  }

  draw() {
    const r = this.renderer;
    if (!r) return;
    const declared = r.declared, problems = [];
    for (const name of declared.shaders) if (!this.loadedImages.has(name)) return;
    const values = {};
    for (const [name, v] of Object.entries(this.values ?? {})) {
      const want = declared.floats.find(f => f.name === name);
      if (!want) problems.push(`uniform \`${name}\` is not declared by the shader`);
      else if (v.length !== want.size || v.some(n => !Number.isFinite(n))) problems.push(`uniform \`${name}\` takes ${want.size} finite number${want.size > 1 ? 's' : ''}`);
      else values[name] = v;
    }
    problems.forEach(p => this.fail(p));
    const placements = {}, tiles = {};
    for (const name of declared.shaders) {
      const spec = this.wanted.find(i => i.name === name);
      placements[name] = placement(spec.sizing || 'cover', this.box, r.size(name));
      tiles[name] = spec.tile === 'clamp' ? 'clamp' : 'decal';
    }
    r.draw({ box: this.box, placements, tiles, values });
    this.drawn++;
    if (!this.told) { this.told = true; this.events.load(); }
  }

  destroy() {
    this.ticket++;
    this.resize.disconnect();
    this.renderer?.destroy();
    this.implementation?.gone(this.view);
    this.canvas.remove();
  }
}

export const roster = { 'exact-shader': { view: ExactShader } };

/** The session's shaders for `state.extensions`: whether each has drawn, and how many times. */
export function implementation(context) {
  const shaders = new Map();
  return {
    asset: context?.asset,
    made(view, shader) { shaders.set(view, shader); },
    gone(view) { shaders.delete(view); },
    state() { return { shaders: [...shaders].map(([view, s]) => ({ view: Number(view), loaded: s.told === true, draws: s.drawn })) }; },
  };
}
