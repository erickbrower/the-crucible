# The Crucible's web UI in a container:  docker compose up -d   (then open http://localhost:4777)
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# Forge card data (GPL-3.0) is downloaded at build time, not committed; rebuild to pick up new sets.
COPY scripts ./scripts
RUN bash scripts/fetch-forge.sh

COPY . .

ENV HOST=0.0.0.0 PORT=4777
EXPOSE 4777
CMD ["npx", "tsx", "src/ui/server.ts", "--no-open"]
