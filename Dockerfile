FROM node:24-alpine AS base
WORKDIR /app

# Install Bun (for dependency installation) and curl/bash
RUN apk add --no-cache bash curl \
  && bash -lc "curl -fsSL https://bun.sh/install | bash" \
  && ln -sf /root/.bun/bin/bun /usr/local/bin/bun

# Use Bun to install dependencies for speed/determinism
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# Copy source
COPY . .

# Environment
ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

# Run server with Node, stripping TS types and larger header size
CMD ["node", "--max-http-header-size=128000", "--experimental-strip-types", "index.ts"]
