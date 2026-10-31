FROM node:20-alpine

WORKDIR /app

# Copy dependency definitions
COPY package*.json ./

# Install production dependencies
RUN npm install --production --no-audit --no-fund

# Copy application source
COPY . .

# Ensure data and uploads directories exist
RUN mkdir -p /app/data /app/uploads

# Default Environment Variables
ENV PORT=3000 \
    NODE_ENV=production \
    OPENWA_BASE_URL=http://openwa-api:2785 \
    OPENWA_API_KEY=trust-me-bro-this-is-ultra-secure-key \
    DATA_DIR=/app/data \
    UPLOADS_DIR=/app/uploads

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]
