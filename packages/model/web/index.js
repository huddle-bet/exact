// @exact/model on the web: `exact-model`, a binary glTF (`source`) drawn with WebGL2 in a canvas that
// fills its box: lit by directional `lights` and an image-based light (`environment`, a KTX 1
// cubemap as Filament's cmgen writes it; a plain studio when absent), seen by a camera at
// `distance` or `viewFill`. See ../README.md for every prop; this file is its web side.
//
// - A pose prop (`yaw`, `pitch`, `roll`, `modelScale`, `offsetX`, `offsetY`) moves the model to it:
//   at once when `response` is absent or 0, else on a critically damped spring that settles in
//   about `response` ms, and `settled` runs when it has.
// - `tilt` (0..1) turns on the device's tilt: the model leans against the device's pitch and roll
//   through a spring (`tiltGain`, `tiltMaxDeg`, `tiltStiffness`, `tiltDamping`, `tiltRecenter`).
//   iOS Safari asks for the motion permission at the first touch.
// - `sway` (degrees) swings the model gently with period `swayMs`.
// - `textures` replace the picture on named nodes; `hiddenNodes` leaves named nodes out; `sheen`
//   draws moving light bands over the nodes that show a picture.
// - `load` runs once the model has drawn; `failed` runs with the reason when the model, the light
//   or a picture cannot be read or WebGL2 is missing.
import { parseGLB, bounds } from './glb.js';
import { parseKTX, studioLight } from './ktx.js';
import { ModelRenderer } from './render.js';
import {
  DEG, TILT_DEFAULTS, cameraDistance, kelvinToLinear, lightDirection, newTilt, poseMatrix, sheenAlong, sheenCoord, springStep, sprung, swayAt, tiltStep,
} from './motion.js';

const num = (text, fallback) => { const v = text == null || text === '' ? NaN : Number(text); return Number.isFinite(v) ? v : fallback; };
const list = text => { try { const v = JSON.parse(text || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const SCREEN_W = 420, SCREEN_H = 912;

class ExactModel {
  constructor({ implementation, element, props, events, view }) {
    const doc = element.ownerDocument;
    this.events = events; this.view = view; this.implementation = implementation; this.element = element;
    element.style.position ||= 'relative';
    this.canvas = doc.createElement('canvas');
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none';
    element.append(this.canvas);
    this.pose = { yaw: 0, pitch: 0, roll: 0, scale: 1, x: 0, y: 0 };
    this.velocity = { yaw: 0, pitch: 0, roll: 0, scale: 0, x: 0, y: 0 };
    this.goal = { ...this.pose };
    this.tilt = newTilt(); this.tiltMix = 0; this.device = null;
    this.t0 = performance.now(); this.last = 0;
    this.loaded = false; this.told = false; this.drawnAfterLoad = 0;
    this.sources = { source: null, environment: undefined, textures: '' };
    this.props = {};
    this.ticket = 0;
    this.resize = new ResizeObserver(() => { this.sizeCanvas(); this.wake(); });
    this.resize.observe(element);
    this.sizeCanvas();
    this.visible = () => !doc.hidden;
    this.onVisibility = () => this.wake();
    doc.addEventListener('visibilitychange', this.onVisibility);
    this.setProps(props, true);
    implementation?.made(view, this);
  }

  sizeCanvas() {
    const r = this.element.getBoundingClientRect(), dpr = Math.min(globalThis.devicePixelRatio || 1, 3);
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }

  fail(reason) {
    this.events.emit('failed', [String(reason?.message ?? reason)]);
  }

  setProps(props, first = false) {
    const p = this.props = props;
    const changed = k => first || props[k] !== this.last?.[k];
    if (changed('source') || changed('environment')) this.reload(p.source ?? '', p.environment);
    if (changed('textures') && this.renderer) this.loadPictures();
    if (changed('hiddenNodes')) this.hidden = new Set(list(p.hiddenNodes));
    if (changed('lights')) this.lights = list(p.lights).filter(l => l && [l.yaw, l.pitch, l.intensity, l.kelvin].every(Number.isFinite));
    if (changed('sheen')) this.sheen = list(p.sheen).filter(b => b && [b.at, b.width, b.peak].every(Number.isFinite));
    const aim = {
      yaw: num(p.yaw, 0) * DEG, pitch: num(p.pitch, 0) * DEG, roll: num(p.roll, 0) * DEG,
      scale: num(p.modelScale, 1), x: num(p.offsetX, 0), y: num(p.offsetY, 0),
    };
    this.response = Math.max(0, num(p.response, 0));
    const moved = Object.keys(aim).some(k => aim[k] !== this.goal[k]);
    this.goal = aim;
    if (this.response === 0 || first) { Object.assign(this.pose, aim); Object.assign(this.velocity, { yaw: 0, pitch: 0, roll: 0, scale: 0, x: 0, y: 0 }); }
    else if (moved) this.unsettled = true;
    this.tiltMix = Math.max(0, Math.min(1, num(p.tilt, 0)));
    this.tiltCfg = {
      gain: num(p.tiltGain, TILT_DEFAULTS.gain), maxDeg: num(p.tiltMaxDeg, TILT_DEFAULTS.maxDeg), stiffness: num(p.tiltStiffness, TILT_DEFAULTS.stiffness),
      damping: num(p.tiltDamping, TILT_DEFAULTS.damping), recenter: num(p.tiltRecenter, TILT_DEFAULTS.recenter),
    };
    this.swayDeg = num(p.sway, 0); this.swayMs = num(p.swayMs, 5200);
    if (first && this.swayDeg) this.swayFrom = performance.now();
    if (this.tiltMix > 0) this.listenTilt();
    this.last = { ...props };
    this.wake();
  }

  async reload(source, environment) {
    const ticket = ++this.ticket;
    this.loaded = false; this.told = false; this.drawnAfterLoad = 0;
    try {
      if (!source) throw new Error('`source` names no model');
      const get = async what => {
        const res = await fetch(new URL(what, this.element.ownerDocument.baseURI));
        if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`);
        return res.arrayBuffer();
      };
      const [glb, ktx] = await Promise.all([get(source), environment ? get(environment) : null]);
      if (ticket !== this.ticket) return;
      const doc = parseGLB(glb);
      const light = ktx ? parseKTX(ktx) : studioLight();
      this.renderer?.destroy();
      this.canvas.replaceWith(this.canvas = this.canvas.cloneNode());
      this.sizeCanvas();
      this.renderer = new ModelRenderer(this.canvas, doc);
      this.renderer.setLight(light);
      const b = bounds(doc);
      this.bounds = { half: (b.max[1] - b.min[1]) / 2, front: b.max[2] };
      await this.renderer.loadTextures();
      await this.loadPictures();
      if (ticket !== this.ticket) return;
      this.loaded = true;
      this.wake();
    } catch (error) {
      if (ticket === this.ticket) this.fail(error);
    }
  }

  async loadPictures() {
    const r = this.renderer, wanted = list(this.props.textures).filter(t => t && typeof t.node === 'string' && typeof t.source === 'string');
    const key = JSON.stringify(wanted);
    if (key === this.sources.textures) return;
    this.sources.textures = key;
    for (const name of [...r.overrides.keys()]) if (!wanted.some(t => t.node === name)) r.clearPicture(name);
    await Promise.all(wanted.map(async t => {
      try {
        const res = await fetch(new URL(t.source, this.element.ownerDocument.baseURI));
        if (!res.ok) throw new Error(`${t.source}: HTTP ${res.status}`);
        const bitmap = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' });
        if (this.sources.textures !== key) return;
        r.setPicture(t.node, bitmap);
        bitmap.close?.();
      } catch (error) { this.fail(error); }
    }));
    this.wake();
  }

  listenTilt() {
    if (this.device) return;
    const on = ev => {
      if (ev.beta == null || ev.gamma == null) return;
      this.device = { pitch: ev.beta * DEG, roll: ev.gamma * DEG };
      this.wake();
    };
    this.deviceHandler = on;
    const ask = async () => {
      try {
        const permit = globalThis.DeviceOrientationEvent?.requestPermission;
        if (permit && (await permit.call(globalThis.DeviceOrientationEvent)) !== 'granted') return;
        globalThis.addEventListener('deviceorientation', on);
      } catch { /* the page may not ask */ }
    };
    if (globalThis.DeviceOrientationEvent?.requestPermission) {
      const once = () => { globalThis.removeEventListener('pointerdown', once); ask(); };
      globalThis.addEventListener('pointerdown', once);
      this.deviceOnce = once;
    } else globalThis.addEventListener('deviceorientation', on);
    this.device = { pitch: 0, roll: 0, idle: true };
  }

  animating() {
    return this.unsettled || (this.tiltMix > 0 && this.device && !this.device.idle) || this.swayDeg !== 0 || this.tiltLeft;
  }

  wake() {
    if (this.frame || !this.visible()) return;
    this.frame = requestAnimationFrame(now => { this.frame = 0; this.tick(now); });
  }

  tick(now) {
    if (!this.renderer || !this.loaded) return;
    const dt = this.last_t ? Math.min((now - this.last_t) / 1000, 0.1) : 1 / 60;
    this.last_t = now;
    const pose = this.pose, goal = this.goal, v = this.velocity;
    if (this.unsettled) {
      let off = false;
      for (const k of Object.keys(goal)) {
        [pose[k], v[k]] = springStep(pose[k], v[k], goal[k], this.response, dt);
        const limit = k === 'yaw' || k === 'pitch' || k === 'roll' ? 0.012 : k === 'scale' ? 0.006 : 0.0005;
        if (!sprung(pose[k], v[k], goal[k], this.response, limit)) off = true;
      }
      if (!off) { Object.assign(pose, goal); Object.assign(v, { yaw: 0, pitch: 0, roll: 0, scale: 0, x: 0, y: 0 }); this.unsettled = false; this.events.emit('settled', []); }
    }
    let leanPitch = 0, leanYaw = 0;
    if (this.tiltMix > 0 && this.device && !this.device.idle) {
      tiltStep(this.tilt, this.device.pitch, this.device.roll, dt, this.tiltCfg);
      leanPitch = this.tilt.pitch * this.tiltMix; leanYaw = this.tilt.yaw * this.tiltMix;
    } else if (this.tilt.ready) {
      this.tilt.ready = false;
    }
    const sway = this.swayDeg ? swayAt(now - (this.swayFrom ??= now), this.swayMs) : 0;
    const yaw = pose.yaw + leanYaw + sway * this.swayDeg * DEG;
    const pitch = pose.pitch + leanPitch - 0.4 * sway * this.swayDeg * DEG;
    const p = this.props, fov = num(p.fov, 24), b = this.bounds ?? { half: 0.1, front: 0 };
    const distance = cameraDistance({ distance: num(p.distance, NaN), fit: num(p.viewFill, 0.74), fov, half: b.half, front: b.front });
    const scene = {
      pose: poseMatrix(pitch, yaw, pose.roll, pose.scale, pose.x, pose.y), fov, distance,
      ambient: num(p.ambient, 0.77), hidden: this.hidden ?? new Set(),
      lights: (this.lights ?? []).map(l => ({ direction: lightDirection(l.yaw, l.pitch), color: kelvinToLinear(l.kelvin).map(c => c * l.intensity) })),
      sheen: this.sheen?.length ? {
        weight: num(p.sheenStrength, 1), wu: (SCREEN_W * SCREEN_W) / (SCREEN_W * SCREEN_W + SCREEN_H * SCREEN_H),
        bands: this.sheen.map(s => [sheenAlong(s.at, num(p.sheenRest, 0), num(p.sheenYaw, 0), num(p.sheenPitch, 0), yaw - goal.yaw, pitch - goal.pitch), s.width, s.peak]),
      } : null,
    };
    this.renderer.draw(scene);
    this.drawn = { yaw, pitch };
    if (!this.told && ++this.drawnAfterLoad >= 2) { this.told = true; this.events.load(); }
    if (this.animating() || !this.told) this.wake();
  }

  destroy() {
    this.ticket++;
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.element.ownerDocument.removeEventListener('visibilitychange', this.onVisibility);
    if (this.deviceHandler) globalThis.removeEventListener('deviceorientation', this.deviceHandler);
    if (this.deviceOnce) globalThis.removeEventListener('pointerdown', this.deviceOnce);
    this.renderer?.destroy();
    this.implementation?.gone(this.view);
    this.canvas.remove();
  }
}

export const roster = { 'exact-model': { view: ExactModel } };

/** The session's models for `state.extensions`: whether each has drawn and the pose it showed last. */
export function implementation() {
  const models = new Map();
  return {
    made(view, model) { models.set(view, model); },
    gone(view) { models.delete(view); },
    state() {
      return { models: [...models].map(([view, m]) => ({ view: Number(view), loaded: m.told === true, yaw: m.drawn?.yaw ?? 0, pitch: m.drawn?.pitch ?? 0 })) };
    },
  };
}
