FROM mcr.microsoft.com/playwright:v1.49.0-noble

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --production

# Copy source code
COPY . .

# Expose server port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3   CMD curl -f http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]
