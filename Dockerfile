# ── Multi-stage Build Stage ───────────────────────────────────
FROM node:24-alpine AS builder

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@11.5.1 --activate

WORKDIR /app

# Copy root workspace and package manifests
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY easyeda-bridge-extension/package.json ./easyeda-bridge-extension/

# Install dependencies (including devDependencies for build)
RUN pnpm install --frozen-lockfile

# Copy tsconfig and source directories
COPY tsconfig.json tsconfig.build.json ./
COPY scripts/ ./scripts/
COPY src/ ./src/
COPY easyeda-bridge-extension/ ./easyeda-bridge-extension/

# Build the server and the bridge extension package
RUN pnpm build
RUN pnpm build:extension

# Prune development dependencies to keep production image light
# CI=true suppresses pnpm v11+ interactive confirmModulesPurge prompt
RUN CI=true pnpm install --prod --ignore-scripts

# ── Production Runner Stage ────────────────────────────────────
FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV TRANSPORT=http
ENV HTTP_HOST=0.0.0.0
ENV HTTP_PORT=3000

# Copy runtime assets and built package
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/easyeda-bridge-extension.eext ./easyeda-bridge-extension.eext
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 3000

CMD ["node", "dist/index.js"]
