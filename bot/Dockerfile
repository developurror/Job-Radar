# ---- Build ----
FROM node:20-slim AS build
WORKDIR /app/bot
COPY bot/package*.json ./
RUN npm ci --no-audit --no-fund
COPY bot/ ./
RUN npm run build

# ---- Runtime ----
FROM node:20-slim
WORKDIR /app
COPY --from=build /app/bot/dist ./bot/dist
COPY --from=build /app/bot/node_modules ./bot/node_modules
COPY --from=build /app/bot/package.json ./bot/package.json
ENV NODE_ENV=production
CMD ["node", "bot/dist/index.js"]
