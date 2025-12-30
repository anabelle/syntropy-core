FROM oven/bun:1-slim

WORKDIR /app

# Install dependencies for native modules, Docker CLI, Docker Compose, and Git
RUN apt-get update && apt-get install -y \
    python3 make g++ git curl unzip sudo \
    && curl -fsSL https://get.docker.com | sh \
    && rm -rf /var/lib/apt/lists/*

# Install Opencode CLI and make it globally available
RUN curl -fsSL https://opencode.ai/install | bash \
    && mv /root/.opencode/bin/opencode /usr/local/bin/opencode \
    && chmod +x /usr/local/bin/opencode

# Copy package files
COPY package.json bun.lock* ./

# Install dependencies
RUN bun install

# Copy source
COPY . .

# Run directly
CMD ["bun", "src/index.ts"]
