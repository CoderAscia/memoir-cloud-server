import { Collection, Filter, OptionalUnlessRequiredId, Document, UpdateFilter, FindOptions, InsertOneResult, UpdateResult, DeleteResult, WithId } from 'mongodb';
import Database from './database';

class DBHandler<T extends Document> {
    private collectionName: string;

    constructor(collectionName: string) {
        this.collectionName = collectionName;
    }

    private async getCollection(): Promise<Collection<T>> {
        const dbInstance = await Database.getInstance();
        return dbInstance.getDb().collection<T>(this.collectionName);
    }

    public async create(data: OptionalUnlessRequiredId<T>): Promise<InsertOneResult<T>> {
        const collection = await this.getCollection();
        return await collection.insertOne(data);
    }

    public async findOne(filter: Filter<T>): Promise<WithId<T> | null> {
        const collection = await this.getCollection();
        return await collection.findOne(filter);
    }

    public async find(filter: Filter<T>, options?: FindOptions): Promise<WithId<T>[]> {
        const collection = await this.getCollection();
        return await collection.find(filter, options).toArray();
    }

    public async update(filter: Filter<T>, update: UpdateFilter<T>): Promise<UpdateResult<T>> {
        const collection = await this.getCollection();
        return await collection.updateOne(filter, update);
    }

    public async delete(filter: Filter<T>): Promise<DeleteResult> {
        const collection = await this.getCollection();
        return await collection.deleteOne(filter);
    }

    public async deleteAll(): Promise<void> {
        const collection = await this.getCollection();
        await collection.deleteMany({});
    }
}

export default DBHandler;
