# Stage 1: Build
FROM node:22-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Stage 2: Production
FROM node:22-slim

# Install dependencies for Claude Code CLI and GitHub CLI
RUN apt-get update && apt-get install -y \
    curl \
    git \
    ca-certificates \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy built files from builder stage
COPY --from=builder /app/dist ./dist

# Install Codex CLI globally (as root)
RUN npm install -g @openai/codex

# Create directories for node user
RUN mkdir -p /home/node/.config/gh && chown -R node:node /home/node/.config

# Switch to node user for Claude Code CLI installation
USER node

# Install Claude Code CLI as node user
RUN curl -fsSL https://claude.ai/install.sh | bash

# Add Claude and Codex to PATH
ENV PATH="/home/node/.local/bin:${PATH}"

# Default command
CMD ["node", "dist/index.js"]
