from fastapi import APIRouter
from pydantic import BaseModel

from app.config import get_settings
from app.mail import mail_enabled

router = APIRouter(prefix="/api", tags=["meta"])


class InstallConfig(BaseModel):
    """What the interface needs to know about the installation before any sign-in.

    Switches only, no values: addresses, keys and secrets neither reach this
    route nor can they — it is open to anyone who opened the page.
    """

    #: Whether to show the "Send email" button. With MAIL_TRANSPORT=none there
    #: is no such button at all and only copying the link remains — an
    #: installation without a mail server must stay fully usable.
    mail_enabled: bool
    #: `open` / `invite_only` / `closed`: whether to draw the registration form.
    signup_mode: str
    supported_locales: list[str]
    default_locale: str
    public_sharing_enabled: bool
    #: Whether the installation has a live feed (WebSocket). Serverless has
    #: none, and there is no reason for the client to spend connection attempts
    #: and scare people with a "no connection" bar where no connection exists.
    live_enabled: bool


@router.get("/config", response_model=InstallConfig)
def install_config():
    settings = get_settings()
    return InstallConfig(
        mail_enabled=mail_enabled(),
        signup_mode=settings.signup_mode,
        supported_locales=settings.locales,
        default_locale=settings.default_locale,
        public_sharing_enabled=settings.public_sharing_enabled,
        live_enabled=bool(settings.live_enabled),
    )
