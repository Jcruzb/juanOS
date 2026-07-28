FROM node:22.21.0-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/config/package.json packages/config/package.json
COPY apps/api/package.json apps/api/package.json
RUN npm ci
COPY apps/web ./apps/web
COPY packages/shared ./packages/shared
RUN npm run build -w @juanos/web

FROM nginx:1.29.2-alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY infra/nginx/static.conf /etc/nginx/conf.d/default.conf
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1/healthz || exit 1
