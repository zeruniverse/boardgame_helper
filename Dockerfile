# Build from the repository root: docker build -t boardgame-helper .
FROM node:22-alpine AS builder
WORKDIR /app

# Copy workspace manifests first so dependency installation stays cacheable.
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
RUN npm ci --no-audit --no-fund

COPY backend ./backend
COPY frontend ./frontend
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
RUN npm ci --omit=dev --no-audit --no-fund \
  && npm cache clean --force

COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/backend/config.json ./backend/config.json
COPY --from=builder /app/frontend/dist ./frontend/dist

USER node
EXPOSE 3000
CMD ["node", "backend/dist/server.js"]
