"""Vercel entry point: the same FastAPI application, but as a serverless function.

Vercel looks for functions only in the `api/` directory at the project root,
while the application lives in `backend/`. Moving it here is not an option:
under docker-compose and in tests the package is imported as `app.*`, and the
move would break both scenarios for the sake of a third. So this is only a
bridge — the `backend` directory is added to the import path, and the files
themselves reach the function through `functions.includeFiles` in vercel.json:
by default the Python builder puts only the contents of `api/` into the
function, and without that the import below would fail with ModuleNotFoundError.

Routes are not redefined and no prefix is attached. The rewrite in vercel.json
decides which function serves a request, but the function itself sees the
original address — the very `/api/health` already declared in app.main. Adding
another `/api` here would double the addresses into `/api/api/health`.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.main import app  # noqa: E402

# The name `app` is not a matter of style: the Python builder looks for exactly
# that name in the module to recognize the ASGI application. Renaming it here
# means a 404 on the whole API.
__all__ = ["app"]
