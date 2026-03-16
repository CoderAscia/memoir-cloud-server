import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

class RedisClient {
    private static instance: RedisClient;
    private client: Redis;

    private constructor() {
        const host = process.env.REDIS_HOST || 'localhost';
        const port = parseInt(process.env.REDIS_PORT || '6379', 10);
        
        this.client = new Redis({
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

    public static getInstance(): RedisClient {
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
    public async setSession(key: string, data: any, ttlSeconds: number = 3600): Promise<void> {
        await this.client.set(key, JSON.stringify(data), 'EX', ttlSeconds);
    }

    /**
     * Retrieves session data from Redis.
     * @param key The user ID or session ID
     * @returns The parsed session data, or null if not found
     */
    public async getSession(key: string): Promise<any | null> {
        const data = await this.client.get(key);
        return data ? JSON.parse(data) : null;
    }

    /**
     * Updates the TTL of an existing session (useful for active users or graceful disconnects)
     */
    public async expireSession(key: string, ttlSeconds: number): Promise<void> {
        await this.client.expire(key, ttlSeconds);
    }

    /**
     * Deletes a session from Redis
     */
    public async deleteSession(key: string): Promise<void> {
        await this.client.del(key);
    }

    // --- CONVERSATION CACHING ---

    /**
     * Caches an array of messages for a specific conversation
     */
    public async setConversationCache(conversationId: string, messages: any[], ttlSeconds: number = 3600): Promise<void> {
        const key = `conv:${conversationId}`;
        await this.client.set(key, JSON.stringify(messages), 'EX', ttlSeconds);
    }

    /**
     * Retrieves cached messages for a conversation
     */
    public async getConversationCache(conversationId: string): Promise<any[] | null> {
        const key = `conv:${conversationId}`;
        const data = await this.client.get(key);
        return data ? JSON.parse(data) : null;
    }

    /**
     * Appends a single new message to an existing conversation cache, bypassing full re-save if possible.
     */
    public async appendMessageToCache(conversationId: string, message: any, ttlSeconds: number = 3600): Promise<void> {
        const key = `conv:${conversationId}`;
        const currentCache = await this.getConversationCache(conversationId);
        
        if (currentCache) {
            // Unshift because we sort descending (newest first)
            currentCache.unshift(message);
            await this.setConversationCache(conversationId, currentCache, ttlSeconds);
        } else {
            // If cache expired or doesn't exist, we just start a new array
            await this.setConversationCache(conversationId, [message], ttlSeconds);
        }
    }

    public async close(): Promise<void> {
        await this.client.quit();
    }
}

export default RedisClient;
