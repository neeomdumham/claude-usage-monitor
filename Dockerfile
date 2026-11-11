FROM node:24-alpine
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build && pnpm prune --prod
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
CMD ["node", "apps/server/src/main.ts"]
