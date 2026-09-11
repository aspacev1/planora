"""Validating the LLM address before an outbound request: SSRF protection.

The model's address is set by an organization's administrator — that is, by a
user — while the request to it is made by the server from its own network.
Without a check this is ready-made SSRF: point the address at
`http://169.254.169.254/...` or at an internal service of the installation, and
"an LLM connection" turns into a proxy into a private network on the server's
behalf.

The rules: the scheme must be https only; the host must resolve to public
addresses only (every A/AAAA record is checked — one private record is enough
to refuse). Resolving here does not fully remove the TOCTOU against the later
resolution inside the request itself, but it closes the cheap path; redirects
are forbidden separately (see provider) so that a public address cannot forward
inward.

`AI_ALLOW_PRIVATE_URLS=true` disables the check entirely — a deliberate knob for
a self-hosted installation with a local model (llama.cpp, vLLM) on the same
network: without it the promise "you can plug in a local model" would be a lie.
"""

import ipaddress
import socket
from urllib.parse import urlsplit

from app.ai.provider import LlmError
from app.config import get_settings


def ensure_public_https(url: str) -> None:
    """Raises LlmError if the server must not go to this address."""
    if get_settings().ai_allow_private_urls:
        return

    parsed = urlsplit(url)
    if parsed.scheme != "https":
        raise LlmError("llm_url_not_https", f"адрес LLM обязан быть https, а не {parsed.scheme!r}")
    host = parsed.hostname
    if not host:
        raise LlmError("llm_url_invalid", "в адресе LLM нет хоста")

    try:
        infos = socket.getaddrinfo(host, parsed.port or 443, proto=socket.IPPROTO_TCP)
    except OSError as error:
        raise LlmError("llm_unreachable", f"хост {host!r} не резолвится: {error}") from error

    for *_, sockaddr in infos:
        address = ipaddress.ip_address(sockaddr[0])
        # is_global rejects private ranges, loopback, link-local
        # (169.254.0.0/16 — cloud metadata) and CGN all at once.
        if not address.is_global:
            raise LlmError(
                "llm_url_private",
                f"хост {host!r} резолвится в непубличный адрес {address}",
            )
