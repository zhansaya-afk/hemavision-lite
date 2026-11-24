// Отчёт для врача: страница печатается браузером в PDF (кириллица без проблем, без библиотек).

import { t, num, getLang } from './i18n.js';

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function row(tbody, label, value) {
  const tr = el('tr');
  tr.append(el('td', label), el('td', value));
  tbody.append(tr);
}

/**
 * r = { date, survey, surveyEval, assess, features, quality, model, thumb }
 */
export function renderReport(root, r) {
  root.replaceChildren();
  root.append(el('h2', t('rep.title')));
  const table = el('table');
  const tb = el('tbody');
  table.append(tb);
  const locale = getLang() === 'kk' ? 'kk-KZ' : 'ru-RU';
  row(tb, t('rep.date'), `${r.date.toLocaleString(locale)} · HemaVision Lite ${r.appVersion}`);
  const sex = r.survey.sex === 'f' ? t('survey.sex_f') : r.survey.sex === 'm' ? t('survey.sex_m') : '—';
  row(tb, t('rep.patient'), `${Number.isFinite(r.survey.age) ? r.survey.age : '—'} / ${sex}`);
  row(tb, t('rep.zone'), t(`res.zone_${r.assess.zone}`));
  if (r.assess.zone !== 'na' && r.features.wb) {
    const f = r.features.wb;
    const rel = r.features.rel;
    row(tb, t('rep.indices'),
      `EI ${num(f.EI_p50, 3)} · a* ${num(f.a_p50, 1)} · L* ${num(f.L_p50, 1)} · HHR ${num(f.HHR, 2)}` +
      (rel ? ` · rel_lRG ${num(rel.rel_lRG, 2)}` : ''));
    row(tb, t('rep.ref'), t('rep.ref_value'));
    row(tb, t('rep.quality'), t(r.quality === 'good' ? 'res.quality_good' : 'res.quality_fair'));
  } else {
    row(tb, t('rep.quality'), r.assess.reasons.map((k) => t(k)).join('; '));
  }
  row(tb, t('rep.symptoms'), r.surveyEval.symptoms.length ? r.surveyEval.symptoms.map((k) => t(`survey.sym_${k}`)).join(', ') : t('res.symptoms_none'));
  row(tb, t('rep.redflags'), r.surveyEval.redFlags.length ? r.surveyEval.redFlags.map((k) => t(`survey.flag_${k}`)).join(', ') : t('rep.none'));
  row(tb, t('rep.model'), `${r.model.version} — ${t(r.model.status === 'trained' ? 'res.model_A' : 'res.model_B')}`);
  if (r.thumb) {
    const tr = el('tr');
    const td = el('td');
    const img = el('img');
    img.src = r.thumb; img.alt = '';
    td.append(img);
    tr.append(el('td', t('rep.photo')), td);
    tb.append(tr);
  }
  root.append(table);
  root.append(el('p', t('rep.recommend')));
  root.append(el('p', t('rep.disclaimer_full'), 'disc'));
}
