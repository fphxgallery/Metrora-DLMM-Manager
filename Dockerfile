# ---- client build ----------------------------------------------------------
# `npm install`, NOT `npm ci`: a lockfile generated on macOS pins
# @rollup/rollup-darwin-* and fails to install on linux. Vite's optional native
# deps must be resolved for the build platform here.
FROM node:22-slim AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# ---- server build ----------------------------------------------------------
FROM node:22-slim AS server-build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build:server

# ---- runtime ---------------------------------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY --from=server-build /app/dist ./dist
COPY --from=client-build /app/client/dist ./client/dist

# Non-root. data/ and secrets/ are bind-mounted at runtime; create them here so
# the container still starts (and stays writable) when a mount is absent.
RUN useradd -r -u 10001 dlmm \
  && mkdir -p /app/data /app/secrets \
  && chown -R dlmm /app
USER dlmm

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
