// Проверка качества кадра. Чистые функции, без DOM.
// Пороги — стартовые из плана MVP, на отдельные фото не подгонялись.

import { EPS, rgbToLab, median } from './color.js';
import { tissueMask, countMask } from './features.js';

export const Q = {
  darkV: 0.15,        // медиана яркости ниже — «темно»
  overShare: 0.05,    // доля пересвеченных пикселей (v > 0.98) выше — «ярко/блик»
  overV: 0.98,
  sharpVar: 25,       // дисперсия Лапласиана (серый 0..255, кадр ~160 px) ниже — «держите ровнее»
  redA: 15,           // a* > 15 — «розовая» ткань
  redShare: 0.10,     // доля розовых пикселей в рамке ниже — «оттяните веко»
  scleraColorB: 15,   // |b*| склеры выше — цветной свет
  scleraDarkL: 35,    // L* склеры ниже — склера в тени
  lidMinPx: 300,      // мало ткани века — «отметьте шире»
  glareShare: 0.30,   // доля бликов внутри отметки века
};

/** Дисперсия дискретного Лапласиана (4-соседи) по серому каналу 0..255. */
export function laplacianVar(gray, width, height) {
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const l = gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width] - 4 * gray[i];
      s += l; s2 += l * l; n++;
    }
  }
  if (!n) return 0;
  const m = s / n;
  return s2 / n - m * m;
}

/** Серый канал 0..255 из RGBA-байтов (BT.601, как OpenCV). */
export function toGray(data, n) {
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) g[i] = 0.299 * data[4 * i] + 0.587 * data[4 * i + 1] + 0.114 * data[4 * i + 2];
  return g;
}

/**
 * Живая проверка кадра камеры (уменьшенный кадр рамки, RGBA-байты).
 * Возвращает статусы: light ok|dark|bright, sharp ok|bad, lid ok|bad.
 */
export function liveCheck({ data, width, height }) {
  const n = width * height;
  const vs = new Float32Array(n);
  let over = 0, red = 0;
  for (let i = 0; i < n; i++) {
    const r = data[4 * i] / 255, g = data[4 * i + 1] / 255, b = data[4 * i + 2] / 255;
    const v = Math.max(r, g, b);
    vs[i] = v;
    if (v > Q.overV) over++;
    if (rgbToLab(r, g, b)[1] > Q.redA) red++;
  }
  const medV = median(vs);
  const sharp = laplacianVar(toGray(data, n), width, height);
  return {
    light: medV < Q.darkV ? 'dark' : over / n > Q.overShare ? 'bright' : 'ok',
    sharp: sharp < Q.sharpVar ? 'bad' : 'ok',
    lid: red / n < Q.redShare ? 'bad' : 'ok',
    values: { medV, overShare: over / n, sharp, redShare: red / n },
  };
}

/**
 * Проверка после отметки тканей. img — float RGB, маски века и склеры.
 * Возвращает { ok, reasons: [ключи текстов], quality: 'good'|'fair' }.
 * Любая причина → «оценка ненадёжна» без цифр.
 */
export function roiCheck(img, lid, sclera, features) {
  const reasons = [];
  const lidTissue = tissueMask(img, lid);
  const nLid = countMask(lid);
  const nLidT = countMask(lidTissue);
  if (nLidT < Q.lidMinPx) reasons.push('roi.err_lid_small');

  // блики и темнота внутри отметки века
  let glare = 0;
  const vs = [];
  for (let i = 0; i < lid.length; i++) {
    if (!lid[i]) continue;
    const r = img.rgb[3 * i], g = img.rgb[3 * i + 1], b = img.rgb[3 * i + 2];
    const v = Math.max(r, g, b);
    const s = (v - Math.min(r, g, b)) / (v + EPS);
    vs.push(v);
    if (v > 0.92 && s < 0.25) glare++;
  }
  if (nLid && glare / nLid > Q.glareShare) reasons.push('roi.err_glare');
  if (vs.length && median(vs) < Q.darkV) reasons.push('cam.light_dark');

  const sc = features && features.sclera;
  if (!sc) reasons.push('roi.err_sclera');
  else {
    if (sc.L_p50 < Q.scleraDarkL) reasons.push('roi.err_sclera_dark');
    else if (Math.abs(sc.b_p50) > Q.scleraColorB) reasons.push('cam.light_color');
  }
  if (!features || !features.wb) {
    if (!reasons.includes('roi.err_lid_small')) reasons.push('roi.err_lid_small');
  }
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/** Резкость области века: дисперсия Лапласиана в рамке отметки. 'good' | 'fair'. */
export function sharpnessGrade(gray, width, height, bbox, threshold = 15) {
  const [x0, y0, x1, y1] = bbox;
  const w = x1 - x0, h = y1 - y0;
  if (w < 3 || h < 3) return 'fair';
  const crop = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) crop[y * w + x] = gray[(y0 + y) * width + x0 + x];
  return laplacianVar(crop, w, h) < threshold ? 'fair' : 'good';
}

/** Рамка маски [x0, y0, x1, y1). */
export function maskBBox(mask, width) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % width, y = (i / width) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? [0, 0, 0, 0] : [x0, y0, x1 + 1, y1 + 1];
}

