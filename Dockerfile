FROM maven:3.9.9-eclipse-temurin-21 AS paper-bridge
WORKDIR /bridge
COPY bridge/paper/ ./
RUN mvn -B package

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production SSP_HOST=0.0.0.0 SSP_PORT=3001 SSP_DATA_DIR=/app/data
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/build-server ./build-server
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/bridge/ssp_bridge.py ./bridge/ssp_bridge.py
COPY --from=paper-bridge --chown=node:node /bridge/target/ssp-paper-bridge-0.1.0.jar ./bridge/paper/target/ssp-paper-bridge-0.1.0.jar
RUN mkdir /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "build-server/index.js"]


