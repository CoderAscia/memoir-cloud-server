"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongodb_1 = require("mongodb");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
class Database {
    constructor() {
        const uri = process.env.MONGODB_URI;
        if (!uri) {
            throw new Error('MONGODB_URI is not defined in environment variables');
        }
        this.client = new mongodb_1.MongoClient(uri);
        this.dbName = uri.split('/').pop()?.split('?')[0] || 'memoir_db';
        console.log(`MongoDB: Resolved database name as '${this.dbName}'`);
    }
    static async getInstance() {
        if (!Database.instance) {
            Database.instance = new Database();
            await Database.instance.connect();
        }
        return Database.instance;
    }
    async connect() {
        try {
            await this.client.connect();
            console.log('Connected successfully to MongoDB');
        }
        catch (error) {
            console.error('Error connecting to MongoDB:', error);
            throw error;
        }
    }
    getDb() {
        return this.client.db(this.dbName);
    }
    async close() {
        await this.client.close();
    }
}
exports.default = Database;
