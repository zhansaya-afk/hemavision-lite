import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSurvey, advice } from '../src/personalizer.js';

const base = { age: 30, sex: 'f', pregnant: 'no', weak: false, breath: false, dizzy: false, periods: false, chest: false, stool: false, faint: false };

test('возраст до 5 лет → отказ', () => {
  assert.equal(evaluateSurvey({ ...base, age: 4 }).refuse, 'survey.refuse_u5');
  assert.equal(evaluateSurvey({ ...base, age: 5 }).refuse, null);
});

test('красные флаги → плашка; анализ не блокируется', () => {
  const s = evaluateSurvey({ ...base, chest: true, stool: true });
  assert.deepEqual(s.redFlags, ['chest', 'stool']);
  assert.equal(s.refuse, null);
});

test('подростки и беременность → заметка «менее надёжно», не отказ', () => {
  assert.deepEqual(evaluateSurvey({ ...base, age: 15 }).notes, ['survey.teen_note']);
  assert.deepEqual(evaluateSurvey({ ...base, pregnant: 'yes' }).notes, ['survey.pregnant_note']);
  assert.deepEqual(evaluateSurvey({ ...base, sex: 'm', pregnant: 'yes' }).notes, []);
});

test('месячные не учитываются у мужчин', () => {
  assert.deepEqual(evaluateSurvey({ ...base, sex: 'm', periods: true }).symptoms, []);
});

test('зона по фото не меняется: совет зависит от зоны, симптомы только добавляют текст', () => {
  const many = evaluateSurvey({ ...base, weak: true, breath: true });
  assert.ok(advice('low', many).includes('res.advice_low'));
  assert.ok(advice('low', many).includes('res.symptoms_boost'));
  assert.ok(!advice('low', evaluateSurvey({ ...base, weak: true })).includes('res.symptoms_boost'));
  assert.deepEqual(advice('na', many), ['res.advice_na']);
  assert.equal(advice('high', evaluateSurvey({ ...base, faint: true }))[0], 'survey.redflag_title');
});
