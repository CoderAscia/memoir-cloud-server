"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const redis_1 = require("redis");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
class RedisCloudClient {
    constructor() {
        const username = process.env.REDIS_CLOUD_USERNAME;
        const password = process.env.REDIS_CLOUD_PASSWORD;
        const host = process.env.REDIS_CLOUD_HOST;
        const port = parseInt(process.env.REDIS_CLOUD_PORT || "", 10);
        if (!username || !password || !host || !port) {
            throw new Error('Missing Redis Cloud environment variables');
        }
        this.client = (0, redis_1.createClient)({
            username,
            password,
            socket: {
                host,
                port
            }
        });
        this.client.on('error', err => console.error('Redis Cloud Client Error', err));
        this.client.on('connect', () => console.log('Redis Cloud Client Connected'));
    }
    static getInstance() {
        if (!RedisCloudClient.instance) {
            RedisCloudClient.instance = new RedisCloudClient();
        }
        return RedisCloudClient.instance;
    }
    async connect() {
        if (!this.client.isOpen) {
            await this.client.connect();
        }
    }
    async disconnect() {
        if (this.client.isOpen) {
            await this.client.quit();
        }
    }
    getClient() {
        return this.client;
    }
    // --- SESSION MANAGEMENT ---
    /**
     * Stores session data in Redis with an optional TTL.
     */
    async setSession(key, data, ttlSeconds = 3600) {
        await this.connect();
        await this.client.set(key, JSON.stringify(data), { EX: ttlSeconds });
    }
    /**
     * Retrieves session data from Redis.
     */
    async getSession(key) {
        await this.connect();
        const data = await this.client.get(key);
        return data ? JSON.parse(data) : null;
    }
    /**
     * Updates the TTL of an existing session.
     */
    async expireSession(key, ttlSeconds) {
        await this.connect();
        await this.client.expire(key, ttlSeconds);
    }
    /**
     * Deletes a session from Redis.
     */
    async deleteSession(key) {
        await this.connect();
        await this.client.del(key);
    }
    // --- CONVERSATION CACHING ---
    /**
     * Caches an array of messages for a specific conversation.
     */
    async setConversationCache(conversationId, messages, ttlSeconds = 3600) {
        const key = `conv:${conversationId}`;
        await this.connect();
        await this.client.set(key, JSON.stringify(messages), { EX: ttlSeconds });
    }
    /**
     * Retrieves cached messages for a conversation.
     */
    async getConversationCache(conversationId) {
        const key = `conv:${conversationId}`;
        await this.connect();
        const data = await this.client.get(key);
        return data ? JSON.parse(data) : null;
    }
    /**
     * Appends a message to the conversation cache.
     */
    async appendMessageToCache(conversationId, message, ttlSeconds = 3600) {
        const currentCache = await this.getConversationCache(conversationId);
        if (currentCache) {
            currentCache.unshift(message);
            await this.setConversationCache(conversationId, currentCache, ttlSeconds);
        }
        else {
            await this.setConversationCache(conversationId, [message], ttlSeconds);
        }
    }
    /**
     * Clears all data from the database.
     */
    async flushAll() {
        console.log("🧹 Clearing Redis Cloud cache...");
        await this.connect();
        await this.client.flushDb();
    }
}
exports.default = RedisCloudClient;
