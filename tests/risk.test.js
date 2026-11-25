import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { probability, zoneOf, assess, validateModel, sigmoid } from '../src/risk.js';

const model = JSON.parse(readFileSync(new URL('../model/model.json', import.meta.url)));

test('model.json проходит проверку формата', () => {
  assert.deepEqual(validateModel(model), []);
});

test('ровно средние признаки → p = sigmoid(intercept)', () => {
  const feats = Object.fromEntries(model.features.map((f) => [f.name, f.mean]));
  assert.equal(probability(model, feats), sigmoid(model.intercept));
});

test('границы зон', () => {
  const t = { low: 0.35, high: 0.65 };
  assert.equal(zoneOf(0.349, t), 'low');
  assert.equal(zoneOf(0.35, t), 'mid');
  assert.equal(zoneOf(0.649, t), 'mid');
  assert.equal(zoneOf(0.65, t), 'high');
  assert.equal(zoneOf(NaN, t), 'na');
});

test('бледнее (ниже EI и a*) → риск выше', () => {
  const same = { L_p50: 60, HHR: 0.2 };
  const pale = { EI_p50: 0.1, a_p50: 8, ...same }, pink = { EI_p50: 0.4, a_p50: 32, ...same };
  assert.ok(probability(model, pale) > probability(model, pink));
});

test('проверка качества не пройдена → зона na и НИКАКОЙ вероятности', () => {
  const r = assess(model, { wb: { EI_p50: 0.1, a_p50: 8 } }, { ok: false, reasons: ['cam.light_color'] });
  assert.equal(r.zone, 'na');
  assert.equal(r.p, null);
  assert.deepEqual(r.reasons, ['cam.light_color']);
});

test('нет признака → na без вероятности', () => {
  const r = assess(model, { wb: { EI_p50: 0.1 } }, { ok: true, reasons: [] });
  assert.equal(r.zone, 'na');
  assert.equal(r.p, null);
});

test('битая модель ловится', () => {
  assert.ok(validateModel({ status: 'x', features: [{ name: 'a', mean: 0, std: 0, coef: 1 }], thresholds: { low: 0.7, high: 0.3 } }).length >= 3);
});

test('шкала берёт тот набор признаков, на котором обучена (feature_set)', () => {
  const f = { EI_p50: 0.15, a_p50: 25, L_p50: 60, HHR: 0.16 };
  const ok = { ok: true, reasons: [] };
  const r = assess(model, { [model.feature_set]: f }, ok);
  assert.notEqual(r.zone, 'na');
  const other = model.feature_set === 'raw' ? 'wb' : 'raw';
  assert.equal(assess(model, { [other]: f }, ok).zone, 'na');
});
