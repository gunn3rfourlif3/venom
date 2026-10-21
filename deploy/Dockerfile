# Xnith application image.
#
# Two stages so the runtime carries no TypeScript compiler and no dev
# dependencies - the thing that ships is dist/, the production node_modules
# and the static assets.

# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY public ./public
# db/ is copied in because the migrator reads the .sql files at runtime
# rather than embedding them.
COPY db ./db

# Runs as the image's unprivileged user, not root. This is isolation that
# actually holds: a process inside the container cannot write the image, and
# a bug in the app is not a bug with root in the container.
USER node

EXPOSE 8080
CMD ["node", "dist/api/server.js"]
