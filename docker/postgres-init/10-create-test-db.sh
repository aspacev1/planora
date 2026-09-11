#!/bin/sh
# The test database is created here, while the volume is initialized, rather
# than by a separate command before the first test run. Its name is derived
# from POSTGRES_DB by the same rule as in backend/tests/conftest.py:
# "<name>_test" — the tests agree to work only with such a database, and
# deliberately refuse to drop_all against the one from DATABASE_URL.
#
# The script runs exactly once — on an empty data directory. If the pgdata
# volume already existed before this file appeared, create the database by
# hand:
#   docker compose exec db createdb -U planora planora_test
set -e

createdb --username "$POSTGRES_USER" "${POSTGRES_DB}_test"
