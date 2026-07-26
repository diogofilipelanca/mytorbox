FROM node:22-alpine

# dumb-init gives us correct signal handling, so `docker compose stop` doesn't SIGKILL
# the process mid-flush of the stats pipeline.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production
WORKDIR /app

# Copy manifests first so `npm ci` stays cached across source-only changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY index.js ./

# Drop privileges — the node image ships an unprivileged `node` user.
USER node

EXPOSE 7000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7000)+'/manifest.json').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
