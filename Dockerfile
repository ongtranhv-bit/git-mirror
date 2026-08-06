FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.test.json ./
COPY types ./types
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=build /app/dist ./dist

RUN useradd --create-home --uid 10001 app \
    && mkdir -p /app/.cache/repos \
    && chown -R app:app /app

USER app
VOLUME ["/app/.cache/repos"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["sh", "-c", "kill -0 1"]
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["run"]
