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


def write_metrics(path, blocks, base, model, n_skipped):
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
    Path(path).write_text('\n'.join(lines), encoding='utf-8')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--manifest', required=True)
    ap.add_argument('--data', required=True)
    ap.add_argument('--dataset', default='eyes_defy', help='фильтр по колонке dataset, если она есть')
    ap.add_argument('--out', default=str(ROOT / 'model'))
    ap.add_argument('--seed', type=int, default=0)
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
    for tr, te in outer:
        m = fit(X[tr], y[tr])
        lo, hi = inner_thresholds(X[tr], y[tr], g[tr], a.seed)
        p[te] = predict(m, X[te])
        zone[te] = np.where(p[te] < lo, 'low', np.where(p[te] >= hi, 'high', 'mid'))

    blocks = [block('Все (OOF)', y, p, zone, g)]
    for c in sorted(df.country.unique()):
        s = (df.country == c).to_numpy()
        blocks.append(block(f'Только {c}', y[s], p[s], zone[s], g[s]))
    base = max(y.mean(), 1 - y.mean())

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
        'metrics': {'auc_oof': blocks[0]['auc'][0], 'auc_ci': blocks[0]['auc'][1:], 'n_patients': blocks[0]['patients'],
                    'sens_at_low': blocks[0]['sens'][0], 'spec_at_low': blocks[0]['spec'][0],
                    'by_country_auc': {b['name']: b['auc'][0] for b in blocks[1:]},
                    'domain': 'Eyes-defy, clip-on macro lens, not smartphone', 'details': 'model/metrics.md'},
    }
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / 'model.json').write_text(json.dumps(model, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    write_metrics(out / 'metrics.md', blocks, base, model, len(man) - len(df))
    print((out / 'metrics.md').read_text(encoding='utf-8'))


if __name__ == '__main__':
    main()
