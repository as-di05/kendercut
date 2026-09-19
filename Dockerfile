# Сборка и запуск разведены: в финальный образ не попадают ни исходники,
# ни devDependencies, ни компилятор — меньше образ, меньше поверхность атаки.
FROM node:20-alpine AS build
WORKDIR /app

COPY package*.json ./
# NODE_ENV здесь не production: без devDependencies нечем собрать TypeScript.
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# tini разбирает сигналы за PID 1 — без него SIGTERM не дойдёт до приложения
# и graceful shutdown не отработает.
RUN apk add --no-cache tini

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# Миграции — обычные .sql, tsc их не копирует, поэтому берём из контекста.
COPY migrations ./migrations

# Alpine приносит готового непривилегированного пользователя node.
USER node

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
