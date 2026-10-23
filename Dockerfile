# Single container: build the web app, then serve API + static from Bun.
#
# The build context is an allowlist (.dockerignore): workspace manifests, source and web build
# inputs only. Tests, fixtures, docs and tools never reach the builder, so no layer of any stage
# can carry them.
FROM oven/bun:1.3 AS source
WORKDIR /app
COPY . .
# A context that bypasses .dockerignore (a tar on stdin is sent as-is) would carry tests and
# fixtures; refuse it rather than build an image that ships them.
RUN leaked=$(find . \( -name test -o -name fixtures -o -name docs -o -name scratchpad -o -name .git \
      -o -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.gz' -o -name '*.dat' -o -name '*.log' \
      -o -name '*.bin' -o -name '*.knxproj' -o -name '*.knxprod' -o -name '*.knxkeys' \
      -o -path ./apps/server/data -o -name '*.db' -o -name master.key -o -name .scratch \) -print; \
      find ./tools -mindepth 1 ! -name package.json -print); \
    if [ -n "$leaked" ]; then echo "build context is not the .dockerignore allowlist:" >&2; echo "$leaked" | head -20 >&2; exit 1; fi

FROM source AS build
RUN bun install --frozen-lockfile
RUN bun run build

# Runtime payload, stated file by file: the license and its notice, the root manifests, the server
# and the workspaces it imports, the server's production dependencies (and the peer dependencies Bun
# adds for them), and the built web app. The web source, the web app's dependencies and the development
# toolchain (TypeScript, Vite, oxlint, Playwright) stay in the build stage.
FROM oven/bun:1.3
WORKDIR /app
COPY --from=source /app/LICENSE /app/NOTICE /app/package.json /app/bun.lock /app/tsconfig.base.json ./
# Manifests of workspaces that are not shipped: a frozen-lockfile install resolves every workspace.
COPY --from=source /app/tools/package.json ./tools/
COPY --from=source /app/apps/bridge/package.json ./apps/bridge/
COPY --from=source /app/apps/web/package.json ./apps/web/
COPY --from=source /app/packages ./packages
COPY --from=source /app/plugins ./plugins
COPY --from=source /app/apps/server/package.json ./apps/server/
COPY --from=source /app/apps/server/src ./apps/server/src
RUN bun install --frozen-lockfile --production --filter @busforge/server && rm -rf /root/.bun/install/cache
COPY --from=build /app/apps/web/dist ./apps/web/dist
# Build identity (the build context has no .git, so the server cannot read git at runtime).
# Defaults keep a build without arguments honest; docs/deployment.md has the release build.
# Read back via /api/version and shown in the UI footer.
ARG BUSFORGE_VERSION=unknown
ARG BUSFORGE_COMMIT=unknown
ARG BUSFORGE_BUILT_AT=
RUN printf '{"version":"%s","commit":"%s","builtAt":"%s"}\n' "$BUSFORGE_VERSION" "$BUSFORGE_COMMIT" "$BUSFORGE_BUILT_AT" > /app/version.json
# description, source and url are set explicitly because the base image labels name Bun. source and
# url stay empty: there is no public repository to point at yet.
LABEL org.opencontainers.image.title="Busforge" \
      org.opencontainers.image.description="Self-hostable KNX project, bus monitor and device programming tool" \
      org.opencontainers.image.source="" \
      org.opencontainers.image.url="" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.version="$BUSFORGE_VERSION" \
      org.opencontainers.image.revision="$BUSFORGE_COMMIT" \
      org.opencontainers.image.created="$BUSFORGE_BUILT_AT"
ENV PORT=3000
EXPOSE 3000
# All persistent state (SQLite database, flash backups, master.key) lives here; mount it.
VOLUME /app/apps/server/data
# Liveness for `docker compose ps` and the deploy gate. Hits the SPA root, which
# the server answers once the web app is built (it is, in the build stage).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Bus monitor reaches the KNXnet/IP interface over the LAN. On bridge networking
# the tunnel still works because the connection advertises a 0.0.0.0 HPAI (NAT
# mode), so the gateway replies to the packet source. If a gateway ignores NAT
# mode, switch the compose service to network_mode: host.
CMD ["bun", "run", "apps/server/src/index.ts"]
