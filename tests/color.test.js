import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rgbToLab, rgbToHsi, erythemaIndex, srgbToLin, linToSrgb, signedHue, highHueRatio, percentile } from '../src/color.js';

const gold = JSON.parse(readFileSync(new URL('./golden.json', import.meta.url)));
const TOL = gold.tolerance.default, TOL_LAB = gold.tolerance.lab;
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (допуск ${tol})`);

test('Lab совпадает с Python/OpenCV (допуск 0,2)', () => {
  for (const p of gold.pixels) {
    const [r, g, b] = p.rgb.map((x) => x / 255);
    rgbToLab(r, g, b).forEach((v, i) => close(v, p.lab[i], TOL_LAB, `Lab[${i}] ${p.rgb}`));
  }
});

test('HSI совпадает с Python (допуск 1e-3, H в градусах — 0,05°)', () => {
  for (const p of gold.pixels) {
    const [r, g, b] = p.rgb.map((x) => x / 255);
    const [H, S, I] = rgbToHsi(r, g, b);
    close(H, p.hsi[0], 0.05, `H ${p.rgb}`);
    close(S, p.hsi[1], TOL, `S ${p.rgb}`);
    close(I, p.hsi[2], TOL, `I ${p.rgb}`);
  }
});

test('EI совпадает с Python', () => {
  for (const p of gold.pixels) close(erythemaIndex(p.rgb[0] / 255, p.rgb[1] / 255), p.ei, TOL, `EI ${p.rgb}`);
});

test('sRGB ↔ линейный: обратимость', () => {
  for (let x = 0; x <= 1; x += 0.05) close(linToSrgb(srgbToLin(x)), x, 1e-9, `x=${x}`);
});

test('оттенок: красный не рвётся на 0/360', () => {
  assert.equal(signedHue(350), -10);
  assert.equal(signedHue(10), 10);
  assert.equal(highHueRatio([355, 5, 120, 200]), 0.5);
});

test('перцентиль как numpy (линейная интерполяция)', () => {
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  close(percentile([1, 2, 3, 4], 3), 1.09, 1e-12, 'p3');
  assert.ok(Number.isNaN(percentile([], 50)));
});
