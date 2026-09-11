"""Symmetric encryption with the application secret.

Exactly one value needs it — an organization's LLM key. The encryption key is
derived from `APP_SECRET` rather than stored separately: a second secret would
have to be set by whoever deploys, and half of the installations would leave it
at its default.

Rotating `APP_SECRET` requires re-encrypting the keys — that is recorded in the
specification as a known consequence, not as an oversight.
"""

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from app.config import get_settings


class DecryptionError(Exception):
    """The value cannot be decrypted with this secret.

    Usually this means `APP_SECRET` was changed without re-encrypting the keys.
    A separate class, because this is not "there is no key" but "there is a key
    and nothing to read it with", and the two must not be confused: the first is
    fixed by entering a key, the second by restoring the previous secret.
    """


def _key() -> bytes:
    # SHA-256 of the secret rather than the secret itself: Fernet requires
    # exactly 32 base64-encoded bytes, while APP_SECRET is an arbitrary string
    # chosen by whoever deploys.
    digest = hashlib.sha256(get_settings().app_secret.encode()).digest()
    return base64.urlsafe_b64encode(digest)


def encrypt(value: str) -> str:
    return Fernet(_key()).encrypt(value.encode()).decode()


def decrypt(value: str) -> str:
    try:
        return Fernet(_key()).decrypt(value.encode()).decode()
    except InvalidToken as error:
        raise DecryptionError("the value does not decrypt with the current APP_SECRET") from error
