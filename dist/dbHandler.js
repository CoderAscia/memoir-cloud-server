"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const database_1 = __importDefault(require("./database"));
class DBHandler {
    constructor(collectionName) {
        this.collectionName = collectionName;
    }
    async getCollection() {
        const dbInstance = await database_1.default.getInstance();
        return dbInstance.getDb().collection(this.collectionName);
    }
    async create(data) {
        const collection = await this.getCollection();
        return await collection.insertOne(data);
    }
    async findOne(filter) {
        const collection = await this.getCollection();
        return await collection.findOne(filter);
    }
    async find(filter, options) {
        const collection = await this.getCollection();
        return await collection.find(filter, options).toArray();
    }
    async update(filter, update) {
        const collection = await this.getCollection();
        return await collection.updateOne(filter, update);
    }
    async delete(filter) {
        const collection = await this.getCollection();
        return await collection.deleteOne(filter);
    }
}
exports.default = DBHandler;
