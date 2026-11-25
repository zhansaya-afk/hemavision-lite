import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildIndex, answer, isUrgent, personalPlan, detectLang, THRESHOLD } from '../src/assistant.js';
import { evaluateSurvey } from '../src/personalizer.js';

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const kbRu = load('../kb/ru.json'), kbKk = load('../kb/kk.json');
const idx = { ru: buildIndex(kbRu), kk: buildIndex(kbKk) };
const got = (q) => { const r = answer(idx, q, { lang: 'ru', dynamic: () => 'dyn' }); return r.type === 'topic' ? r.id : r.type.toUpperCase(); };

test('базы RU и KZ: одинаковые темы, у каждой ответ и ≥3 формулировки', () => {
  assert.deepEqual(kbRu.topics.map((t) => t.id), kbKk.topics.map((t) => t.id));
  for (const kb of [kbRu, kbKk]) for (const t of kb.topics) {
    assert.ok(t.a && t.title, t.id);
    assert.ok(t.q.length >= 3, `${kb.lang}/${t.id}: мало формулировок`);
  }
});

test('каждая формулировка из базы находит свою тему', () => {
  for (const kb of [kbRu, kbKk]) for (const t of kb.topics) for (const q of t.q) {
    const r = answer(idx, q, { lang: kb.lang, dynamic: () => 'dyn' });
    assert.equal(r.id, t.id, `${kb.lang}: «${q}» → ${r.id || r.type}`);
  }
});

test('в базе нет названий препаратов и доз', () => {
  const bad = /\d+\s*мг|мг\/|сорбифер|феррум|мальтофер|тардиферон|актиферрин|дозировк/i;
  for (const kb of [kbRu, kbKk]) for (const t of kb.topics) assert.ok(!bad.test(t.a), `${kb.lang}/${t.id}`);
});

test('красные флаги в вопросе → срочный совет раньше поиска', () => {
  for (const q of ['болит в груди', 'вчера был обморок', 'черный стул третий день', 'кеудем ауырады', 'есінен тандым', 'беременна и началось кровотечение',
    'жүрегім шаншиды', 'кеуде тұсым ауырады', 'есімнен айырылдым', 'құсығымда қан бар', 'тынысым тарылып жатыр']) {
    assert.ok(isUrgent(q), q);
    assert.equal(got(q), 'URGENT', q);
  }
  for (const q of ['что такое анемия', 'как часто проверять']) assert.ok(!isUrgent(q), q);
});

test('не по теме → честное «не знаю», а не случайная тема', () => {
  for (const q of ['как решить задачу по химии', 'какая погода завтра', 'болит зуб', '', '???']) assert.equal(got(q), 'FALLBACK', q);
});

test('язык ответа по вопросу', () => {
  assert.equal(detectLang('шай ішуге бола ма'), 'kk');
  assert.equal(detectLang('можно ли чай'), 'ru');
  assert.equal(answer(idx, 'балама 4 жас', { lang: 'ru' }).lang, 'kk');
});

test('отложенный набор (holdout): доля верных и ни одного пропущенного срочного', () => {
  const { cases } = load('./assistant_holdout.json');
  let ok = 0;
  const miss = [];
  for (const [q, exp] of cases) {
    const g = got(q);
    if (g === exp) ok++; else miss.push(`${q} → ${g} (ждали ${exp})`);
    if (exp === 'URGENT') assert.equal(g, 'URGENT', q);
  }
  console.log(`holdout: ${ok}/${cases.length} (порог ${THRESHOLD})${miss.length ? '\n  ' + miss.join('\n  ') : ''}`);
  assert.ok(ok / cases.length >= 0.7, `holdout ${ok}/${cases.length}`);
});

const base = { age: 30, sex: 'f', pregnant: 'no', weak: false, breath: false, dizzy: false, periods: false, chest: false, stool: false, faint: false };

test('личный план: красный флаг первым, зона не меняется, без зоны — только пересъёмка', () => {
  const ev = evaluateSurvey({ ...base, chest: true });
  assert.equal(personalPlan('low', ev, base)[0], 'plan.urgent');
  assert.ok(personalPlan('high', evaluateSurvey(base), base).includes('plan.cbc_high'));
  assert.deepEqual(personalPlan('na', evaluateSurvey(base), base), ['plan.retake']);
  assert.deepEqual(personalPlan('low', evaluateSurvey(base), base), ['plan.cbc_low', 'plan.report']);
});

test('личный план учитывает симптомы, месячные, беременность, возраст', () => {
  const p = personalPlan('low', evaluateSurvey({ ...base, periods: true }), base);
  assert.ok(p.includes('plan.cbc_low_symptoms') && p.includes('plan.periods') && p.includes('plan.no_pills'));
  assert.ok(personalPlan('mid', evaluateSurvey({ ...base, pregnant: 'yes' }), base).includes('plan.pregnant'));
  assert.ok(personalPlan('mid', evaluateSurvey({ ...base, age: 15 }), base).includes('plan.teen'));
});

test('мысли о самоубийстве → поддержка и телефоны помощи, не поиск по базе', () => {
  for (const q of ['не хочу жить', 'думаю покончить с собой', 'өмір сүргім келмейді', 'өмірдің мәні жоқ']) {
    const r = answer(idx, q, { lang: 'ru' });
    assert.equal(r.type, 'crisis', q);
    assert.match(r.text, /150/);
  }
  assert.equal(answer(idx, 'өмір сүргім келмейді', { lang: 'ru' }).lang, 'kk');
});
