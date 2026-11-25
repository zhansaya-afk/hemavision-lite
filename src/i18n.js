// Тексты интерфейса по ключам: i18n/ru.json, i18n/kk.json. Нет ключа в kk → берём ru.

const LANGS = ['ru', 'kk'];
const dict = {};
let lang = 'ru';

function stored() {
  try { return localStorage.getItem('hv.lang'); } catch { return null; }
}

export async function loadI18n() {
  for (const l of LANGS) {
    const r = await fetch(`i18n/${l}.json`);
    dict[l] = await r.json();
  }
  const s = stored();
  lang = LANGS.includes(s) ? s : 'ru';
}

export const getLang = () => lang;

export function setLang(l) {
  lang = LANGS.includes(l) ? l : 'ru';
  try { localStorage.setItem('hv.lang', lang); } catch { /* приватный режим — язык не запоминаем */ }
  document.documentElement.lang = lang === 'kk' ? 'kk' : 'ru';
  applyI18n();
}

/** Текст по ключу с подстановкой {x}. */
export function t(key, vars = {}) {
  return tIn(lang, key, vars);
}

/** Текст на заданном языке (ответ ассистента на языке вопроса). */
export function tIn(l, key, vars = {}) {
  const s = (dict[l] && dict[l][key]) || (dict.ru && dict.ru[key]) || key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
}

/** Число с запятой для RU/KZ. */
export function num(x, digits = 2) {
  return Number.isFinite(x) ? x.toFixed(digits).replace('.', ',') : '—';
}
