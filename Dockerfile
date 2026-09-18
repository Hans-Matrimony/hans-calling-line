# Hans Dialer — one container: Express API + Next.js static export (same origin, no CORS).
# Coolify: point the service at this Dockerfile, expose port 3001, set the env vars
# listed in README ("Environment variables for deployment").

# --- stage 1: build the Next.js static export (client/out) ---
FROM node:22-alpine AS client
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY client/ ./
# Same-origin: the export calls the API on whatever origin serves it. Must stay empty.
RUN NEXT_PUBLIC_API_URL= npm run build

# --- stage 2: runtime ---
FROM node:22-alpine
WORKDIR /app/server
ENV NODE_ENV=production PORT=3001
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server/src ./src
COPY server/public ./public
COPY server/sql ./sql
COPY server/scripts ./scripts
COPY --from=client /app/client/out ../client/out

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

# Schema first (idempotent), then the API.
CMD ["sh", "-c", "node src/db/migrate.js && node src/index.js"]
