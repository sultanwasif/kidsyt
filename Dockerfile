# --- build stage: compile better-sqlite3 ---
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- runtime stage ---
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json server.js db.js youtube.js ./
COPY public ./public
RUN mkdir -p data && chown node:node data
USER node
EXPOSE 3100
CMD ["node", "server.js"]
