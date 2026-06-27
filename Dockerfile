# Single container: build the web app, then serve API + static from Bun.
FROM oven/bun:1.3 AS build
WORKDIR /app
COPY package.json bun.lock ./
# Shared TS config that every workspace tsconfig extends; the web build needs it.
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY plugins ./plugins
RUN bun install --frozen-lockfile
RUN bun run build

FROM oven/bun:1.3
WORKDIR /app
COPY --from=build /app ./
# Bake the build/version info into the image (the build context excludes .git, so the
# server cannot read git at runtime). The CI build job passes these; defaults keep a local
# `docker build` honest. Read back via /api/version and shown in the UI footer.
ARG BUSFORGE_VERSION=unknown
ARG BUSFORGE_COMMIT=unknown
ARG BUSFORGE_BUILT_AT=
RUN printf '{"version":"%s","commit":"%s","builtAt":"%s"}\n' "$BUSFORGE_VERSION" "$BUSFORGE_COMMIT" "$BUSFORGE_BUILT_AT" > /app/version.json
ENV PORT=3000
EXPOSE 3000
# Liveness for `docker compose ps` and the deploy gate. Hits the SPA root, which
# the server answers once the web app is built (it is, in the build stage).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Bus monitor reaches the KNXnet/IP interface over the LAN. On bridge networking
# the tunnel still works because the connection advertises a 0.0.0.0 HPAI (NAT
# mode), so the gateway replies to the packet source. If a gateway ignores NAT
# mode, switch the compose service to network_mode: host.
CMD ["bun", "run", "apps/server/src/index.ts"]
