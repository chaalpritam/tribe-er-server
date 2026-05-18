FROM node:20-slim AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable \
 && corepack prepare pnpm@9.15.9 --activate \
 && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:20-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/storage/migrations ./dist/storage/migrations
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
EXPOSE 3003
CMD ["node", "dist/index.js"]
