# syntax=docker/dockerfile:1.7
# Zero npm dependencies: no install step and a minimal attack surface.
FROM node:24-alpine AS base
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATABASE_PATH=/data/decision-engine.db \
    SECRETS_PROVIDERS=file,env \
    SECRETS_DIR=/run/secrets \
    LOG_REQUESTS=true
WORKDIR /app

# `docker build --target test .` runs the suite inside the image toolchain.
FROM base AS test
ENV NODE_ENV=test
COPY . .
RUN node --test "test/**/*.test.js"

FROM base AS runtime
RUN mkdir -p /data && chown node:node /data
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node pipelines ./pipelines
COPY --chown=node:node dashboard ./dashboard
COPY --chown=node:node docs/openapi.yaml ./docs/openapi.yaml
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["node", "src/api/server.js"]
