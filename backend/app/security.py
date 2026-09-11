import hashlib
import secrets

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

_hasher = PasswordHasher()


def hash_password(raw: str) -> str:
    return _hasher.hash(raw)


def verify_password(raw: str, hashed: str) -> bool:
    """Password verification. Any argon2 refusal is a failed sign-in, not a crash.

    VerifyMismatchError (a wrong password) is only one of the cases: a corrupted
    or truncated hash string raises InvalidHashError, and other breakages raise
    VerificationError. All of them used to reach the client as a 500, even
    though the right answer to all of them is the same: sign-in failed.

    UnicodeEncodeError is on the same list not by oversight: argon2 encodes the
    hash string as ascii and fails on non-Latin garbage in the column before it
    even parses the format. The password is unaffected — it is encoded as utf-8.
    """
    try:
        return _hasher.verify(hashed, raw)
    except (VerificationError, InvalidHashError, UnicodeEncodeError):
        return False


def new_token() -> tuple[str, str]:
    """The plain token and its hash. The plain one is shown once; the hash is stored."""
    raw = secrets.token_urlsafe(32)
    return raw, hash_token(raw)


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()
