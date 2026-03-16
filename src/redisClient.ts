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

    public async close(): Promise<void> {
        await this.client.quit();
    }
}

export default RedisClient;
