FROM oven/bun:1-slim

WORKDIR /app

# Install dependencies for native modules, Docker CLI, Docker Compose, and Git
RUN apt-get update && apt-get install -y \
    python3 make g++ git curl unzip sudo \
    && curl -fsSL https://get.docker.com | sh \
    && rm -rf /var/lib/apt/lists/*

# NOTE: Opencode CLI is NOT installed here - workers handle all Opencode execution

# Copy package files
COPY --chown=bun:bun package.json bun.lock* ./

# Install dependencies
RUN bun install

# Copy source
COPY --chown=bun:bun . .

# Run directly
CMD ["bun", "src/index.ts"]
