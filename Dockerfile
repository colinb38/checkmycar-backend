FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy source code
COPY . .

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Expose server port
EXPOSE 3000

CMD ["node", "server.js"]
