# Planifold — single image, no external services.
# Build:  podman build -t planifold .   (docker works the same)
# Run:    podman run -p 3000:3000 -v planifold-data:/data -e APP_SECRET=... planifold

FROM node:22-bookworm-slim AS build
# better-sqlite3 ships prebuilt binaries; the toolchain is the fallback for platforms without one.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY server/ server/
COPY web/ web/
COPY plugins/ plugins/
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    PLUGINS_DIR=/plugins
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
COPY --from=build /app/plugins plugins/
RUN mkdir -p /data /plugins && chown -R node:node /data /plugins /app
USER node
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/server.js"]
