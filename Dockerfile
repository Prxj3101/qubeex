# QubeEx backend image (works on ARM servers like Oracle A1 and on x86).
# Build:  docker build -t qubeex-backend .
# Run:    docker run --env-file .env -p 3000:3000 qubeex-backend

# ---------- Stage 1: build (has compilers + dev tools) ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Tools needed to compile native packages (bcrypt) if no prebuilt binary exists
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# Install dependencies first (cached unless package files change).
# prisma/ is copied too because the postinstall script runs "prisma generate".
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml prisma.config.ts ./
COPY prisma ./prisma
# Prisma only needs a URL shape at build time; the real one comes from .env at runtime
ENV DIRECT_URL=postgresql://build:build@localhost:5432/build
RUN pnpm install --frozen-lockfile

# Copy the source and compile TypeScript to dist/
COPY . .
RUN pnpm prisma generate && pnpm build

# Keep only production dependencies for the final image
RUN pnpm prune --prod --ignore-scripts

# ---------- Stage 2: run (small, no compilers) ----------
FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production

# Ghostscript ("gs") is used by src/services/pdfNormalize.service.ts
RUN apt-get update \
 && apt-get install -y --no-install-recommends ghostscript ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# tenantDb.service.ts reads prisma/tenant/init.sql at runtime
COPY --from=build /app/prisma ./prisma

# Run as the non-root "node" user that comes with the image
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
