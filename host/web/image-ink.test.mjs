// The web's image ink must equal the Apple hosts' (ImageInkTests.swift): the same shapes give the same numbers. The bug
// each catches: a cut-out read as full frame, or the reverse, which draws a plate where the app wants none.
import { expect, test } from "bun:test";
import { measure } from "./image-ink.js";

const image = (w, h, rects) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (const [rx, ry, rw, rh] of rects) for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) data[(y * w + x) * 4 + 3] = 255;
  return [data, w, h];
};

test("a full-frame image fills its box", () => {
  expect(measure(...image(100, 100, [[0, 0, 100, 100]]))).toEqual([0, 0, 1, 1, 1, 0, 0, 1]);
});

test("a cut-out reports its ink, its hull's share, its solid top and its foot", () => {
  const m = measure(...image(100, 100, [[40, 10, 20, 30], [20, 40, 60, 60]]));
  expect(m.slice(0, 4)).toEqual([0.2, 0.1, 0.8, 1]);
  expect(m[4]).toBe(0.889);
  expect(m.slice(5)).toEqual([0.1, 0.2, 0.8]);
});

test("faint pixels are not ink and half-clear pixels are not solid", () => {
  const [data, w, h] = image(10, 10, [[0, 0, 10, 10]]);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 10; x++) data[(y * w + x) * 4 + 3] = y === 0 ? 23 : 128;
  const m = measure(data, w, h);
  expect([m[1], m[5]]).toEqual([0.1, 0.2]);
});

test("a clear image has no ink", () => {
  expect(measure(...image(40, 40, []))).toBeNull();
});
