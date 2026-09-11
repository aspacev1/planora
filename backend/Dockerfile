FROM python:3.12-slim@sha256:229a2c5bfa27522db7815ea81f9bed70af17ccb9de9fc7ad142b1877b5830d36

COPY --from=ghcr.io/astral-sh/uv:0.5.11 /uv /usr/local/bin/uv

# The environment deliberately lives outside /app. In development mode a
# working copy from the host is mounted over /app, and a venv sitting inside
# /app would be hidden by it: the container would start without a single
# installed dependency and fail on the first import. Outside that directory the
# mount does not touch it.
ENV UV_PROJECT_ENVIRONMENT=/opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

# Manifests are copied separately from the code: the dependency layer is
# rebuilt only when they change, not on every edit to a module.
COPY pyproject.toml uv.lock ./

# The production image does not carry pytest and httpx, but the development
# image does: otherwise `docker compose exec api pytest` has nothing to run,
# and the tests are available only to whoever has the right Python version
# installed locally. The value comes from docker-compose.dev.yml.
ARG INSTALL_DEV=false
RUN if [ "$INSTALL_DEV" = "true" ]; then \
        uv sync --no-install-project; \
    else \
        uv sync --no-dev --no-install-project; \
    fi

COPY . .

# Not root: the server process needs nothing beyond reading the code and a
# socket on an unprivileged port. A vulnerability in an application running as
# root is root in the container; under a separate user it is a user with no
# write access even to its own code.
RUN useradd --system --no-create-home --uid 10001 app
USER app

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
