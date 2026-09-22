FROM oven/bun:1.2.21

RUN apt-get update && apt-get install -y --no-install-recommends nfs-common bash ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile \
  && bun run --filter @effect-vfs/core build \
  && bun run --filter @effect-vfs/persistence build \
  && bun run --filter @effect-vfs/nfs build

EXPOSE 8080
CMD ["bun", "apps/demo-r2-nfs/src/container-main.ts"]
