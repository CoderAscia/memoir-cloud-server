"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ioredis_1 = __importDefault(require("ioredis"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
class RedisClient {
    constructor() {
        const host = process.env.REDIS_HOST || 'localhost';
        const port = parseInt(process.env.REDIS_PORT || '6379', 10);
        this.client = new ioredis_1.default({
            host,
            port,
        });
        this.client.on('connect', () => {
            console.log('Connected to Redis successfully');
        });
        this.client.on('error', (err) => {
            console.error('Redis connection error:', err);
        });
    }
    static getInstance() {
        if (!RedisClient.instance) {
            RedisClient.instance = new RedisClient();
        }
        return RedisClient.instance;
    }
    /**
     * Stores session data in Redis with an optional TTL.
     * @param key The user ID or session ID
     * @param data The user's cached data
     * @param ttlSeconds Time to live in seconds (default is 1 hour = 3600s)
     */
    async setSession(key, data, ttlSeconds = 3600) {
        await this.client.set(key, JSON.stringify(data), 'EX', ttlSeconds);
    }
    /**
     * Retrieves session data from Redis.
     * @param key The user ID or session ID
     * @returns The parsed session data, or null if not found
     */
    async getSession(key) {
        const data = await this.client.get(key);
        return data ? JSON.parse(data) : null;
    }
    /**
     * Updates the TTL of an existing session (useful for active users or graceful disconnects)
     */
    async expireSession(key, ttlSeconds) {
        await this.client.expire(key, ttlSeconds);
    }
    /**
     * Deletes a session from Redis
     */
    async deleteSession(key) {
        await this.client.del(key);
    }
    // --- CONVERSATION CACHING ---
    /**
     * Caches an array of messages for a specific conversation
     */
    async setConversationCache(conversationId, messages, ttlSeconds = 3600) {
        const key = `conv:${conversationId}`;
        await this.client.set(key, JSON.stringify(messages), 'EX', ttlSeconds);
    }
    /**
     * Retrieves cached messages for a conversation
     */
    async getConversationCache(conversationId) {
        const key = `conv:${conversationId}`;
        const data = await this.client.get(key);
        return data ? JSON.parse(data) : null;
    }
    /**
     * Appends a single new message to an existing conversation cache, bypassing full re-save if possible.
     */
    async appendMessageToCache(conversationId, message, ttlSeconds = 3600) {
        const key = `conv:${conversationId}`;
        const currentCache = await this.getConversationCache(conversationId);
        if (currentCache) {
            // Unshift because we sort descending (newest first)
            currentCache.unshift(message);
            await this.setConversationCache(conversationId, currentCache, ttlSeconds);
        }
        else {
            // If cache expired or doesn't exist, we just start a new array
            await this.setConversationCache(conversationId, [message], ttlSeconds);
        }
    }
    async close() {
        await this.client.quit();
    }
}
exports.default = RedisClient;
