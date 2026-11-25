"""Эталон для tests/color.test.js и tests/features.test.js: значения из Python-реализации формул.

Эталонная реализация — модуль `anemia/color.py` из предыдущего исследования команды (Python, OpenCV).
Он только считает ожидаемые числа; в приложение код не копируется.

Запуск: python tools/make_golden.py --ref <папка с пакетом anemia>
Нужны numpy и opencv-python.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

PIXELS = [  # 0..255: чистые цвета, серый, тёмный, пересвет, типичные ткани
    (255, 0, 0), (0, 255, 0), (0, 0, 255), (128, 128, 128), (10, 10, 10), (250, 250, 250),
    (200, 90, 100), (230, 150, 150), (180, 120, 110), (240, 235, 225), (150, 60, 70),
    (255, 255, 0), (90, 40, 200), (1, 2, 3), (220, 60, 60),
]


def synthetic_image(seed=0, h=32, w=32):
    """Синтетический кадр: «склера» сверху, «веко» снизу, шум, блики и тёмные ресницы."""
    rng = np.random.default_rng(seed)
    img = np.zeros((h, w, 3), np.float64)
    img[:] = (90, 60, 50)                                   # кожа
    img[2:12, 4:28] = (225, 215, 200)                       # склера, слегка тёплый свет
    img[18:30, 3:29] = (205, 105, 105)                      # конъюнктива
    img += rng.normal(0, 8, img.shape)
    img[20, 5:9] = (252, 252, 252)                          # блики
    img[27, 10:14] = (12, 10, 10)                           # ресницы
    img = np.clip(np.round(img), 0, 255).astype(np.uint8)
    sclera = np.zeros((h, w), bool); sclera[3:11, 6:26] = True
    lid = np.zeros((h, w), bool); lid[19:29, 4:28] = True
    return img, lid, sclera


def pick(f, keys):
    return None if f is None else {k: float(f[k]) for k in keys}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ref', required=True, help='корень репозитория с пакетом anemia (эталонные формулы)')
    ap.add_argument('--out', default=str(Path(__file__).resolve().parent.parent / 'tests' / 'golden.json'))
    a = ap.parse_args()
    sys.path.insert(0, a.ref)
    from anemia import color as C  # noqa: E402

    px = np.array(PIXELS, np.float32)[None] / 255
    lab = C.rgb_to_lab(px)[0]
    H, S, I = C.rgb_to_hsi(px)
    ei = C.erythema_index(px)[0]
    pixels = [{'rgb': list(p), 'lab': lab[i].tolist(), 'hsi': [float(H[0, i]), float(S[0, i]), float(I[0, i])],
               'ei': float(ei[i])} for i, p in enumerate(PIXELS)]

    u8, lid, sclera = synthetic_image()
    rgb = u8.astype(np.float32) / 255
    keys = ['EI_p50', 'L_p50', 'a_p50', 'b_p50', 'hue_p50', 'HHR', 'n_px']
    raw = C.roi_features(rgb, lid)
    v = rgb.max(-1)
    t = sclera & (v > 0.08) & (v < 0.985)               # склера: без теней и пересвеченных каналов
    lin = C.srgb_to_lin(np.clip(rgb, 0, 1))
    score = (lin / (np.median(lin[t], axis=0) + 1e-6)).sum(-1)
    sc_t = t & (score >= np.percentile(score[t], 60))   # опорные пиксели склеры: светлые 40 % ткани
    wb = C.roi_features(C.white_balance_by(rgb, sc_t), lid)
    # отношения «веко/склера»: веко — tissue_mask, склера — опорные пиксели sc_t (как src/features.js)
    lin_c = C.srgb_to_lin(np.clip(rgb, 1 / 255, 1))
    q = (np.median(lin_c[C.tissue_mask(rgb, lid)], axis=0) + 1e-6) / (np.median(lin_c[sc_t], axis=0) + 1e-6)
    rel = {'rel_lRG': float(np.log(q[0] / q[1])), 'rel_lRB': float(np.log(q[0] / q[2]))}
    gold = {
        'source': 'anemia/color.py (предыдущее исследование команды), OpenCV ' + __import__('cv2').__version__,
        'tolerance': {'default': 1e-3, 'lab': 0.2},
        'pixels': pixels,
        'image': {'width': int(u8.shape[1]), 'height': int(u8.shape[0]), 'rgb': u8.reshape(-1).tolist(),
                  'lid': lid.reshape(-1).astype(int).tolist(), 'sclera': sclera.reshape(-1).astype(int).tolist()},
        'expected': {
            'tissue_lid_px': int(C.tissue_mask(rgb, lid).sum()),
            'tissue_sclera_px': int(t.sum()),
            'sclera_ref_px': int(sc_t.sum()),
            'raw': pick(raw, keys), 'wb': pick(wb, keys),
            'rel': {k: float(rel[k]) for k in ('rel_lRG', 'rel_lRB')},
        },
    }
    Path(a.out).write_text(json.dumps(gold, ensure_ascii=False) + '\n', encoding='utf-8')
    print('записано', a.out)


if __name__ == '__main__':
    main()
