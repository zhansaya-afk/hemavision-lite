// Цветовые пространства и индексы бледности. Чистые функции, без DOM.
// Вход — компоненты sRGB в [0, 1]. Формулы сверяются с эталоном tests/golden.json.

export const EPS = 1e-4;

/** sRGB → линейный RGB (IEC 61966-2-1). */
export function srgbToLin(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Линейный RGB → sRGB, с обрезкой в [0, 1]. */
export function linToSrgb(c) {
  const x = Math.min(1, Math.max(0, c));
  return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
}

const labF = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

/** CIELAB (D65), L 0..100. Те же константы, что у OpenCV COLOR_RGB2Lab для float. */
export function rgbToLab(r, g, b) {
  const R = srgbToLin(r), G = srgbToLin(g), B = srgbToLin(b);
  const X = (0.412453 * R + 0.35758 * G + 0.180423 * B) / 0.950456;
  const Y = 0.212671 * R + 0.71516 * G + 0.072169 * B;
  const Z = (0.019334 * R + 0.119193 * G + 0.950227 * B) / 1.088754;
  const L = Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y;
  return [L, 500 * (labF(X) - labF(Y)), 200 * (labF(Y) - labF(Z))];
}

/** HSI по Гонсалесу: H в градусах 0..360, S 0..1, I 0..1. */
export function rgbToHsi(r, g, b) {
  const I = (r + g + b) / 3;
  const S = 1 - Math.min(r, g, b) / (I + EPS);
  const num = 0.5 * ((r - g) + (r - b));
  const den = Math.sqrt((r - g) ** 2 + (r - b) * (g - b));
  // без «+EPS» в знаменателе: он сдвигает оттенок красных пикселей примерно на 1°
  const th = den < 1e-8 ? 0 : (Math.acos(Math.max(-1, Math.min(1, num / Math.max(den, 1e-12)))) * 180) / Math.PI;
  const H = b <= g ? th : 360 - th;
  return [H, Math.max(0, Math.min(1, S)), I];
}

/** Оттенок в −180..180°, чтобы красный (около 0/360) не рвался на два края. */
export const signedHue = (H) => (H > 180 ? H - 360 : H);

/** Erythema Index = log10(R) − log10(G). Гемоглобин поглощает зелёный, поэтому бледность снижает EI. */
export function erythemaIndex(r, g) {
  const R = Math.min(1, Math.max(1 / 255, r));
  const G = Math.min(1, Math.max(1 / 255, g));
  return Math.log10(R) - Math.log10(G);
}

/** HHR: доля оттенков с |H| < halfWidth градусов. */
export function highHueRatio(hues, halfWidth = 10) {
  if (!hues.length) return NaN;
  let n = 0;
  for (const h of hues) if (Math.abs(signedHue(h)) < halfWidth) n++;
  return n / hues.length;
}

/** Перцентиль с линейной интерполяцией (как numpy.percentile по умолчанию). Массив не меняется. */
export function percentile(values, p) {
  if (!values.length) return NaN;
  const a = Float64Array.from(values).sort();
  const pos = ((a.length - 1) * p) / 100;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

export const median = (values) => percentile(values, 50);
