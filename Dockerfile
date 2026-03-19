FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/frontend/dist ./frontend/dist
COPY --from=build /app/dist-server ./dist-server

CMD ["node", "dist-server/status-app/server.js"]
