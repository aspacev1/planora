"""An organization's LLM key: storing it and turning it into a provider."""

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.ai.provider import HttpProvider, LlmError, LlmProvider
from app.config import get_settings
from app.crypto import DecryptionError, decrypt, encrypt
from app.models import Organization, OrgLlmCredential


def save_credential(
    db: DbSession,
    org: Organization,
    *,
    provider: str,
    base_url: str,
    model: str,
    api_key: str | None,
) -> OrgLlmCredential:
    """Saves the connection. An empty key means "keep the previous one".

    Otherwise editing the model's address would require entering the key again —
    and there is nowhere to get it from: it is never handed outward.
    """
    # The address is validated on save so that an administrator learns about a
    # refusal right away, in the form, rather than on the first request to the
    # model. The check on every request stays regardless (see provider): DNS
    # could have changed since.
    from app.ai.netguard import ensure_public_https

    ensure_public_https(base_url)

    existing = db.scalar(select(OrgLlmCredential).where(OrgLlmCredential.org_id == org.id))
    if existing is None:
        if not api_key:
            raise ValueError("ключ обязателен при первом подключении")
        existing = OrgLlmCredential(org_id=org.id, encrypted_key=encrypt(api_key))
        db.add(existing)

    existing.provider = provider
    existing.base_url = base_url
    existing.model = model
    if api_key:
        existing.encrypted_key = encrypt(api_key)
    db.flush()
    return existing


def credential(db: DbSession, org: Organization) -> OrgLlmCredential | None:
    return db.scalar(select(OrgLlmCredential).where(OrgLlmCredential.org_id == org.id))


def provider_for(db: DbSession, org: Organization) -> LlmProvider:
    """The organization's provider.

    No key means the AI buttons are inactive with a link into settings, and the
    refusal here carries its own code: this is not a breakage but an
    unconfigured installation.
    """
    row = credential(db, org)
    if row is None:
        raise LlmError("llm_not_configured", "подключение LLM не настроено")
    try:
        api_key = decrypt(row.encrypted_key)
    except DecryptionError as error:
        # APP_SECRET was changed without re-encrypting the keys. A separate
        # code: this is fixed not by entering the key again but by restoring the
        # previous secret — or by deliberately entering a new key.
        raise LlmError("llm_key_unreadable", str(error)) from error

    return HttpProvider(
        base_url=row.base_url,
        model=row.model,
        api_key=api_key,
        timeout=get_settings().ai_request_timeout,
    )
