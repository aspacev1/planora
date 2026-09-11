# The build runs in a Node image and only static files come out: the final
# image contains neither Node, nor sources, nor node_modules — that is, none
# of the gigabytes needed exactly once.

# Manifests are copied separately from the code: the dependency layer is
# rebuilt only when they change, not on every edit to a component. A separate
# stage is also needed because dev builds on top of it: there npm ci is already
# done while `npm run build` is not, and the dev server has nothing to wait for.
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS deps
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

# The development stage: the same Vite as `npm run dev` on the host, only
# inside a container — so that editing the interface does not require Node
# installed locally. Built only via `target: dev` from docker-compose.dev.yml.
FROM deps AS dev
COPY frontend/ ./
EXPOSE 8080
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "8080"]

FROM deps AS build
COPY frontend/ ./
RUN npm run build

# The last stage is the one built by default, with no target given.
FROM caddy:2-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 AS runtime
COPY --from=build /app/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile
# The cap_net_bind_service file capability is stripped from the binary. The
# official image sets it (setcap ...=+ep) so that Caddy can listen on 80 and
# 443 without being root — and together with `cap_drop: [ALL]` in compose that
# same capability is what stops it from starting: the kernel refuses to exec a
# file whose permitted set does not fit into the process's empty bounding set,
# and the container died with "exec caddy failed: Operation not permitted",
# looping forever in restarts. Privileged ports are not needed here — we listen
# on 8080 — so the capability is removed from the file rather than handed back
# in compose via cap_add: that way the set of privileges stays empty, as
# intended.
#
# Not root: Caddy listens on 8080 (unprivileged) and writes only to its own
# data directories — those are the ones it owns. adduser -S creates a system
# user with no password and no home directory.
RUN setcap -r /usr/bin/caddy \
	&& adduser -S -u 10001 web \
	&& chown -R web /data /config
USER web
