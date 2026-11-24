"""Тексты интерфейса: таблицы «ключ | RU | KZ» из Markdown → i18n/ru.json и i18n/kk.json.

Запуск: python tools/make_i18n.py docs/texts_ru_kk.md
"""
import json
import re
import sys
from pathlib import Path

ROW = re.compile(r'^\|\s*([a-z0-9_]+\.[a-zA-Z0-9_.]+)\s*\|(.*)\|(.*)\|\s*$')


def strip_md(s):
    s = s.strip()
    s = re.sub(r'\*\*(.+?)\*\*', r'\1', s)
    return s


def main(src):
    ru, kk = {}, {}
    for line in Path(src).read_text(encoding='utf-8').splitlines():
        m = ROW.match(line)
        if m:
            key, a, b = m.groups()
            ru[key], kk[key] = strip_md(a), strip_md(b)
    root = Path(__file__).resolve().parent.parent
    for name, d in (('ru', ru), ('kk', kk)):
        (root / 'i18n' / f'{name}.json').write_text(json.dumps(d, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'{len(ru)} ключей')


if __name__ == '__main__':
    main(sys.argv[1])
