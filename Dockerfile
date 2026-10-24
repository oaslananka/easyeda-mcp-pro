# ── Multi-stage Build Stage ───────────────────────────────────
# node:24.22.1-alpine
FROM node@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS builder

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@11.28.8 --activate

WORKDIR /app

# Copy root workspace and package manifests
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY easyeda-bridge-extension/package.json ./easyeda-bridge-extension/
COPY config/runtime-policy.json ./config/runtime-policy.json
COPY scripts/check-runtime.mjs ./scripts/check-runtime.mjs

# Fail before dependency installation when the builder runtime drifts.
RUN node scripts/check-runtime.mjs --require-pnpm

# Install dependencies (including devDependencies for build)
RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy tsconfig and source directories
COPY tsconfig.json tsconfig.build.json ./
COPY scripts/ ./scripts/
COPY src/ ./src/
COPY easyeda-bridge-extension/ ./easyeda-bridge-extension/

# Build the server and the bridge extension package
RUN pnpm build
RUN pnpm build:extension

# Materialize an independent production-only package tree. The legacy deploy
# mode is required for this non-injected workspace; frozen-lockfile mode prevents
# the deployment graph from drifting from the reviewed lockfile.
RUN pnpm --filter easyeda-mcp-pro deploy --legacy --prod --frozen-lockfile /prod

# ── Production Runner Stage ────────────────────────────────────
# node:24.22.1-alpine
FROM node@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV TRANSPORT=http
ENV HTTP_HOST=127.0.0.1
ENV HTTP_PORT=3000
ENV ALLOWED_ORIGINS=
# Non-loopback HTTP requires OAuth/JWKS plus an explicit non-wildcard ALLOWED_ORIGINS value.

# Copy only the clean production deployment produced from the package allowlist,
# owned by the non-root "node" user baked into the official image (uid/gid 1000).
COPY --from=builder --chown=node:node /prod ./

# Keep the immutable Node base image while retaining explicit reviewed Alpine
# OpenSSL package versions. The 24.22.1 base already contains 3.5.9-r0; keeping
# the package pins makes later rebuilds fail rather than silently drift.
# The production process invokes Node directly and never needs npm, npx, or
# corepack. Remove package-manager payloads from the runtime stage to reduce
# image size and eliminate vulnerabilities in tooling that is not executed.
# WORKDIR created /app while still root; hand ownership to "node" so the app
# can create its runtime DATA_DIR (.easyeda-mcp-pro/) under it at startup.
RUN apk add --no-cache --upgrade libcrypto3=3.5.9-r0 libssl3=3.5.9-r0 \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    && chown node:node /app

USER node

EXPOSE 3000

CMD ["node", "dist/index.js"]
