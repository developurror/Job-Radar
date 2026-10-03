# ---- Build ----
FROM node:24-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app/api
COPY api/package*.json ./
RUN npm ci --no-audit --no-fund
COPY api/ ./
RUN npm run build

# ---- Dev: live reload (tsx watch), sources bind-mounted via compose override ----
FROM node:24-slim AS dev
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app/api
COPY api/package*.json ./
RUN npm ci --no-audit --no-fund
ENV NODE_ENV=development \
  PORT=3001 \
  DATA_DIR=/data
EXPOSE 3001
CMD ["npm", "run", "dev"]

# ---- Runtime ----
FROM node:24-slim
WORKDIR /app
COPY --from=build /app/api/dist ./api/dist
COPY --from=build /app/api/drizzle ./api/drizzle
COPY --from=build /app/api/node_modules ./api/node_modules
COPY --from=build /app/api/package.json ./api/package.json
ENV NODE_ENV=production \
  PORT=3001 \
  DATA_DIR=/data
EXPOSE 3001
VOLUME ["/data"]
CMD ["node", "api/dist/index.js"]
