# Single container: build the web app, then serve API + static from Bun.
FROM oven/bun:1.3 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY packages ./packages
COPY apps ./apps
RUN bun install --frozen-lockfile
RUN bun run build:web

FROM oven/bun:1.3
WORKDIR /app
COPY --from=build /app ./
ENV PORT=3000
EXPOSE 3000
# Bus monitor needs to reach the KNXnet/IP interface; run with --network host
# (or map UDP) so the tunnel can bind a local UDP socket on your LAN.
CMD ["bun", "run", "apps/server/src/index.ts"]
