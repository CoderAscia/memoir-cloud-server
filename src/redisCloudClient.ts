import { createClient, RedisClientType } from 'redis';
import { getSecret } from './secretManager';

class RedisCloudClient {
    private static instance: RedisCloudClient;
    private client: RedisClientType;

    private constructor(host: string, password: string) {
        const username = 'default';
        const port = parseInt(process.env.REDIS_CLOUD_PORT || '10770', 10);

        this.client = createClient({
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

    public static async getInstance(): Promise<RedisCloudClient> {
        if (!RedisCloudClient.instance) {
            const host = process.env.REDIS_CLOUD_HOST || await getSecret('REDIS_CLOUD_HOST');
            const password = process.env.REDIS_CLOUD_PASSWORD || await getSecret('REDIS_CLOUD_PASSWORD');
            RedisCloudClient.instance = new RedisCloudClient(host!, password!);
        }
        return RedisCloudClient.instance;
    }

    public async connect(): Promise<void> {
        if (!this.client.isOpen) {
            await this.client.connect();
        }
    }

    public async disconnect(): Promise<void> {
        if (this.client.isOpen) {
            await this.client.quit();
        }
    }

    public getClient(): RedisClientType {
        return this.client;
    }

    // --- SESSION MANAGEMENT ---

    /**
     * Stores session data in Redis with an optional TTL.
     */
    private async setSession(key: string, data: any, ttlSeconds: number = 3600): Promise<void> {
        if (data === undefined) {
            console.error("❌ setSession: data is undefined, skipping Redis set");
            return;
        }
        await this.connect();
        await this.client.set(key, JSON.stringify(data), { EX: ttlSeconds });
    }

    /**
     * Retrieves session data from Redis.
     */
    public async getSession(key: string): Promise<any | null> {
        await this.connect();
        const data = await this.client.get(key);
        return data ? JSON.parse(data) : null;
    }

    // --- Safe Redis Helpers ---
    public async safeSetSession(userId: string | undefined, data: any, ttl: number): Promise<void> {
        if (!userId) {
            console.error("❌ safeSetSession: userId is undefined, skipping Redis set");
            return;
        }
        if (!data) {
            console.error(`❌ safeSetSession: data for user ${userId} is undefined, skipping Redis set`);
            return;
        }
        console.log(`✅ safeSetSession: storing session for user ${userId}`);
        await this.setSession(userId, data, ttl);
    };

    public async safeExpireSession(userId: string | undefined, ttl: number): Promise<void> {
        if (!userId) {
            console.error("❌ safeExpireSession: userId is undefined, skipping Redis expire");
            return;
        }
        console.log(`✅ safeExpireSession: expiring session for user ${userId}`);
        await this.expireSession(userId, ttl);
    };

    /**
     * Updates the TTL of an existing session.
     */
    public async expireSession(key: string, ttlSeconds: number): Promise<void> {
        await this.connect();
        await this.client.expire(key, ttlSeconds);
    }

    /**
     * Deletes a session from Redis.
     */
    public async deleteSession(key: string): Promise<void> {
        await this.connect();
        await this.client.del(key);
    }

    // --- CONVERSATION CACHING ---

    /**
     * Caches an array of messages for a specific conversation.
     */
    public async setConversationCache(conversationId: string | undefined, messages: any[], ttlSeconds: number = 3600): Promise<void> {
        if (!conversationId) {
            console.error("❌ setConversationCache: conversationId is undefined, skipping Redis set");
            return;
        }
        if (!messages) {
            console.error(`❌ setConversationCache: messages for conv:${conversationId} is undefined, skipping Redis set`);
            return;
        }
        const key = `conv:${conversationId}`;
        await this.connect();
        await this.client.set(key, JSON.stringify(messages), { EX: ttlSeconds });
    }

    /**
     * Retrieves cached messages for a conversation.
     */
    public async getConversationCache(conversationId: string): Promise<any[] | null> {
        const key = `conv:${conversationId}`;
        await this.connect();
        const data = await this.client.get(key);
        return data ? JSON.parse(data) : null;
    }

    /**
     * Appends a message to the conversation cache.
     */
    public async appendMessageToCache(conversationId: string | undefined, message: any, ttlSeconds: number = 3600): Promise<void> {
        if (!conversationId) {
            console.error("❌ appendMessageToCache: conversationId is undefined, skipping Redis set");
            return;
        }
        if (!message) {
            console.error(`❌ appendMessageToCache: message for conv:${conversationId} is undefined, skipping Redis set`);
            return;
        }
        const currentCache = await this.getConversationCache(conversationId);
        if (currentCache) {
            currentCache.unshift(message);
            await this.setConversationCache(conversationId, currentCache, ttlSeconds);
        } else {
            await this.setConversationCache(conversationId, [message], ttlSeconds);
        }
    }


    /**
     * Clears all data from the database.
     */
    public async flushAll(): Promise<void> {
        console.log("🧹 Clearing Redis Cloud cache...");
        await this.connect();
        await this.client.flushDb();
    }
}

export default RedisCloudClient;
