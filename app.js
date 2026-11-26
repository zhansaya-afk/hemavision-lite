// HemaVision Lite: экраны, состояние сеанса, связь модулей. Всё считается на телефоне, сети нет.

import { loadI18n, t, tIn, applyI18n, setLang, getLang, num } from './src/i18n.js';
import { evaluateSurvey, advice, asksFemaleQuestions, validAge, SYMPTOMS, RED_FLAGS } from './src/personalizer.js';
import { startCamera, stopCamera, checkFrame, capture, loadFile } from './src/camera.js';
import { createRoi } from './src/roi.js';
import { fromImageData, extractFeatures } from './src/features.js';
import { roiCheck, sharpnessGrade, maskBBox, toGray } from './src/quality.js';
import { assess, validateModel } from './src/risk.js';
import { renderReport } from './src/report.js';
import { addRecord, listRecords, clearRecords } from './src/store.js';
import { buildIndex, answer, personalPlan } from './src/assistant.js';

export const APP_VERSION = '1.2.3';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  model: null,
  survey: { age: NaN, sex: null, pregnant: null },
  surveyEval: null,
  photo: document.createElement('canvas'),
  roi: null,
  result: null,
  kb: null,
  chat: [],
};

/* ---------- навигация ---------- */

let current = 'start';
let liveTimer = null;

let beforeAssistant = 'start';

function show(name) {
  if (current === 'camera' && name !== 'camera') { clearInterval(liveTimer); stopCamera(); }
  if (name === 'assistant' && current !== 'assistant') beforeAssistant = current;
  current = name;
  for (const s of $$('.screen')) s.hidden = s.dataset.screen !== name;
  window.scrollTo(0, 0);
  const enter = { survey: renderSurvey, camera: enterCamera, history: renderHistory, assistant: enterAssistant };
  if (enter[name]) enter[name]();
}

function consentGiven() {
  try { return localStorage.getItem('hv.consent') === '1'; } catch { return false; }
}

document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (!go) return;
  let to = go.dataset.go;
  if (to === 'survey' && !consentGiven() && current === 'start') to = 'consent';
  show(to);
});

/* ---------- согласие ---------- */

$('#consent-chk').addEventListener('change', (e) => { $('#consent-btn').disabled = !e.target.checked; });
$('#consent-btn').addEventListener('click', () => {
  try { localStorage.setItem('hv.consent', '1'); } catch { /* приватный режим: спросим снова в следующий раз */ }
  show('survey');
});

/* ---------- опрос ---------- */

const QUESTIONS = [
  { id: 'pregnant', key: 'survey.pregnant', opts: ['yes', 'no', 'unknown'], female: true },
  ...SYMPTOMS.map((k) => ({ id: k, key: `survey.q_${k}`, opts: [true, false], female: k === 'periods' })),
  ...RED_FLAGS.map((k) => ({ id: k, key: `survey.q_${k}`, opts: [true, false] })),
];
const OPT_KEY = { yes: 'common.yes', no: 'common.no', unknown: 'common.dont_know', true: 'common.yes', false: 'common.no' };

function renderSurvey() {
  const box = $('#questions');
  box.replaceChildren();
  const female = asksFemaleQuestions(state.survey);
  for (const q of QUESTIONS) {
    if (q.female && !female) continue;
    const row = document.createElement('div');
    row.className = 'q';
    const label = document.createElement('span');
    label.textContent = t(q.key);
    const seg = document.createElement('div');
    seg.className = 'seg';
    for (const v of q.opts) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t(OPT_KEY[String(v)]);
      if (state.survey[q.id] === v) b.className = 'on';
      b.addEventListener('click', () => { state.survey[q.id] = v; renderSurvey(); });
      seg.append(b);
    }
    row.append(label, seg);
    box.append(row);
  }
  for (const b of $$('.seg[data-q="sex"] button')) b.classList.toggle('on', state.survey.sex === b.dataset.v);
  const ev = evaluateSurvey(state.survey);
  const notes = $('#survey-notes');
  notes.replaceChildren();
  for (const k of ev.notes) {
    const p = document.createElement('p');
    p.className = 'warn';
    p.textContent = t(k);
    notes.append(p);
  }
  $('#redflag').hidden = !ev.redFlags.length;
  if (ev.redFlags.length) {
    $('#redflag-text').textContent = t('survey.redflag_text', { symptom: ev.redFlags.map((k) => t(`survey.flag_${k}`)).join(', ') });
  }
  $('#survey-next').textContent = t(ev.redFlags.length ? 'survey.redflag_continue' : 'survey.btn');
}

$('#age').addEventListener('input', (e) => {
  const v = e.target.value.trim();
  state.survey.age = v === '' ? NaN : Number(v);
  $('#age-err').hidden = v === '' || validAge(state.survey.age);
  renderSurvey();
});
for (const b of $$('.seg[data-q="sex"] button')) {
  b.addEventListener('click', () => { state.survey.sex = b.dataset.v; renderSurvey(); });
}
$('#survey-next').addEventListener('click', () => {
  if (!validAge(state.survey.age)) { $('#age-err').hidden = false; $('#age').focus(); return; }
  state.surveyEval = evaluateSurvey(state.survey);
  show(state.surveyEval.refuse ? 'refuse' : 'howto');
});

/* ---------- камера ---------- */

const IND = {
  light: { ok: ['ok', 'cam.light_ok'], dark: ['bad', 'cam.light_dark'], bright: ['bad', 'cam.light_bright'] },
  sharp: { ok: ['ok', 'cam.sharp_ok'], bad: ['warn', 'cam.sharp_bad'] },
  lid: { ok: ['ok', 'cam.lid_ok'], bad: ['bad', 'cam.lid_bad'] },
};

function setInd(id, cls, key) {
  const el = $(`#ind-${id}`);
  el.querySelector('.dot').className = `dot ${cls}`;
  el.querySelector('span:last-child').textContent = t(key);
}

async function enterCamera() {
  const video = $('#video');
  const shoot = $('#shoot');
  shoot.disabled = true;
  shoot.textContent = t('cam.btn_shoot_wait');
  $('#shoot-anyway').hidden = true;
  $('#cam-err').hidden = true;
  $('#cam-hint').textContent = '';
  for (const id of ['light', 'sharp', 'lid']) setInd(id, '', 'cam.waiting');
  try {
    await startCamera(video);
  } catch (e) {
    $('#cam-err').textContent = t(`cam.err_${e.code || 'none'}`);
    $('#cam-err').hidden = false;
    return;
  }
  const small = document.createElement('canvas');
  const started = Date.now();
  let blackFrames = 0;
  clearInterval(liveTimer);
  liveTimer = setInterval(() => {
    if (current !== 'camera') return;
    const r = checkFrame(video, small);
    if (!r) return;
    blackFrames = r.values.medV < 0.02 ? blackFrames + 1 : 0;
    for (const id of ['light', 'sharp', 'lid']) setInd(id, ...IND[id][r[id]]);
    const allOk = r.light === 'ok' && r.sharp === 'ok' && r.lid === 'ok';
    const firstBad = ['light', 'lid', 'sharp'].find((id) => r[id] !== 'ok');
    $('#cam-hint').textContent = firstBad ? t(IND[firstBad][r[firstBad]][1]) : '';
    shoot.disabled = !allOk;
    shoot.textContent = t(allOk ? 'cam.btn_shoot' : 'cam.btn_shoot_wait');
    if (Date.now() - started > 6000) $('#shoot-anyway').hidden = false;
    if (blackFrames > 8) { $('#cam-err').textContent = t('cam.err_black'); $('#cam-err').hidden = false; }
  }, 400);
}

function takePhoto() {
  capture($('#video'), state.photo);
  show('roi');
  enterRoi();
}
$('#shoot').addEventListener('click', takePhoto);
$('#shoot-anyway').addEventListener('click', takePhoto);
$('#open-camera').addEventListener('click', () => show('camera'));
$('#cam-back').addEventListener('click', () => show('howto'));

for (const input of $$('input.upload')) {
  input.addEventListener('change', async () => {
    const f = input.files && input.files[0];
    input.value = '';
    if (!f) return;
    try {
      await loadFile(f, state.photo);
      show('roi');
      enterRoi();
    } catch {
      $('#cam-err').textContent = t('sys.error');
      $('#cam-err').hidden = false;
    }
  });
}

/* ---------- отметка тканей ---------- */

function enterRoi() {
  const old = $('#roi-draw');
  const fresh = old.cloneNode(false);     // новый холст без старых обработчиков
  old.replaceWith(fresh);
  state.roi = createRoi($('#roi-photo'), fresh, state.photo);
  $('#roi-err').hidden = true;
  setRoiMode('lid');
  state.roi.onChange = (c) => {
    $('#roi-step').textContent = `${t('roi.step1')}${c.lid ? ' ✓' : ''}\n${t('roi.step2')}${c.sclera ? ' ✓' : ''}`;
    if (c.lid && !c.sclera && state.roi && state.roi.getMode() === 'lid' && autoSwitch) { autoSwitch = false; setRoiMode('sclera'); }
  };
}
let autoSwitch = true;

function setRoiMode(m) {
  if (!state.roi) return;
  state.roi.setMode(m);
  $('#mode-lid').classList.toggle('on', m === 'lid');
  $('#mode-sclera').classList.toggle('on', m === 'sclera');
}
$('#mode-lid').addEventListener('click', () => { autoSwitch = false; setRoiMode('lid'); });
$('#mode-sclera').addEventListener('click', () => { autoSwitch = false; setRoiMode('sclera'); });
$('#roi-undo').addEventListener('click', () => state.roi && state.roi.undo());
$('#roi-reset').addEventListener('click', () => { if (state.roi) { state.roi.reset(); autoSwitch = true; setRoiMode('lid'); } });
$('#roi-retake').addEventListener('click', retake);

$('#roi-done').addEventListener('click', () => {
  const c = state.roi.counts();
  const err = $('#roi-err');
  if (!c.lid) { err.textContent = t('roi.err_lid_small'); err.hidden = false; setRoiMode('lid'); return; }
  if (!c.sclera) { err.textContent = t('roi.err_sclera'); err.hidden = false; setRoiMode('sclera'); return; }
  err.textContent = t('res.processing');
  err.hidden = false;
  setTimeout(analyze, 30);   // дать браузеру показать «Считаем…»
});

/* ---------- анализ и результат ---------- */

function analyze() {
  const t0 = performance.now();
  const { lid, sclera } = state.roi.masks();
  const W = state.photo.width, H = state.photo.height;
  const data = state.photo.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H);
  const img = fromImageData(data);
  const features = extractFeatures(img, lid, sclera);
  const qc = roiCheck(img, lid, sclera, features);
  const quality = sharpnessGrade(toGray(data.data, W * H), W, H, maskBBox(lid, W));
  const a = assess(state.model, features, qc);
  state.result = { date: new Date(), features, qc, quality, assess: a, ms: Math.round(performance.now() - t0), thumb: null };
  $('#roi-err').hidden = true;
  renderResult();
  show('result');
}

function textP(text, cls) {
  const p = document.createElement('p');
  p.textContent = text;
  if (cls) p.className = cls;
  return p;
}

function renderResult() {
  const r = state.result;
  const z = r.assess.zone;
  const ev = state.surveyEval;
  $('#zone').className = `zone ${z}`;
  $('#zone-name').textContent = t(`res.zone_${z}`);
  $$('#zone-bar i').forEach((i, k) => i.classList.toggle('mark', ['low', 'mid', 'high'][k] === z));

  const rf = $('#res-redflag');
  rf.hidden = !ev.redFlags.length;
  if (ev.redFlags.length) {
    rf.replaceChildren(textP(t('survey.redflag_title')), textP(t('survey.redflag_text', { symptom: ev.redFlags.map((k) => t(`survey.flag_${k}`)).join(', ') })));
    rf.firstChild.className = 'advice';
  }
  const adv = $('#res-advice');
  adv.replaceChildren();
  for (const k of advice(z, ev)) {
    if (k === 'survey.redflag_title') continue;
    if (k === 'res.advice_na') {
      adv.append(textP(t(k, { reason: r.assess.reasons.map((x) => t(x)).join('; ') }), 'advice'));
    } else if (k === 'res.symptoms_boost') {
      continue;   // показываем в блоке «Ваши ответы»
    } else {
      adv.append(textP(`➜ ${t(k)}`, 'advice'));
    }
  }

  const plan = $('#plan-list');
  plan.replaceChildren(...personalPlan(z, ev, state.survey).map((k) => {
    const li = document.createElement('li');
    li.textContent = t(k);
    if (k === 'plan.urgent') li.className = 'urgent';
    return li;
  }));

  const na = z === 'na';
  $('#res-details').hidden = na;
  $('#res-actions').hidden = na;
  $('#res-na-actions').hidden = !na;
  if (!na) {
    const f = r.features.wb;
    $('#res-why').textContent = t(r.assess.why);
    $('#res-indices').textContent = t('res.indices', { ei: num(f.EI_p50, 3), a: num(f.a_p50, 1), l: num(f.L_p50, 1), hhr: num(f.HHR, 2) });
    $('#res-quality').textContent = t('res.quality', { q: t(r.quality === 'good' ? 'res.quality_good' : 'res.quality_fair') });
    const sym = $('#res-symptoms');
    const list = ev.symptoms.map((k) => t(`survey.sym_${k}`)).join(', ');
    sym.replaceChildren(textP(ev.symptoms.length ? t('res.symptoms_list', { list }) : t('res.symptoms_none')));
    if (advice(z, ev).includes('res.symptoms_boost')) sym.append(textP(t('res.symptoms_boost')));
    sym.append(textP(t('res.symptoms_note'), 'small'));
    const notes = $('#res-notes');
    notes.replaceChildren(...ev.notes.map((k) => textP(t(k), 'warn')));
    $('#res-model').textContent = t(state.model.status === 'trained' ? 'res.model_A' : 'res.model_B');
    $('#res-save').disabled = false;
    $('#res-save').textContent = t('res.btn_save');
  }
}

function thumbnail(canvas, size = 160) {
  const k = size / Math.max(canvas.width, canvas.height);
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * k); c.height = Math.round(canvas.height * k);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}

function retake() {
  show('camera');
}
$('#res-retake').addEventListener('click', retake);
$('#na-retake').addEventListener('click', retake);

$('#save-photo').addEventListener('change', (e) => {
  if (state.result) state.result.thumb = e.target.checked ? thumbnail(state.photo) : null;
});

$('#res-save').addEventListener('click', async () => {
  const r = state.result;
  const f = r.features.wb;
  try {
    await addRecord({
      ts: r.date.getTime(), zone: r.assess.zone, ei: f.EI_p50, a: f.a_p50, L: f.L_p50, hhr: f.HHR,
      rel_lRG: r.features.rel ? r.features.rel.rel_lRG : null, quality: r.quality, model: state.model.version,
      thumb: r.thumb || null,
    });
    $('#res-save').textContent = t('res.saved');
    $('#res-save').disabled = true;
  } catch {
    $('#res-save').textContent = t('sys.storage_full');
  }
});

$('#to-report').addEventListener('click', () => {
  renderReport($('#report'), { ...state.result, survey: state.survey, surveyEval: state.surveyEval, model: state.model, appVersion: APP_VERSION });
  show('report');
});
$('#print').addEventListener('click', () => window.print());

/* ---------- история ---------- */

function chart(records) {
  const pts = records.filter((r) => r.zone !== 'na' && Number.isFinite(r.ei));
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 320 120');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', t('hist.chart'));
  const label = document.createElementNS(NS, 'text');
  label.setAttribute('x', '8'); label.setAttribute('y', '16'); label.setAttribute('font-size', '11'); label.setAttribute('fill', '#6b6b70');
  label.textContent = t('hist.chart');
  svg.append(label);
  if (pts.length) {
    const eis = pts.map((p) => p.ei);
    const lo = Math.min(...eis) - 0.02, hi = Math.max(...eis) + 0.02;
    const x = (i) => (pts.length === 1 ? 160 : 20 + (280 * i) / (pts.length - 1));
    const y = (v) => 108 - (80 * (v - lo)) / (hi - lo);
    const line = document.createElementNS(NS, 'polyline');
    line.setAttribute('points', pts.map((p, i) => `${x(i)},${y(p.ei)}`).join(' '));
    line.setAttribute('fill', 'none'); line.setAttribute('stroke', '#7a1f2b'); line.setAttribute('stroke-width', '2');
    svg.append(line);
    const color = { low: '#2e9e4f', mid: '#d9a400', high: '#d33a2c' };
    pts.forEach((p, i) => {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', x(i)); c.setAttribute('cy', y(p.ei)); c.setAttribute('r', '4.5'); c.setAttribute('fill', color[p.zone]);
      svg.append(c);
    });
  }
  return svg;
}

async function renderHistory() {
  let recs = [];
  try { recs = await listRecords(); } catch { recs = []; }
  recs.sort((a, b) => a.ts - b.ts);
  $('#hist-chart').replaceChildren(recs.length ? chart(recs) : '');
  $('#hist-empty').hidden = recs.length > 0;
  $('#hist-delete').hidden = recs.length === 0;
  const locale = getLang() === 'kk' ? 'kk-KZ' : 'ru-RU';
  const list = $('#hist-list');
  list.replaceChildren();
  for (const r of [...recs].reverse()) {
    const row = document.createElement('div');
    row.className = 'item';
    const d = new Date(r.ts);
    const cells = [d.toLocaleString(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
      `${{ low: '🟢', mid: '🟡', high: '🔴', na: '⚪' }[r.zone]} ${t(`res.zone_${r.zone}_s`)}`,
      r.zone === 'na' ? '—' : `EI ${num(r.ei, 3)}`];
    for (const c of cells) { const s = document.createElement('span'); s.textContent = c; row.append(s); }
    if (r.thumb) { const img = document.createElement('img'); img.src = r.thumb; img.alt = ''; row.prepend(img); }
    list.append(row);
  }
}

function confirmModal(text) {
  return new Promise((resolve) => {
    $('#modal-text').textContent = text;
    $('#modal').hidden = false;
    const done = (v) => { $('#modal').hidden = true; $('#modal-yes').onclick = $('#modal-no').onclick = null; resolve(v); };
    $('#modal-yes').onclick = () => done(true);
    $('#modal-no').onclick = () => done(false);
  });
}

$('#hist-delete').addEventListener('click', async () => {
  if (!(await confirmModal(t('hist.confirm')))) return;
  try { await clearRecords(); } catch { /* пусто */ }
  renderHistory();
});

/* ---------- ассистент (AI Personalizer) ---------- */

const QUICK = ['my_result', 'cbc', 'iron_food', 'is_diagnosis'];

function topicTitle(id, lang = getLang()) {
  const kb = state.kb[lang] || state.kb.ru;
  const tp = kb.kb.topics.find((x) => x.id === id);
  return tp ? tp.title : id;
}

/** Ответ на «что значит мой результат» из последнего результата и опроса этого сеанса. */
function resultExplanation(_id, lang) {
  const tt = (k, v) => tIn(lang, k, v);
  if (!state.result) return tt('asst.result_none');
  const z = state.result.assess.zone;
  let s = tt(`asst.result_${z}`);
  const ev = state.surveyEval;
  if (ev && ev.symptoms.length) s += ' ' + tt('asst.result_sym', { list: ev.symptoms.map((k) => tt(`survey.sym_${k}`)).join(', ') });
  return s;
}

function addMsg(who, text, cls = '', meta = '') {
  state.chat.push({ who, text, cls, meta });
  renderChat();
}

function renderChat() {
  const box = $('#chat');
  box.replaceChildren(...state.chat.map((m) => {
    const d = document.createElement('div');
    d.className = `msg ${m.who} ${m.cls}`;
    if (m.meta) { const s = document.createElement('span'); s.className = 'meta'; s.textContent = m.meta; d.append(s); }
    d.append(document.createTextNode(m.text));
    return d;
  }));
  box.lastElementChild && box.lastElementChild.scrollIntoView({ block: 'end', behavior: 'smooth' });
}

function renderChips(ids, lang = getLang()) {
  const box = $('#chips');
  box.replaceChildren(...ids.map((id) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = topicTitle(id, lang);
    b.addEventListener('click', () => ask(topicTitle(id, lang)));
    return b;
  }));
}

function ask(text) {
  const q = text.trim();
  if (!q) return;
  addMsg('me', q);
  const r = answer(state.kb, q, { lang: getLang(), dynamic: resultExplanation });
  if (r.type === 'topic') {
    addMsg('bot', r.text, '', t('asst.understood', { title: topicTitle(r.id, r.lang) }));
  } else {
    addMsg('bot', r.text, r.type === 'urgent' || r.type === 'crisis' ? 'urgent' : '');
  }
  const more = (r.suggestions || []).filter((id) => id !== r.id).slice(0, 3);
  renderChips(more.length ? more : QUICK, r.lang);
}

function enterAssistant() {
  $('#asst-disclaimer').textContent = (state.kb[getLang()] || state.kb.ru).kb.disclaimer;
  $('#asst-input').placeholder = t('asst.placeholder');
  if (!state.chat.length) addMsg('bot', t('asst.hello'));
  else renderChat();
  renderChips(state.result ? QUICK : QUICK.filter((id) => id !== 'my_result'));
}

$('#asst-send').addEventListener('click', () => { const i = $('#asst-input'); ask(i.value); i.value = ''; });
$('#asst-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); ask(e.target.value); e.target.value = ''; }
});
$('#asst-back').addEventListener('click', () => show(beforeAssistant));

/* ---------- язык, установка, офлайн ---------- */

$('#lang-btn').addEventListener('click', () => {
  setLang(getLang() === 'ru' ? 'kk' : 'ru');
  installHint();
  if (current === 'survey') renderSurvey();
  if (current === 'result') renderResult();
  if (current === 'history') renderHistory();
  if (current === 'assistant') enterAssistant();
});

function installHint() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) return;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const el = $('#install-hint');
  el.textContent = t(ios ? 'start.install_ios' : 'start.install_android');
  el.hidden = false;
}

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  // новая версия приложения взяла управление → один раз перезагрузить страницу, чтобы показать её
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloaded && current === 'start') { reloaded = true; window.location.reload(); }
  });
  try {
    const reg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
    reg.update().catch(() => {});
    await navigator.serviceWorker.ready;
    $('#offline-ready').hidden = false;
  } catch { /* без service worker приложение работает, но не офлайн */ }
}

/* ---------- старт ---------- */

async function main() {
  await loadI18n();
  setLang(getLang());
  const kbs = await Promise.all(['ru', 'kk'].map((l) => fetch(`kb/${l}.json`).then((x) => x.json())));
  state.kb = { ru: buildIndex(kbs[0]), kk: buildIndex(kbs[1]) };
  const r = await fetch('model/model.json');
  state.model = await r.json();
  const errs = validateModel(state.model);
  if (errs.length) throw new Error(`model.json: ${errs.join('; ')}`);
  $('#about-version').textContent = `HemaVision Lite ${APP_VERSION} · ${t('about.model')}: ${state.model.version}`;
  $('#start-version').textContent = `v${APP_VERSION}`;
  installHint();
  show('start');
  registerSW();
}

main().catch((e) => {
  document.body.textContent = `HemaVision Lite: ${e.message}`;
});
