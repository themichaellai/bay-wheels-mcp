# Use Bun to run TypeScript directly (no build step needed)
FROM oven/bun:1 AS base
WORKDIR /app

# Install deps first for better layer caching
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile

# Copy source
COPY . .

# Fly will set PORT; default to 8080 just in case
ENV PORT=8080
EXPOSE 8080

# Start your MCP server
CMD ["bun", "index.ts"]
