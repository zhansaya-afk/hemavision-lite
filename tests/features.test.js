import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tissueMask, countMask, extractFeatures, whiteBalance } from '../src/features.js';

const gold = JSON.parse(readFileSync(new URL('./golden.json', import.meta.url)));
const { width, height } = gold.image;
const rgb = Float32Array.from(gold.image.rgb, (x) => x / 255);
const img = { rgb, width, height };
const lid = Uint8Array.from(gold.image.lid);
const sclera = Uint8Array.from(gold.image.sclera);
const E = gold.expected;
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (допуск ${tol})`);
const tolOf = (k) => (/^(L|a|b)_/.test(k) ? 0.2 : k === 'hue_p50' ? 0.05 : 1e-3);

test('маска ткани: блики и ресницы убраны, число пикселей как в Python', () => {
  assert.equal(countMask(tissueMask(img, lid)), E.tissue_lid_px);
  assert.equal(countMask(tissueMask(img, sclera)), E.tissue_sclera_px);
});

test('признаки века (сырые и после баланса по склере) совпадают с Python', () => {
  const f = extractFeatures(img, lid, sclera);
  for (const set of ['raw', 'wb']) {
    for (const [k, v] of Object.entries(E[set])) close(f[set][k], v, tolOf(k), `${set}.${k}`);
  }
  for (const [k, v] of Object.entries(E.rel)) close(f.rel[k], v, 1e-3, k);
});

test('баланс белого по склере делает склеру нейтральной', () => {
  const st = tissueMask(img, sclera);
  const wb = whiteBalance(img, st);
  const f = extractFeatures(wb, lid, sclera);
  close(f.sclera.a_p50, 0, 1.0, 'a* склеры');
  close(f.sclera.b_p50, 0, 1.0, 'b* склеры');
});

test('пустая маска → признаков нет (null), а не нули', () => {
  const f = extractFeatures(img, new Uint8Array(width * height), sclera);
  assert.equal(f.raw, null);
  assert.equal(f.wb, null);
  assert.equal(f.rel, null);
});

test('множитель света сокращается в отношениях «веко/склера»', () => {
  // умножаем линейный RGB на «тёплый» источник: отношения не должны измениться
  const k = [1.0, 0.85, 0.65];
  const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const toS = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  const warm = Float32Array.from(rgb, (x, i) => toS(Math.min(1, toLin(x) * k[i % 3])));
  const a = extractFeatures(img, lid, sclera).rel;
  const b = extractFeatures({ rgb: warm, width, height }, lid, sclera).rel;
  close(a.rel_lRG, b.rel_lRG, 0.02, 'rel_lRG');
  close(a.rel_lRB, b.rel_lRB, 0.02, 'rel_lRB');
});
