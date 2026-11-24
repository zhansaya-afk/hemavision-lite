// Personalizer: правила по ответам опроса. Чистые функции, без DOM.
// Главное правило: ответы НЕ меняют зону риска по фото. Они меняют только совет и плашки.

export const SYMPTOMS = ['weak', 'breath', 'dizzy', 'periods'];
export const RED_FLAGS = ['chest', 'stool', 'faint'];

/** Женщина 12–55 лет — показываем вопросы о беременности и месячных. */
export function asksFemaleQuestions(s) {
  return s.sex === 'f' && Number.isFinite(s.age) && s.age >= 12 && s.age <= 55;
}

export function validAge(age) {
  return Number.isFinite(age) && age >= 0 && age <= 120;
}

/**
 * s = { age, sex: 'f'|'m'|null, pregnant: 'yes'|'no'|'unknown'|null,
 *       weak, breath, dizzy, periods, chest, stool, faint: true|false|null }
 */
export function evaluateSurvey(s) {
  const out = { refuse: null, redFlags: [], symptoms: [], notes: [] };
  if (validAge(s.age) && s.age < 5) {
    out.refuse = 'survey.refuse_u5';
    return out;
  }
  const female = asksFemaleQuestions(s);
  for (const k of SYMPTOMS) {
    if (k === 'periods' && !female) continue;
    if (s[k] === true) out.symptoms.push(k);
  }
  for (const k of RED_FLAGS) if (s[k] === true) out.redFlags.push(k);
  if (validAge(s.age) && s.age < 18) out.notes.push('survey.teen_note');
  if (female && s.pregnant === 'yes') out.notes.push('survey.pregnant_note');
  return out;
}

/**
 * Совет по зоне фото и опросу. Возвращает ключи текстов по порядку показа.
 * Зона приходит из risk.assess и здесь не меняется.
 */
export function advice(zone, survey) {
  const keys = [];
  if (survey.redFlags.length) keys.push('survey.redflag_title');
  keys.push({ low: 'res.advice_low', mid: 'res.advice_mid', high: 'res.advice_high', na: 'res.advice_na' }[zone]);
  if (zone !== 'na' && survey.symptoms.length && (zone !== 'low' || survey.symptoms.length >= 2)) {
    keys.push('res.symptoms_boost');
  }
  return keys;
}
