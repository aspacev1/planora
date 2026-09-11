"""The director is the only installation-wide role, not an organization one.

`Role` (owner/editor/viewer/client in app.models) exists inside a single
organization, and an installation may have any number of organization owners.
The director is something else: the specific person who runs the installation
itself, not someone's organization inside it. The address is not a code
constant but the mandatory DIRECTOR_EMAIL environment variable (see
app.config.Settings): the value lives in .env or in the platform's secret store
rather than in the repository, and the application refuses to start if it is
unset.
"""

from app.config import get_settings
from app.text import normalize_email


def is_director(email: str) -> bool:
    """Whether this address carries the director role.

    The comparison uses the same normalization as account uniqueness at
    registration (see app.text.normalize_email): the form of the address a
    person signed in with need not match DIRECTOR_EMAIL letter for letter.
    """
    return normalize_email(email) == normalize_email(get_settings().director_email)
