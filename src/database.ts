import { MongoClient, Db } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

class Database {
    private static instance: Database;
    private client: MongoClient;
    private dbName: string;

    private constructor() {
        const uri = process.env.MONGODB_URI;
        if (!uri) {
            throw new Error('MONGODB_URI is not defined in environment variables');
        }
        this.client = new MongoClient(uri);
        this.dbName = uri.split('/').pop()?.split('?')[0] || 'memoir_db';
        console.log(`MongoDB: Resolved database name as '${this.dbName}'`);
    }

    public static async getInstance(): Promise<Database> {
        if (!Database.instance) {
            Database.instance = new Database();
            await Database.instance.connect();
        }
        return Database.instance;
    }

    private async connect(): Promise<void> {
        try {
            await this.client.connect();
            console.log('Connected successfully to MongoDB');
        } catch (error) {
            console.error('Error connecting to MongoDB:', error);
            throw error;
        }
    }

    public getDb(): Db {
        return this.client.db(this.dbName);
    }

    public async close(): Promise<void> {
        await this.client.close();
    }
}

export default Database;
