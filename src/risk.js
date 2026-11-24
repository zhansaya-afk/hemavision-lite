// Шкала риска: model.json → вероятность → зона. Чистые функции, без DOM.
//
// model.json:
// { version, status: "demo" | "trained", feature_set: "wb" | "raw",
//   features: [{ name, mean, std, coef }], intercept,
//   thresholds: { low, high }, metrics: {...} | null }
// Зоны: p < low → низкий, p >= high → высокий, иначе средний.
// Проверка качества не прошла или признака нет → "na" (оценка ненадёжна, без цифр).

export const ZONES = ['low', 'mid', 'high', 'na'];

export const sigmoid = (z) => 1 / (1 + Math.exp(-z));

export function validateModel(model) {
  const errs = [];
  if (!model || !Array.isArray(model.features) || !model.features.length) errs.push('нет списка признаков');
  else for (const f of model.features) {
    if (typeof f.name !== 'string') errs.push('признак без имени');
    if (!(f.std > 0)) errs.push(`std <= 0 у ${f.name}`);
    if (!Number.isFinite(f.coef) || !Number.isFinite(f.mean)) errs.push(`нет чисел у ${f.name}`);
  }
  const t = model && model.thresholds;
  if (!t || !(t.low > 0 && t.low <= t.high && t.high < 1)) errs.push('пороги должны быть 0 < low ≤ high < 1');
  if (!model || !['demo', 'trained'].includes(model.status)) errs.push('status: demo | trained');
  return errs;
}

/** Вероятность «риска» по признакам. NaN, если какого-то признака нет. */
export function probability(model, feats) {
  if (!feats) return NaN;
  let z = model.intercept || 0;
  for (const f of model.features) {
    const x = feats[f.name];
    if (!Number.isFinite(x)) return NaN;
    z += f.coef * ((x - f.mean) / f.std);
  }
  return sigmoid(z);
}

export function zoneOf(p, thresholds) {
  if (!Number.isFinite(p)) return 'na';
  if (p < thresholds.low) return 'low';
  if (p >= thresholds.high) return 'high';
  return 'mid';
}

/** Ключ текста «почему» для зоны. */
export function whyKey(zone) {
  return { low: 'res.why_normal', mid: 'res.why_between', high: 'res.why_paler' }[zone] || null;
}

/**
 * Итог по снимку. qc — результат roiCheck; features — extractFeatures.
 * При непройденной проверке качества вероятность не считается и не возвращается.
 */
export function assess(model, features, qc) {
  if (!qc || !qc.ok) return { zone: 'na', reasons: qc ? qc.reasons : ['sys.error'], p: null };
  const set = features && features[model.feature_set || 'wb'];
  const p = probability(model, set);
  const zone = zoneOf(p, model.thresholds);
  if (zone === 'na') return { zone, reasons: ['roi.err_lid_small'], p: null };
  return { zone, reasons: [], p, why: whyKey(zone) };
}
