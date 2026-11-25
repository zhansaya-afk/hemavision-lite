// AI Personalizer: офлайн-ассистент. Чистые функции, без DOM и без сети.
//
// 1) Личный план: правила по зоне риска по фото и ответам опроса (зону не меняют).
// 2) Ответы на вопросы: поиск по своей базе знаний (kb/ru.json, kb/kk.json) —
//    TF-IDF по символьным n-граммам (устойчив к падежам и опечаткам, работает для русского и казахского).
// 3) Безопасность раньше поиска: красные флаги в тексте вопроса → срочный совет; слабое совпадение →
//    честное «не знаю», а не случайная тема. Названий лекарств и доз в базе нет.

const KK_LETTERS = /[әғқңөұүһі]/;

/** Красные флаги в свободном тексте (рус./каз.). */
export const RED_FLAG_PATTERNS = [
  /бол[иья]\S* в груди|грудь бол|давит в груди|кеуде\S* ауыр|кеудем ауыр/,
  /обморок|потерял\S* сознани|теряю сознани|есін\S* тан|есінен тан/,
  /ч[её]рн\S* стул|кровь в стуле|кровь в кале|қара нәжіс|нәжісте қан/,
  /сильн\S* кровотечени|кровотечени\S* не останавлива|кровь не останавлива|қан тоқтамай|көп қан кет/,
  /одышка в покое|задыхаюсь|не могу дышать|тыныс ала алмай/,
  /беремен\S*.*кровотечени|кровотечени\S*.*беремен|жүкті\S*.*қан кет/,
];

// Служебные слова не несут темы: без них «как», «можно», «какая» не тянут вопрос к случайной теме.
export const STOPWORDS = new Set((
  'а и в во на не ни но да ли же бы то ну что как какой какая какое какие какую где когда куда зачем почему ' +
  'можно надо нужно ли это этот эта мне меня мой моя мои у я ты вы он она мы они его ее их с со к ко по о об ' +
  'за из от до для при про или если уже еще ещё очень всё все весь там тут так вот бывает есть быть будет ' +
  'сколько чем чего кто кого себя свой свою ' +
  'және мен сен сіз ол біз олар бұл осы сол не неге қалай қайда қашан қандай ма ме ба бе па пе бола болады ' +
  'керек ме ғой да де мен менің сенің оның маған саған бар жоқ'
).split(' '));

export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^0-9a-zа-яәғқңөұүһі*]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export const detectLang = (text, fallback = 'ru') => (KK_LETTERS.test(normalize(text)) ? 'kk' : fallback);

export function isUrgent(text) {
  const s = normalize(text);
  return RED_FLAG_PATTERNS.some((re) => re.test(s));
}

/** Символьные n-граммы (3 и 4) по словам с границами: «анемия» → « ан», «ане», … */
export function ngrams(text) {
  const out = new Map();
  for (const w of normalize(text).split(' ')) {
    if (!w || STOPWORDS.has(w)) continue;
    const p = ` ${w} `;
    for (const n of [3, 4]) {
      for (let i = 0; i + n <= p.length; i++) {
        const g = p.slice(i, i + n);
        out.set(g, (out.get(g) || 0) + 1);
      }
    }
  }
  return out;
}

function tfidf(counts, idf) {
  const v = new Map();
  let norm = 0;
  for (const [g, c] of counts) {
    const w = (1 + Math.log(c)) * (idf.get(g) || 0);
    if (w > 0) { v.set(g, w); norm += w * w; }
  }
  norm = Math.sqrt(norm) || 1;
  for (const [g, w] of v) v.set(g, w / norm);
  return v;
}

function cosine(a, b) {
  let s = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const [g, w] of small) { const x = big.get(g); if (x) s += w * x; }
  return s;
}

/** Основы слов (первые 4 буквы значимых слов): «якорь» — хотя бы одна общая основа с темой. */
export function stems(text) {
  const out = new Set();
  for (const w of normalize(text).split(' ')) if (w.length >= 3 && !STOPWORDS.has(w)) out.add(w.slice(0, 4));
  return out;
}

/** Индекс базы знаний: каждая формулировка вопроса — отдельный документ. */
export function buildIndex(kb) {
  const docs = [];
  const topicStems = new Map();
  for (const t of kb.topics) {
    const st = new Set();
    for (const q of [t.title, ...t.q]) {
      docs.push({ id: t.id, counts: ngrams(q) });
      for (const x of stems(q)) st.add(x);
    }
    topicStems.set(t.id, st);
  }
  const df = new Map();
  for (const d of docs) for (const g of d.counts.keys()) df.set(g, (df.get(g) || 0) + 1);
  const idf = new Map();
  for (const [g, n] of df) idf.set(g, Math.log((1 + docs.length) / (1 + n)) + 1);
  for (const d of docs) d.vec = tfidf(d.counts, idf);
  return { kb, idf, docs, topicStems };
}

/**
 * Лучшие темы по вопросу: [{ id, score }] по убыванию, одна запись на тему.
 * Тема без общей основы слова с вопросом не рассматривается: совпадение обрывков слов — не смысл.
 */
export function search(index, question, k = 3) {
  const q = tfidf(ngrams(question), index.idf);
  const qs = stems(question);
  const best = new Map();
  for (const d of index.docs) {
    const ts = index.topicStems.get(d.id);
    if (![...qs].some((x) => ts.has(x))) continue;
    const s = cosine(q, d.vec);
    if (s > (best.get(d.id) || 0)) best.set(d.id, s);
  }
  return [...best].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score).slice(0, k);
}

export const THRESHOLD = 0.22;

/**
 * Ответ на вопрос. indexes = { ru, kk }; ctx = { lang, dynamic(id, lang) → текст }.
 * Возвращает { type: 'urgent' | 'topic' | 'fallback', lang, id?, text, score?, suggestions: [id] }.
 */
export function answer(indexes, question, ctx = {}) {
  const first = answerIn(indexes, question, ctx, detectLang(question, ctx.lang || 'ru'));
  if (first.type !== 'fallback' || !normalize(question)) return first;
  // казахский вопрос без особых букв («балама 4 жас») — пробуем другую базу
  const other = first.lang === 'ru' ? 'kk' : 'ru';
  if (!indexes[other]) return first;
  const second = answerIn(indexes, question, ctx, other);
  return second.type === 'topic' ? second : first;
}

function answerIn(indexes, question, ctx, lang) {
  const idx = indexes[lang] || indexes.ru;
  const kb = idx.kb;
  if (!normalize(question)) return { type: 'fallback', lang, text: kb.fallback, suggestions: [] };
  if (isUrgent(question)) return { type: 'urgent', lang, text: kb.urgent, suggestions: ['cbc'] };
  const hits = search(idx, question);
  const top = hits[0];
  if (!top || top.score < THRESHOLD) {
    return { type: 'fallback', lang, text: kb.fallback, score: top ? top.score : 0, suggestions: hits.map((h) => h.id) };
  }
  const topic = kb.topics.find((t) => t.id === top.id);
  const text = topic.a === 'dynamic' && ctx.dynamic ? ctx.dynamic(topic.id, lang) : topic.a;
  return { type: 'topic', lang, id: topic.id, text, score: top.score, suggestions: hits.slice(1).map((h) => h.id) };
}

/**
 * Личный план после результата: ключи текстов по порядку важности.
 * zone — из risk.assess (здесь не меняется); ev — personalizer.evaluateSurvey; survey — ответы.
 */
export function personalPlan(zone, ev, survey) {
  const plan = [];
  if (ev.redFlags.length) plan.push('plan.urgent');
  if (zone === 'na') plan.push('plan.retake');
  else if (zone === 'high') plan.push('plan.cbc_high');
  else if (zone === 'mid') plan.push('plan.cbc_mid');
  else if (ev.symptoms.length) plan.push('plan.cbc_low_symptoms');
  else plan.push('plan.cbc_low');
  if (ev.symptoms.includes('periods')) plan.push('plan.periods');
  if (ev.notes.includes('survey.pregnant_note')) plan.push('plan.pregnant');
  if (ev.notes.includes('survey.teen_note')) plan.push('plan.teen');
  if (zone === 'mid' || zone === 'high' || ev.symptoms.length) plan.push('plan.no_pills', 'plan.food');
  if (zone !== 'na') plan.push('plan.report');
  return plan;
}
