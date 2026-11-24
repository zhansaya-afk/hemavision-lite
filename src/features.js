// Признаки цвета ткани. Чистые функции, без DOM.
// Изображение: { rgb: Float32Array(w*h*3) в [0,1] (sRGB), width, height }.
// Маска: Uint8Array(w*h), 1 — пиксель внутри отметки пользователя.

import {
  EPS, srgbToLin, linToSrgb, rgbToLab, rgbToHsi, signedHue, erythemaIndex, percentile, median,
} from './color.js';

export const MIN_TISSUE_PX = 30;

/** RGBA-байты (ImageData) → изображение float RGB. */
export function fromImageData({ data, width, height }) {
  const n = width * height;
  const rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    rgb[3 * i] = data[4 * i] / 255;
    rgb[3 * i + 1] = data[4 * i + 1] / 255;
    rgb[3 * i + 2] = data[4 * i + 2] / 255;
  }
  return { rgb, width, height };
}

export function countMask(mask) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) n += mask[i] ? 1 : 0;
  return n;
}

/** Пиксели ткани внутри маски без бликов (светлые и бесцветные), теней и ресниц (тёмные). */
export function tissueMask(img, mask, minPx = MIN_TISSUE_PX) {
  const { rgb } = img;
  const n = mask.length;
  const out = new Uint8Array(n);
  const vs = [];
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const r = rgb[3 * i], g = rgb[3 * i + 1], b = rgb[3 * i + 2];
    const v = Math.max(r, g, b);
    const s = (v - Math.min(r, g, b)) / (v + EPS);
    if (v > 0.08 && !(v > 0.92 && s < 0.25)) {
      out[i] = 1;
      vs.push(v);
    }
  }
  if (vs.length < minPx) {
    for (let i = 0; i < n; i++) out[i] = mask[i] && Math.max(rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]) > 0.03 ? 1 : 0;
    return out;
  }
  const lo = percentile(vs, 3), hi = percentile(vs, 99);
  for (let i = 0; i < n; i++) {
    if (!out[i]) continue;
    const v = Math.max(rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]);
    if (v < lo || v > hi) out[i] = 0;
  }
  return out;
}

/** Медиана каждого канала линейного RGB по маске (пиксели обрезаются снизу до 1/255). */
function linMedian(img, mask, clipLow) {
  const ch = [[], [], []];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    for (let c = 0; c < 3; c++) {
      const x = Math.min(1, Math.max(clipLow, img.rgb[3 * i + c]));
      ch[c].push(srgbToLin(x));
    }
  }
  return ch.map(median);
}

/** Баланс белого по эталонной ткани (склера): линейный RGB делится на её медиану (модель фон Криса). */
export function whiteBalance(img, refMask) {
  const ref = linMedian(img, refMask, 0).map((x) => x + 1e-6);
  const mean = (ref[0] + ref[1] + ref[2]) / 3;
  const k = ref.map((x) => mean / x);
  const out = new Float32Array(img.rgb.length);
  for (let i = 0; i < img.rgb.length; i++) {
    const x = Math.min(1, Math.max(0, img.rgb[i]));
    out[i] = linToSrgb(srgbToLin(x) * k[i % 3]);
  }
  return { rgb: out, width: img.width, height: img.height };
}

/** Признаки цвета области (медианы по чистым пикселям ткани). null — мало ткани. */
export function roiFeatures(img, mask) {
  const m = tissueMask(img, mask);
  const n = countMask(m);
  if (n < MIN_TISSUE_PX) return null;
  const EI = [], L = [], A = [], B = [], hue = [];
  for (let i = 0; i < m.length; i++) {
    if (!m[i]) continue;
    const r = Math.min(1, Math.max(1 / 255, img.rgb[3 * i]));
    const g = Math.min(1, Math.max(1 / 255, img.rgb[3 * i + 1]));
    const b = Math.min(1, Math.max(1 / 255, img.rgb[3 * i + 2]));
    EI.push(erythemaIndex(r, g));
    const lab = rgbToLab(r, g, b);
    L.push(lab[0]); A.push(lab[1]); B.push(lab[2]);
    hue.push(signedHue(rgbToHsi(r, g, b)[0]));
  }
  let red = 0;
  for (const h of hue) if (Math.abs(h) < 10) red++;
  return {
    EI_p50: median(EI),
    L_p50: median(L),
    a_p50: median(A),
    b_p50: median(B),
    hue_p50: median(hue),
    HHR: red / hue.length,
    n_px: n,
  };
}

/** Цвет века относительно склеры того же снимка: множитель источника света сокращается в линейном RGB. */
export function relativeFeatures(img, lid, sclera) {
  const mc = tissueMask(img, lid), ms = tissueMask(img, sclera);
  if (countMask(mc) < MIN_TISSUE_PX || countMask(ms) < MIN_TISSUE_PX) return null;
  const c = linMedian(img, mc, 1 / 255).map((x) => x + 1e-6);
  const s = linMedian(img, ms, 1 / 255).map((x) => x + 1e-6);
  const q = c.map((x, i) => x / s[i]);
  return { rel_lRG: Math.log(q[0] / q[1]), rel_lRB: Math.log(q[0] / q[2]) };
}

/**
 * Все признаки снимка: сырые признаки века, признаки века после баланса белого по склере,
 * отношения «веко/склера» и цвет склеры (для проверки цветного света).
 */
export function extractFeatures(img, lid, sclera) {
  const scleraTissue = tissueMask(img, sclera);
  const scleraN = countMask(scleraTissue);
  const raw = roiFeatures(img, lid);
  const sclera_ = scleraN >= MIN_TISSUE_PX ? roiFeatures(img, sclera) : null;
  const wb = scleraN >= MIN_TISSUE_PX ? roiFeatures(whiteBalance(img, scleraTissue), lid) : null;
  const rel = relativeFeatures(img, lid, sclera);
  return { raw, wb, rel, sclera: sclera_ };
}
