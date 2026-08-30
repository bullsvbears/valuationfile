# Build the UI and install production dependencies in a throwaway stage, so the
# runtime image carries neither the toolchain nor the dev dependency tree.
FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY server ./server
COPY scripts ./scripts
COPY tests ./tests
COPY data ./data
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

# The server runs TypeScript directly through tsx, so source and the bundled
# workbook import both ship; the volume is seeded from data/ on first boot.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/src ./src
COPY --from=build /app/server ./server
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/data ./data

# The mount point for the persistent volume holding overrides and models.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV DATA_DIR=/data
ENV PORT=8080
EXPOSE 8080

# Invoke tsx's entry point directly rather than through npx: npx would try to
# fetch the package if it were ever missing, turning a packaging mistake into a
# slow network failure at boot instead of an immediate one.
CMD ["node", "node_modules/tsx/dist/cli.mjs", "server/index.ts"]
