"""Подписи внутри выгруженного документа — на языке того, кто его заказал.

Устроено так же, как словари писем (`app/mail/templates.py`): по файлу на
язык, ключи смысловые, отсутствующий ключ падает на язык по умолчанию и пишет
предупреждение в лог, а не уходит пустой строкой. Полнота словарей проверяется
тестом, а не глазами.

Почему словарь на сервере, хотя ошибки API переводит клиент. Правило «у
бэкенда нет своего словаря прозы» относится к отказам: клиент получает код и
сам решает, какими словами его назвать. Готовый документ словами наполняет
тот, кто его пишет, — а пишет его сервер. Тот же довод уже записан в
`app/scorecard.py` рядом с `_METRIC_LABELS` («имя задачи ложится в базу, и
переводит его тот, кто пишет, — тот же принцип, что у писем»).

Названия месяцев тоже здесь, а не у `Intl`/`babel`: ICU не знает
азербайджанских месяцев, и фронтенд по этой же причине держит их словарём
(`frontend/src/i18n/dates.ts`).
"""

import json
import logging
from functools import lru_cache
from pathlib import Path

from app.config import get_settings
from app.export.errors import ExportError

logger = logging.getLogger(__name__)

_LABELS_DIR = Path(__file__).parent / "labels"

# Последняя ступень отката. Совпадает с умолчанием DEFAULT_LOCALE, но задано
# отдельно: словарь на этом языке обязан существовать в репозитории, чего
# нельзя обещать про произвольное значение переменной окружения.
LAST_RESORT_LOCALE = "az"


@lru_cache
def dictionary(locale: str) -> dict[str, dict[str, str]]:
    """Словарь подписей одного языка. Отсутствующий файл — пустой словарь."""
    path = _LABELS_DIR / f"{locale}.json"
    if not path.is_file():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def available_locales() -> list[str]:
    return sorted(path.stem for path in _LABELS_DIR.glob("*.json"))


def term(group: str, key: str, locale: str) -> str:
    """Одна подпись с откатом по языкам.

    Порядок отката — от языка заказавшего к языку установки и только затем к
    азербайджанскому; `dict.fromkeys`, а не `set`, чтобы этот порядок
    сохранился.
    """
    candidates = dict.fromkeys([locale, get_settings().default_locale, LAST_RESORT_LOCALE])
    for candidate in candidates:
        text = dictionary(candidate).get(group, {}).get(key)
        if text is None:
            continue
        if candidate != locale:
            logger.warning(
                "нет подписи %s.%s на языке %r, беру %r", group, key, locale, candidate
            )
        return text
    raise ExportError(
        "export_label_missing", f"нет подписи {group}.{key} ни на одном языке"
    )


def has_group_key(group: str, key: str, locale: str) -> bool:
    """Есть ли такая подпись — без ловли исключения на каждой строке.

    Нужно там, где незнакомое значение приходит из базы и подписывается общим
    словом: журнал правок несёт имя операции, а операции добавляются кодом, и
    новая не должна ронять документ на середине.
    """
    for candidate in (locale, get_settings().default_locale, LAST_RESORT_LOCALE):
        if key in dictionary(candidate).get(group, {}):
            return True
    return False


class Labels:
    """Словарь одного языка, привязанный к нему один раз.

    Рисовальщики зовут подписи десятками, и таскать `locale` в каждый вызов
    значило бы дать ему разойтись между шапкой и таблицей на одной странице.
    """

    def __init__(self, locale: str) -> None:
        self.locale = locale

    def __call__(self, group: str, key: str, **params: object) -> str:
        text = term(group, key, self.locale)
        # Подстановка идёт по шаблону, а не по данным: имя проекта и номер
        # версии попадают в текст значениями и не могут принести с собой ещё
        # одно поле для подстановки.
        return text.format(**params) if params else text

    def month(self, number: int, *, short: bool = False) -> str:
        return self("month_short" if short else "month", str(number))
