FROM node:20-alpine AS builder

WORKDIR /app

# Copy only package files first
COPY package*.json ./

# Clean install to avoid lockfile issues and handle peer conflicts
RUN npm install --legacy-peer-deps

# Copy the rest of the source code
COPY . .

# Build the project
RUN npm run build

# Stage 2: Production
FROM node:20-alpine

WORKDIR /app

# Copy built files and production dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./

EXPOSE 3000
EXPOSE 8080

CMD ["node", "dist/persistentServer.js"]
