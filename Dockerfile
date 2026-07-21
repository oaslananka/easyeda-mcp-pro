# ── Multi-stage Build Stage ───────────────────────────────────
# node:24-alpine
FROM node@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS builder

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
RUN CI=true pnpm install --prod --ignore-scripts

# ── Production Runner Stage ────────────────────────────────────
# node:24-alpine
FROM node@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV TRANSPORT=http
ENV HTTP_HOST=127.0.0.1
ENV HTTP_PORT=3000
ENV ALLOWED_ORIGINS=
# Non-loopback HTTP requires OAuth/JWKS plus an explicit non-wildcard ALLOWED_ORIGINS value.

# Copy runtime assets and built package, owned by the non-root "node" user
# baked into the official image (uid/gid 1000).
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/easyeda-bridge-extension.eext ./easyeda-bridge-extension.eext
COPY --from=builder --chown=node:node /app/node_modules ./node_modules

# The production process invokes Node directly and never needs npm, npx, or
# corepack. Remove package-manager payloads from the runtime stage to reduce
# image size and eliminate vulnerabilities in tooling that is not executed.
# WORKDIR created /app while still root; hand ownership to "node" so the app
# can create its runtime DATA_DIR (.easyeda-mcp-pro/) under it at startup.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    && chown node:node /app

USER node

EXPOSE 3000

CMD ["node", "dist/index.js"]
