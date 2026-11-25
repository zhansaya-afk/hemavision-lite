import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveCheck, laplacianVar, roiCheck, maskBBox } from '../src/quality.js';
import { extractFeatures } from '../src/features.js';

function frame(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = fn(x, y); const i = 4 * (y * w + x);
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  return { data, width: w, height: h };
}

test('тёмный кадр → dark', () => {
  assert.equal(liveCheck(frame(40, 40, () => [10, 8, 8])).light, 'dark');
});

test('пересвет → bright', () => {
  assert.equal(liveCheck(frame(40, 40, () => [255, 255, 255])).light, 'bright');
});

test('ровный кадр размыт, шахматка резкая', () => {
  assert.equal(liveCheck(frame(40, 40, () => [200, 100, 100])).sharp, 'bad');
  assert.equal(liveCheck(frame(40, 40, (x, y) => ((x + y) % 2 ? [220, 90, 90] : [120, 40, 40]))).sharp, 'ok');
});

test('нет розовой ткани → «оттяните веко»', () => {
  assert.equal(liveCheck(frame(40, 40, () => [180, 170, 160])).lid, 'bad');
  assert.equal(liveCheck(frame(40, 40, () => [210, 100, 105])).lid, 'ok');
});

test('Лапласиан константы = 0', () => {
  assert.equal(laplacianVar(new Float32Array(100).fill(7), 10, 10), 0);
});

test('цветной (жёлтый) свет по склере → оценка ненадёжна', () => {
  const w = 40, h = 40;
  const rgbOf = (x, y) => (y < 15 ? [235, 215, 120] : y > 20 ? [205, 110, 90] : [90, 60, 50]);
  const rgb = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgbOf(x, y).forEach((v, c) => { rgb[3 * (y * w + x) + c] = (v + ((x * 7 + y * 3) % 5)) / 255; });
  const img = { rgb, width: w, height: h };
  const lid = new Uint8Array(w * h), sc = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) { const y = (i / w) | 0; if (y > 20) lid[i] = 1; if (y < 15) sc[i] = 1; }
  const r = roiCheck(img, lid, sc, extractFeatures(img, lid, sc));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes('cam.light_color'));
});

test('рамка маски', () => {
  const m = new Uint8Array(25); m[6] = 1; m[18] = 1;
  assert.deepEqual(maskBBox(m, 5), [1, 1, 4, 4]);
});

function eye(w, h, scleraRGB) {
  // склера сверху, кожа слева, веко снизу
  const rgb = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = x < 12 ? [196, 150, 125] : y < 20 ? scleraRGB : y > 26 ? [205, 105, 105] : [90, 60, 50];
    c.forEach((v, k) => { rgb[3 * (y * w + x) + k] = (v + ((x * 7 + y * 3) % 5)) / 255; });
  }
  return { rgb, width: w, height: h };
}
const rect = (w, h, x0, y0, x1, y1) => { const m = new Uint8Array(w * h); for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 1; return m; };

test('касание склеры с краем на коже — не «цветной свет»', () => {
  const img = eye(48, 40, [236, 232, 226]);
  const lid = rect(48, 40, 14, 28, 46, 38), sc = rect(48, 40, 4, 4, 30, 18);   // треть отметки на коже
  const r = roiCheck(img, lid, sc, extractFeatures(img, lid, sc));
  assert.ok(!r.reasons.includes('cam.light_color'), r.reasons.join());
  assert.ok(r.ok, r.reasons.join());
});

test('отметка целиком на коже → «не на белке», а не «цветной свет»', () => {
  const img = eye(48, 40, [236, 232, 226]);
  const lid = rect(48, 40, 14, 28, 46, 38), sc = rect(48, 40, 0, 4, 11, 18);
  const r = roiCheck(img, lid, sc, extractFeatures(img, lid, sc));
  assert.deepEqual(r.reasons, ['roi.err_sclera_miss']);
});

test('настоящий жёлтый свет на всей склере → «цветной свет»', () => {
  const img = eye(48, 40, [240, 215, 140]);
  const lid = rect(48, 40, 14, 28, 46, 38), sc = rect(48, 40, 14, 4, 40, 18);
  const r = roiCheck(img, lid, sc, extractFeatures(img, lid, sc));
  assert.ok(r.reasons.includes('cam.light_color'), r.reasons.join());
});
