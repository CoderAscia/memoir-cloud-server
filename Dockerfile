# Use official Node.js image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files first (for caching)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Build TypeScript to dist/
RUN npm run build

# Expose the WebSocket port
EXPOSE 3030
EXPOSE 3000
EXPOSE 3001

CMD ["node", "dist/persistentServer.js"]
# CMD [ "npx", "ts-node", "src/persistentServer.ts" ]
