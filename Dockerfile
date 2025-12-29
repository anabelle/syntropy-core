FROM oven/bun:1-slim

WORKDIR /app

# Install dependencies for native modules, Docker CLI, Docker Compose, and Git
RUN apt-get update && apt-get install -y \
    python3 make g++ git curl \
    && curl -fsSL https://get.docker.com | sh \
    && rm -rf /var/lib/apt/lists/*

# Install Opencode CLI (corrected URL)
RUN curl -fsSL https://opencode.ai/install | bash
ENV PATH="/root/.opencode/bin:${PATH}"

# Copy package files
COPY package.json bun.lock* ./

# Install dependencies
RUN bun install

# Copy source
COPY . .

# Run directly
CMD ["bun", "src/index.ts"]
