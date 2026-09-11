"""Validating the Jira site address before an outbound request: SSRF protection.

The same risk and the same remedy as in app/ai/netguard.py: the address is set
by an organization's administrator — that is, by a user — while the server is
what goes there. Without the check, "a Jira connection" turns into a proxy into
a private network on the server's behalf, as soon as someone points it at
`http://169.254.169.254/...` or an internal host of the installation.

The logic deliberately repeats app/ai/netguard.py one to one instead of reusing
it: the two callers (LLM and Jira) raise different exceptions with their own
codes, and a shared function with an exception-factory parameter would
complicate a module that has already got SSRF right, for the sake of a single
extra caller.
"""

import ipaddress
import socket
from urllib.parse import urlsplit

from app.config import get_settings
from app.jira.errors import JiraError


def ensure_public_https(url: str) -> None:
    """Raises JiraError if the server must not go to this address."""
    if get_settings().jira_allow_private_urls:
        return

    parsed = urlsplit(url)
    if parsed.scheme != "https":
        raise JiraError(
            "jira_url_not_https", f"адрес Jira обязан быть https, а не {parsed.scheme!r}"
        )
    host = parsed.hostname
    if not host:
        raise JiraError("jira_url_invalid", "в адресе Jira нет хоста")

    try:
        infos = socket.getaddrinfo(host, parsed.port or 443, proto=socket.IPPROTO_TCP)
    except OSError as error:
        raise JiraError("jira_unreachable", f"хост {host!r} не резолвится: {error}") from error

    for *_, sockaddr in infos:
        address = ipaddress.ip_address(sockaddr[0])
        # is_global rejects private ranges, loopback, link-local
        # (169.254.0.0/16 — cloud metadata) and CGN all at once.
        if not address.is_global:
            raise JiraError(
                "jira_url_private",
                f"хост {host!r} резолвится в непубличный адрес {address}",
            )
