FROM oven/bun:1

WORKDIR /app

# Manifests first so the install layer stays cached across source-only changes.
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

COPY . .

ENV NODE_ENV=production
ENV PORT=3000

# Non-root user shipped with the oven/bun image.
USER bun

EXPOSE 3000

CMD ["bun", "src/index.ts"]
