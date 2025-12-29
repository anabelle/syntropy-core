FROM oven/bun:1-slim

WORKDIR /app

# Install dependencies for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json bun.lock* ./

# Install dependencies
RUN bun install

# Copy source
COPY . .

# Run directly
CMD ["bun", "src/index.ts"]
