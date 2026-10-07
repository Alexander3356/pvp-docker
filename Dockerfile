FROM node:22-alpine

WORKDIR /app/server-lan

RUN apk add --no-cache curl

COPY server-lan/package*.json ./

RUN npm ci --omit=dev

WORKDIR /app

COPY --chown=node:node client ./client
COPY --chown=node:node server-lan ./server-lan

WORKDIR /app/server-lan

ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --retries=3 CMD curl -f http://localhost:3000/health || exit 1

USER node

CMD ["node", "server.js"]