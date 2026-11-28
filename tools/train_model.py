"""Обучение шкалы риска HemaVision Lite → model/model.json + model/metrics.md.

Запускается в Google Colab (данные в облаке GitHub недоступны). Ничего, кроме коэффициентов, порогов
и сводных метрик, в репозиторий не попадает: фото и признаки пациентов остаются в Colab.

Вход: CSV-манифест набора Eyes-defy-anemia (одна строка — снимок):
    image, mask_conj, hb_g_l, anemic, group, patient_id, [fold]
    пути image/mask_conj — относительно --data; anemic — 1/0 по нормам ВОЗ с учётом пола и возраста;
    group — пациент (и копии его снимков); страна — из patient_id (ED_<страна>_<id>); fold — готовые фолды (иначе считаем сами).

Признаки (те же формулы, что src/features.js, проверка — tests/golden.json):
    медианы EI, a*, L* и HHR по пикселям ткани внутри маски конъюнктивы (врачебной разметки набора).

Проверка: StratifiedGroupKFold по пациенту, 5 фолдов. Пороги зон подбираются ТОЛЬКО на обучающих фолдах
(вложенная CV): low — чувствительность 0,80 на train, high — специфичность 0,90 на train.
На тесте: AUC (бутстрэп по пациентам), чувствительность/специфичность при p ≥ low (ДИ Уилсона),
доля анемии в каждой зоне, отдельно по странам и базовая модель «всегда частый класс».

Режим уверенного ответа (--confident 0.95, по умолчанию): второй набор порогов, тоже только на обучающих фолдах:
ответ «норма»/«анемия» даётся лишь тем, у кого внутри train доля верных ≥ цели; остальным — «не уверены, сдайте ОАК».
На тесте: покрытие (кому дан ответ), доля верных среди ответов, NPV, PPV — с ДИ Уилсона, по странам.
В приложении эти пороги пока не используются (model.json → confident.status).

Запуск:  python tools/train_model.py --manifest <manifest.csv> --data <корень данных>
"""
import argparse
import json
import math
from datetime import date
from pathlib import Path

import cv2
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import StratifiedGroupKFold

FEATURES = ['EI_p50', 'a_p50', 'L_p50', 'HHR']
EPS = 1e-4
SENS_TARGET, SPEC_TARGET = 0.80, 0.90
ROOT = Path(__file__).resolve().parent.parent


# ---------- признаки (зеркало src/features.js) ----------

def tissue_mask(rgb, mask, min_px=30):
    v = rgb.max(-1)
    s = (v - rgb.min(-1)) / (v + EPS)
    m = mask & (v > 0.08) & ~((v > 0.92) & (s < 0.25))
    if m.sum() < min_px:
        return mask & (v > 0.03)
    lo, hi = np.percentile(v[m], [3, 99])
    return m & (v >= lo) & (v <= hi)


def hsi_hue(px):
    R, G, B = px[:, 0], px[:, 1], px[:, 2]
    num = 0.5 * ((R - G) + (R - B))
    den = np.sqrt((R - G) ** 2 + (R - B) * (G - B))
    th = np.degrees(np.arccos(np.clip(num / np.maximum(den, 1e-12), -1, 1)))
    th = np.where(den < 1e-8, 0.0, th)
    H = np.where(B <= G, th, 360 - th)
    return np.where(H > 180, H - 360, H)


def features(rgb, mask):
    m = tissue_mask(rgb, mask)
    if m.sum() < 30:
        return None
    px = np.clip(rgb[m], 1 / 255, 1).astype(np.float32)
    lab = cv2.cvtColor(px[None], cv2.COLOR_RGB2Lab)[0]
    hue = hsi_hue(px)
    return {
        'EI_p50': float(np.median(np.log10(px[:, 0]) - np.log10(px[:, 1]))),
        'a_p50': float(np.median(lab[:, 1])),
        'L_p50': float(np.median(lab[:, 0])),
        'HHR': float(np.mean(np.abs(hue) < 10)),
    }


def load_rgb(path, max_side=1024):
    bgr = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if bgr is None:
        return None
    k = min(1.0, max_side / max(bgr.shape[:2]))
    if k < 1:
        bgr = cv2.resize(bgr, None, fx=k, fy=k, interpolation=cv2.INTER_AREA)
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB).astype(np.float32) / 255


def load_mask(path, shape):
    m = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if m is None:
        return None
    m = cv2.resize(m, (shape[1], shape[0]), interpolation=cv2.INTER_NEAREST)
    return m > 127


def country_of(r):
    """Страна из patient_id (ED_<страна>_<id>); колонка population — возрастная группа, не страна."""
    pid = str(getattr(r, 'patient_id', '') or '')
    parts = pid.split('_')
    return parts[1] if len(parts) >= 3 and parts[0] == 'ED' else 'не указана'


def build_table(manifest, data):
    rows = []
    for r in manifest.itertuples():
        if not isinstance(r.mask_conj, str) or not r.mask_conj:
            continue
        rgb = load_rgb(Path(data) / r.image)
        if rgb is None:
            continue
        mask = load_mask(Path(data) / r.mask_conj, rgb.shape)
        f = features(rgb, mask) if mask is not None else None
        if f is None:
            continue
        rows.append({**f, 'anemic': int(r.anemic), 'group': str(r.group), 'country': country_of(r),
                     'fold': int(r.fold) if 'fold' in manifest.columns and pd.notna(r.fold) else -1})
    return pd.DataFrame(rows)


# ---------- модель и пороги ----------

def fit(X, y):
    mean, std = X.mean(0), X.std(0) + 1e-9
    clf = LogisticRegression(C=1.0, max_iter=1000).fit((X - mean) / std, y)
    return {'mean': mean, 'std': std, 'coef': clf.coef_[0], 'intercept': float(clf.intercept_[0])}


def predict(m, X):
    z = ((X - m['mean']) / m['std']) @ m['coef'] + m['intercept']
    return 1 / (1 + np.exp(-z))


def folds(y, groups, seed=0, n=5):
    return list(StratifiedGroupKFold(n_splits=n, shuffle=True, random_state=seed).split(np.zeros(len(y)), y, groups))


def thresholds_from(p, y):
    """low: наибольший порог с чувствительностью ≥ 0,80; high: наименьший порог со специфичностью ≥ 0,90."""
    pos, neg = np.sort(p[y == 1]), np.sort(p[y == 0])
    low = float(pos[int(math.floor((1 - SENS_TARGET) * len(pos)))]) if len(pos) else 0.5
    high = float(neg[min(len(neg) - 1, int(math.ceil(SPEC_TARGET * len(neg))) - 1)]) + 1e-9 if len(neg) else 0.5
    high = max(high, low)
    return min(max(low, 1e-6), 1 - 1e-6), min(max(high, 1e-6), 1 - 1e-6)


def inner_thresholds(X, y, g, seed):
    """Пороги по OOF-вероятностям внутри обучающей части (тест не участвует)."""
    oof = np.zeros(len(y))
    for tr, te in folds(y, g, seed, n=min(5, len(np.unique(g)))):
        oof[te] = predict(fit(X[tr], y[tr]), X[te])
    return thresholds_from(oof, y)


# ---------- режим уверенного ответа ----------
# Ответ «уверенно норма» при p < c_neg и «уверенно анемия» при p >= c_pos; между ними — «не уверены, сдайте ОАК».
# Пороги — ТОЛЬКО по OOF внутри обучающей части: c_neg — наибольший порог, при котором доля здоровых среди
# p < c_neg (NPV) ≥ target; c_pos — наименьший, при котором доля анемии среди p ≥ c_pos (PPV) ≥ target.
# Если цель недостижима, сторона закрывается (никому такой ответ не даём). Тест на выбор порогов не влияет.

MIN_SIDE = 5  # меньше 5 обучающих снимков в зоне — порог не ставим (оценка доли ненадёжна)


def confident_thresholds(p, y, target):
    order = np.argsort(p)
    ps, ys = p[order], y[order]
    n = len(ys)
    c_neg = 0.0  # 0 — никто не получает «уверенно норма»
    healthy = np.cumsum(1 - ys)  # здоровых среди первых k+1
    for k in range(MIN_SIDE - 1, n):
        if k + 1 < n and ps[k + 1] == ps[k]:
            continue
        if healthy[k] / (k + 1) >= target:
            c_neg = float(ps[k]) + 1e-9 if k + 1 == n else float((ps[k] + ps[k + 1]) / 2)
    c_pos = 1.0  # 1 — никто не получает «уверенно анемия»
    anem = np.cumsum(ys[::-1])  # анемия среди последних k+1
    for k in range(MIN_SIDE - 1, n):
        i = n - 1 - k  # индекс самого низкого p в хвосте
        if i > 0 and ps[i - 1] == ps[i]:
            continue
        if anem[k] / (k + 1) >= target:
            c_pos = float(ps[i])
    if c_neg > c_pos:  # перекрытие при маленьких данных — закрываем обе стороны
        c_neg, c_pos = 0.0, 1.0
    return c_neg, c_pos


def inner_confident(X, y, g, seed, target):
    oof = np.zeros(len(y))
    for tr, te in folds(y, g, seed, n=min(5, len(np.unique(g)))):
        oof[te] = predict(fit(X[tr], y[tr]), X[te])
    return confident_thresholds(oof, y, target)


def confident_block(name, y, conf):
    """conf: 'neg' | 'pos' | 'unsure' для каждого тестового снимка."""
    neg, pos = conf == 'neg', conf == 'pos'
    acc_n = int((neg & (y == 0)).sum() + (pos & (y == 1)).sum())
    acc_d = int(neg.sum() + pos.sum())
    return {'name': name, 'n': int(len(y)),
            'coverage': wilson(acc_d, len(y)), 'acc': wilson(acc_n, acc_d),
            'npv': wilson(int((neg & (y == 0)).sum()), int(neg.sum())),
            'ppv': wilson(int((pos & (y == 1)).sum()), int(pos.sum())),
            'n_neg': int(neg.sum()), 'n_pos': int(pos.sum()), 'n_unsure': int((conf == 'unsure').sum()),
            'anemic_in_neg': int((neg & (y == 1)).sum()), 'anemic_total': int((y == 1).sum()),
            'anemic_caught': int((pos & (y == 1)).sum())}


# ---------- метрики ----------

def wilson(k, n, z=1.96):
    if n == 0:
        return (float('nan'),) * 3
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return p, c - h, c + h


def auc_ci(y, p, g, n_boot=2000, seed=0):
    if len(np.unique(y)) < 2:
        return (float('nan'),) * 3
    rng = np.random.default_rng(seed)
    ug = np.unique(g)
    idx = {k: np.where(g == k)[0] for k in ug}
    vals = []
    for _ in range(n_boot):
        s = np.concatenate([idx[k] for k in rng.choice(ug, len(ug))])
        if len(np.unique(y[s])) == 2:
            vals.append(roc_auc_score(y[s], p[s]))
    return float(roc_auc_score(y, p)), float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5))


def block(name, y, p, zone, g):
    pos = zone != 'low'
    tp, fn = int((pos & (y == 1)).sum()), int((~pos & (y == 1)).sum())
    tn, fp = int((~pos & (y == 0)).sum()), int((pos & (y == 0)).sum())
    auc = auc_ci(y, p, g)
    sens, spec = wilson(tp, tp + fn), wilson(tn, tn + fp)
    zones = {z: (int((zone == z).sum()), float(y[zone == z].mean()) if (zone == z).any() else float('nan'))
             for z in ('low', 'mid', 'high')}
    return {'name': name, 'n': int(len(y)), 'patients': int(len(np.unique(g))), 'prevalence': float(y.mean()),
            'auc': auc, 'sens': sens, 'spec': spec, 'tp_fp_fn_tn': [tp, fp, fn, tn], 'zones': zones}


def fmt(x, d=2):
    return '—' if x is None or (isinstance(x, float) and math.isnan(x)) else f'{x:.{d}f}'.replace('.', ',')


def ci(t):
    return f'{fmt(t[0])} [{fmt(t[1])}; {fmt(t[2])}]'


def confident_lines(cblocks, target):
    pct = lambda t: '—' if t[0] != t[0] else f"{t[0] * 100:.0f}% [{t[1] * 100:.0f}; {t[2] * 100:.0f}]"
    lines = ['', f'## Режим уверенного ответа (цель {target * 100:.0f}% верных среди ответов)', '',
             'Пороги — только на обучающих фолдах (вложенная CV), на тесте не подбирались. «Не уверены» = совет сдать ОАК, '
             'это не ответ «норма». Верность считается только среди тех, кому дан уверенный ответ.', '',
             '| Группа | Снимков | Дан ответ (покрытие) | Верных среди ответов | «Норма»: здоровых (NPV) | «Анемия»: анемия (PPV) | '
             'Анемия в «норме» / всего анемии |', '|---|---|---|---|---|---|---|']
    for b in cblocks:
        lines.append(f"| {b['name']} | {b['n']} | {pct(b['coverage'])} | {pct(b['acc'])} | "
                     f"{pct(b['npv'])} (n={b['n_neg']}) | {pct(b['ppv'])} (n={b['n_pos']}) | "
                     f"{b['anemic_in_neg']} / {b['anemic_total']} |")
    lines += ['', 'Чтение: если покрытие низкое, ~95% верных — это ответы для небольшой и самой простой части людей '
              '(часто здоровых); остальным система честно говорит «не уверены, сдайте ОАК». Цель считается достигнутой, '
              'только если нижняя граница ДИ «верных среди ответов» ≥ цели.', '']
    return lines


def write_metrics(path, blocks, base, model, n_skipped, extra=None):
    lines = [
        '# Метрики шкалы риска (tools/train_model.py)', '',
        f'Дата: {date.today().isoformat()}. Набор: Eyes-defy-anemia (взрослые, Италия и Индия), снимки с макронасадкой '
        'и LED-подсветкой, **не смартфон**. Проверка: StratifiedGroupKFold по пациенту, 5 фолдов; пороги зон — '
        'только на обучающих фолдах. Положительный класс — анемия по ВОЗ.', '',
        f'Признаки: {", ".join(FEATURES)} (медианы по ткани в врачебной маске конъюнктивы). Пропущено снимков '
        f'(нет маски/мало ткани): {n_skipped}.', '',
        '| Группа | Снимков | Пациентов | Доля анемии | AUC [95% ДИ] | Чувств. при p ≥ low | Спец. при p ≥ low |',
        '|---|---|---|---|---|---|---|',
    ]
    for b in blocks:
        lines.append(f"| {b['name']} | {b['n']} | {b['patients']} | {fmt(b['prevalence'])} | {ci(b['auc'])} | "
                     f"{ci(b['sens'])} | {ci(b['spec'])} |")
    lines += ['', '**Зоны на тесте** (сколько снимков и доля анемии внутри зоны):', '',
              '| Группа | низкий | средний | высокий |', '|---|---|---|---|']
    for b in blocks:
        z = b['zones']
        lines.append(f"| {b['name']} | " + ' | '.join(f"{z[k][0]} ({fmt(z[k][1])})" for k in ('low', 'mid', 'high')) + ' |')
    lines += ['', f"Базовая модель «всегда частый класс»: accuracy {fmt(base)} (AUC 0,5).", '',
              '**Ограничения.** Это не независимая проверка: один набор, одна насадка, один протокол съёмки. '
              'Страны различаются долей анемии и яркостью кадров, поэтому общий AUC частично отражает страну — '
              'смотрите строки по странам. На снимках смартфона точность не измерялась. Детей и беременных в '
              'наборе нет. Это скрининг риска, не диагноз и не измерение гемоглобина.', '',
              f"Модель в приложении: {model['version']}, пороги low = {fmt(model['thresholds']['low'], 3)}, "
              f"high = {fmt(model['thresholds']['high'], 3)}.", '']
    lines += extra or []
    Path(path).write_text('\n'.join(lines), encoding='utf-8')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--manifest', required=True)
    ap.add_argument('--data', required=True)
    ap.add_argument('--dataset', default='eyes_defy', help='фильтр по колонке dataset, если она есть')
    ap.add_argument('--out', default=str(ROOT / 'model'))
    ap.add_argument('--seed', type=int, default=0)
    ap.add_argument('--confident', type=float, default=0.95,
                    help='цель доли верных ответов для режима уверенного ответа (0 — не считать)')
    a = ap.parse_args()

    man = pd.read_csv(a.manifest)
    if 'dataset' in man.columns:
        man = man[man.dataset == a.dataset]
    df = build_table(man, a.data)
    if len(df) < 20 or df.anemic.nunique() < 2:
        raise SystemExit(f'мало данных для обучения: {len(df)} снимков')
    X, y, g = df[FEATURES].to_numpy(float), df.anemic.to_numpy(int), df.group.to_numpy()
    print(f'снимков с признаками: {len(df)} из {len(man)}; пациентов: {len(np.unique(g))}; анемия: {y.mean():.2f}')

    outer = ([(np.where(df.fold != k)[0], np.where(df.fold == k)[0]) for k in sorted(df.fold.unique())]
             if (df.fold >= 0).all() else folds(y, g, a.seed))
    p = np.zeros(len(y))
    zone = np.empty(len(y), dtype=object)
    conf = np.full(len(y), 'unsure', dtype=object)
    for tr, te in outer:
        m = fit(X[tr], y[tr])
        lo, hi = inner_thresholds(X[tr], y[tr], g[tr], a.seed)
        p[te] = predict(m, X[te])
        zone[te] = np.where(p[te] < lo, 'low', np.where(p[te] >= hi, 'high', 'mid'))
        if a.confident:
            cn, cp = inner_confident(X[tr], y[tr], g[tr], a.seed, a.confident)
            conf[te] = np.where(p[te] < cn, 'neg', np.where(p[te] >= cp, 'pos', 'unsure'))

    blocks = [block('Все (OOF)', y, p, zone, g)]
    for c in sorted(df.country.unique()):
        s = (df.country == c).to_numpy()
        blocks.append(block(f'Только {c}', y[s], p[s], zone[s], g[s]))
    base = max(y.mean(), 1 - y.mean())
    extra, cblocks = [], []
    if a.confident:
        cblocks = [confident_block('Все (OOF)', y, conf)]
        for c in sorted(df.country.unique()):
            s_ = (df.country == c).to_numpy()
            cblocks.append(confident_block(f'Только {c}', y[s_], conf[s_]))
        extra = confident_lines(cblocks, a.confident)

    final = fit(X, y)
    lo, hi = inner_thresholds(X, y, g, a.seed)
    model = {
        'version': f'logreg-{date.today().isoformat()}',
        'status': 'trained',
        'feature_set': 'raw',  # признаки обучения — без баланса белого (в наборе нет отметки склеры)
        'note': ('Логистическая регрессия на Eyes-defy-anemia (макронасадка, LED). Признаки века считаются без баланса '
                 'белого (как при обучении: в наборе нет отметки склеры); склера в приложении — только проверка цветного '
                 'света. На смартфоне точность не измерена.'),
        'features': [{'name': n, 'mean': float(final['mean'][i]), 'std': float(final['std'][i]),
                      'coef': float(final['coef'][i])} for i, n in enumerate(FEATURES)],
        'intercept': final['intercept'],
        'thresholds': {'low': lo, 'high': hi},
        **({'confident': dict(zip(('neg_below', 'pos_from'), inner_confident(X, y, g, a.seed, a.confident)),
                              target=a.confident, status='measured, not shown in app',
                              coverage_oof=cblocks[0]['coverage'][0], acc_oof=cblocks[0]['acc'][0],
                              acc_ci=cblocks[0]['acc'][1:])} if a.confident else {}),
        'metrics': {'auc_oof': blocks[0]['auc'][0], 'auc_ci': blocks[0]['auc'][1:], 'n_patients': blocks[0]['patients'],
                    'sens_at_low': blocks[0]['sens'][0], 'spec_at_low': blocks[0]['spec'][0],
                    'by_country_auc': {b['name']: b['auc'][0] for b in blocks[1:]},
                    'domain': 'Eyes-defy, clip-on macro lens, not smartphone', 'details': 'model/metrics.md'},
    }
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / 'model.json').write_text(json.dumps(model, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    write_metrics(out / 'metrics.md', blocks, base, model, len(man) - len(df), extra)
    print((out / 'metrics.md').read_text(encoding='utf-8'))


if __name__ == '__main__':
    main()
