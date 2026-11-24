# Наш код, библиотеки и данные (п. 5.3)

## Код проекта (этот репозиторий)

Всё в `index.html`, `app.js`, `sw.js`, `manifest.webmanifest`, `src/`, `styles/`, `tests/`, `tools/`, `i18n/`,
`assets/` (иконки и схемы «как снимать» нарисованы для проекта).

## Библиотеки

| Где | Что | Лицензия | Зачем |
|---|---|---|---|
| Приложение (браузер) | — | — | Сторонних библиотек нет: камера, canvas, IndexedDB, service worker — встроенные API браузера |
| Тесты | Node.js `node:test`, `node:assert` | MIT (Node.js) | Встроенный тест-раннер |
| `tools/` (Colab) | numpy | BSD-3-Clause | Массивы |
| `tools/` (Colab) | pandas | BSD-3-Clause | Таблица признаков |
| `tools/` (Colab) | scikit-learn | BSD-3-Clause | Логистическая регрессия, StratifiedGroupKFold, AUC |
| `tools/` (Colab) | opencv-python | Apache-2.0 | Чтение снимков, CIELAB для эталона |
| `tools/make_icons.py` | Pillow | MIT-CMU | Рисование PNG-иконок |

## Данные

| Набор | Лицензия | Как используется |
|---|---|---|
| Eyes-defy-anemia (Kaggle `harshwardhanfartale/eyes-defy-anemia`; исходная публикация — IEEE DataPort, doi 10.21227/t5s2-4j73) | CC BY-SA 4.0 (как указано на Kaggle) | Обучение и проверка шкалы в Colab. Фото и признаки пациентов в репозиторий не попадают — только коэффициенты и сводные метрики |

## Эталон формул

`tests/golden.json` — числа, посчитанные Python-реализацией тех же формул (модуль `anemia/color.py`
предыдущего исследования команды, OpenCV). Это ожидаемые значения для тестов, сам код не копировался.
