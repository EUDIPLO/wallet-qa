FROM node:22.19.0-alpine AS build
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm@11.20.0 && pnpm install --frozen-lockfile --ignore-scripts

COPY . .
RUN pnpm run build

FROM node:22.19.0-alpine AS runtime
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm@11.20.0 && pnpm install --prod --frozen-lockfile --ignore-scripts

COPY --from=build /app/dist ./dist
COPY --from=build /app/config ./config

# Run as the image's unprivileged `node` user (uid 1000), which owns the run store in /app/data.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8787
CMD ["node", "dist/server/server.js"]
