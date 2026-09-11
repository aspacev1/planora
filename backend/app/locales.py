"""Choosing a language when a person first shows up.

The specification: the language is stored in the profile; on first sign-in it
is taken from `Accept-Language` if that asks for one of the supported ones, and
otherwise it is Azerbaijani. After that — only what the person chose themselves.
"""

from app.config import get_settings


def _weight(part: str) -> float:
    """A language's weight from `;q=`. Without it the order of preference is lost.

    A malformed weight is not a reason to refuse parsing the whole header: the
    header comes from a browser, but it could have passed through anything.
    """
    for parameter in part.split(";")[1:]:
        key, _, value = parameter.partition("=")
        if key.strip().casefold() == "q":
            try:
                return float(value)
            except ValueError:
                return 0.0
    return 1.0


def preferred_locale(header: str | None, supported: list[str], default: str) -> str:
    """The first supported language from `Accept-Language`.

    Case is folded invariantly (`casefold`) rather than in the process locale:
    in the Azerbaijani locale `"I"` turns into `ı`, and the same header would
    start being parsed differently depending on whose locale happened to be
    active on the server.

    Only the primary subtag is compared: `ru-RU` is Russian, and demanding
    exactly `ru` from the browser would mean failing to understand half of the
    headers in the wild. The region is not preserved: the product distinguishes
    three languages, not dialects.
    """
    known = {code.casefold(): code for code in supported}

    ranked = []
    for part in (header or "").split(","):
        tag = part.split(";")[0].strip().casefold()
        if not tag or tag == "*":
            continue
        primary = tag.split("-")[0]
        if primary in known:
            ranked.append((_weight(part), known[primary]))

    if not ranked:
        return default
    # max by weight; on equal weights the one earlier in the header wins — hence
    # a stable sort rather than max() on a single key.
    return sorted(ranked, key=lambda item: item[0], reverse=True)[0][1]


def locale_from_request(header: str | None) -> str:
    settings = get_settings()
    return preferred_locale(header, settings.locales, settings.default_locale)
