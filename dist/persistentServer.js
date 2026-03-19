"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ws_1 = require("ws");
const firebase_admin_1 = __importDefault(require("./firebase_admin"));
const uuid_1 = require("uuid");
const database_1 = __importDefault(require("./database"));
const dbHandler_1 = __importDefault(require("./dbHandler"));
const redisClient_1 = __importDefault(require("./redisClient"));
const aiService_1 = __importDefault(require("./aiService"));
const port = 3030;
const API_KEY = process.env.OPENAI_API_KEY ?? null;
// Initialize Database connection
database_1.default.getInstance().catch(err => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
});
const dbUsers = new dbHandler_1.default("users");
const dbCharacters = new dbHandler_1.default("characters");
const dbConversations = new dbHandler_1.default("conversations");
const dbMessages = new dbHandler_1.default("messages");
const dbMemories = new dbHandler_1.default("memories");
const redisClient = redisClient_1.default.getInstance();
// Clear Redis cache on server restart
redisClient.flushAll().then(() => {
    console.log("Redis cache cleared on startup.");
}).catch(err => {
    console.error("Failed to clear Redis cache:", err);
});
const wss = new ws_1.WebSocketServer({ port: port, host: "0.0.0.0" });
if (API_KEY == null)
    throw new Error("API Key cannot be null");
wss.on("connection", async (socket, req) => {
    const fullUrl = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
    const token = fullUrl.searchParams.get("token");
    let userData = null;
    const TTL = 180;
    let userId = ""; // Initialize to avoid used-before-assignment errors
    console.log(`WebSocket: Connection request for ${fullUrl.pathname}${fullUrl.search ? ' with token' : ' without token'}`);
    // --- EARLY MESSAGE HANDLER (BUFFERING) ---
    let isInitialized = false;
    const messageBuffer = [];
    const earlyMessageHandler = (data) => {
        if (!isInitialized) {
            console.log("Buffering early message...");
            messageBuffer.push(data);
        }
    };
    socket.on("message", earlyMessageHandler);
    // Core message processing logic
    const processMessage = async (data) => {
        await redisClient.expireSession(userId, TTL);
        const message = data.toString();
        console.log(`Processing message from user ${userId}: ${message.substring(0, 50)}...`);
        let parsedMessage;
        try {
            parsedMessage = JSON.parse(message);
        }
        catch (err) {
            console.error("Failed to parse message:", err);
            socket.send(JSON.stringify({ type: "error", message: "Invalid JSON format" }));
            return;
        }
        async function updateSyncTimestamp(userId) {
            const cachedUserData = await redisClient.getSession(userId);
            if (cachedUserData) {
                cachedUserData.timestampVersion = Date.now().toString();
                await redisClient.setSession(userId, cachedUserData, TTL); // Update the timestamp version in the cache
            }
        }
        if (parsedMessage['type'] == "getLatestUserData") {
            // Get the last sync timestamp from DB
            const currentTimeStampVersion = parsedMessage['lastSyncVersion'];
            let user_timestampVersion;
            // Check if the user data is already in the cache
            const cachedUserData = await redisClient.getSession(userId);
            user_timestampVersion = cachedUserData.timestampVersion;
            if (currentTimeStampVersion < user_timestampVersion) {
                var deltaCharacters = await dbCharacters.find({ uid: userId, timestampVersion: { $gt: user_timestampVersion } });
                var deltaConversations = await dbConversations.find({ uid: userId, timestampVersion: { $gt: user_timestampVersion } });
                var deltaMessages = await dbMessages.find({ uid: userId, timestampVersion: { $gt: user_timestampVersion } });
                var deltaMemories = await dbMemories.find({ uid: userId, timestampVersion: { $gt: user_timestampVersion } });
                const deltaData = {
                    characters: deltaCharacters,
                    conversations: deltaConversations,
                    messages: deltaMessages,
                    memories: deltaMemories
                };
                socket.send(JSON.stringify({ "type": "syncResponse", "isLatest": false, "uid": userId, "delta_updates": deltaData }));
            }
            if (currentTimeStampVersion == '0.0.0') {
                var deltaCharacters = await dbCharacters.find({ uid: userId });
                var deltaConversations = await dbConversations.find({ uid: userId });
                var deltaMessages = await dbMessages.find({ uid: userId });
                var deltaMemories = await dbMemories.find({ uid: userId });
                const deltaData = {
                    characters: deltaCharacters,
                    conversations: deltaConversations,
                    messages: deltaMessages,
                    memories: deltaMemories
                };
                socket.send(JSON.stringify({ "type": "syncResponse", "isLatest": false, "uid": userId, "delta_updates": deltaData, "timestampVersion": user_timestampVersion }));
            }
            if (currentTimeStampVersion === user_timestampVersion) {
                socket.send(JSON.stringify({ "type": "syncResponse", "isLatest": true, "uid": userId, "delta_updates": null, "timestampVersion": user_timestampVersion }));
                console.log("Sent latest user data");
            }
        }
        else if (parsedMessage.type == "getCharacterDetails") {
            const { characterId } = parsedMessage;
            const conversations = await dbConversations.find({ characterId }, { sort: { timestamp: -1 } });
            const memories = await dbMemories.find({ characterId }, { sort: { timestamp: -1 } });
            socket.send(JSON.stringify({ type: "characterDetailsResponse", characterId, data: { conversations, memories } }));
        }
        else if (parsedMessage.type == "getMessages") {
            const { conversationId, lastMessageTimestamp, limit = 20 } = parsedMessage;
            let filter = { conversationId };
            if (!lastMessageTimestamp) {
                const cachedMessages = await redisClient.getConversationCache(conversationId);
                if (cachedMessages) {
                    socket.send(JSON.stringify({ type: "messagesResponse", conversationId, data: cachedMessages }));
                    await redisClient.expireSession(`conv:${conversationId}`, TTL);
                    return;
                }
            }
            else {
                filter.timestamp = { $lt: lastMessageTimestamp };
            }
            const messages = await dbMessages.find(filter, { sort: { timestamp: -1 }, limit: limit });
            if (!lastMessageTimestamp)
                await redisClient.setConversationCache(conversationId, messages, TTL);
            socket.send(JSON.stringify({ type: "messagesResponse", conversationId, data: messages }));
        }
        else if (parsedMessage.type == "createCharacter") {
            const name = parsedMessage.characterName?.trim();
            if (await dbCharacters.findOne({ uid: userId, characterName: name })) {
                socket.send(JSON.stringify({ type: "createCharacterResponse", status: "error", message: "Character exists" }));
                await updateSyncTimestamp(userId); // Update the timestamp version
                return;
            }
            const newChar = { characterId: (0, uuid_1.v4)(), uid: userId, characterName: name, characterImagePath: parsedMessage.characterImagePath, characterMetaData: parsedMessage.characterMetaData };
            await dbCharacters.create(newChar);
            if (userData?.characters) {
                userData.characters.push(newChar);
                await redisClient.setSession(userId, userData, TTL);
            }
            await updateSyncTimestamp(userId); // Update the timestamp version
            socket.send(JSON.stringify({ type: "createCharacterResponse", status: "success", data: newChar }));
        }
        else if (parsedMessage.type == "updateCharacter") {
            const { characterId, ...updateData } = parsedMessage;
            await dbCharacters.update({ characterId, uid: userId }, { $set: updateData });
            if (userData?.characters) {
                const idx = userData.characters.findIndex((c) => c.characterId === characterId);
                if (idx !== -1) {
                    userData.characters[idx] = { ...userData.characters[idx], ...updateData };
                    await redisClient.setSession(userId, userData, TTL);
                }
            }
            await updateSyncTimestamp(userId); // Update the timestamp version
            socket.send(JSON.stringify({ type: "updateCharacterResponse", status: "success", characterId }));
        }
        else if (parsedMessage.type == "deleteCharacter") {
            const { characterId } = parsedMessage;
            await dbCharacters.delete({ characterId, uid: userId });
            if (userData?.characters) {
                userData.characters = userData.characters.filter((c) => c.characterId !== characterId);
                await redisClient.setSession(userId, userData, TTL);
            }
            await updateSyncTimestamp(userId); // Update the timestamp version
            socket.send(JSON.stringify({ type: "deleteCharacterResponse", status: "success", characterId }));
        }
        else if (parsedMessage.type == "createConversation") {
            const { characterId, conversationTitle } = parsedMessage;
            const newConv = { conversationId: (0, uuid_1.v4)(), characterId, conversationTitle, timestamp: Date.now() };
            await dbConversations.create(newConv);
            if (userData?.conversations) {
                userData.conversations.push(newConv);
                await redisClient.setSession(userId, userData, TTL);
            }
            await updateSyncTimestamp(userId); // Update the timestamp version
            socket.send(JSON.stringify({ type: "createConversationResponse", status: "success", data: newConv }));
        }
        else if (parsedMessage.type == "chat") {
            const { conversationId, message: msgContent } = parsedMessage;
            const conv = await dbConversations.findOne({ conversationId });
            if (!conv)
                return;
            const userMsg = { messageId: (0, uuid_1.v4)(), conversationId, messageTitle: "User", messageContent: msgContent, timestamp: Date.now(), sender: "user" };
            await dbMessages.create(userMsg);
            await redisClient.appendMessageToCache(conversationId, userMsg, TTL);
            const reply = await aiService_1.default.generateReply(conv.characterId, conversationId);
            const aiMsg = { messageId: (0, uuid_1.v4)(), conversationId, messageTitle: "AI", messageContent: reply, timestamp: Date.now() + 1, sender: "ai" };
            await dbMessages.create(aiMsg);
            await redisClient.appendMessageToCache(conversationId, aiMsg, TTL);
            await dbConversations.update({ conversationId }, { $set: { timestamp: aiMsg.timestamp } });
            await updateSyncTimestamp(userId); // Update the timestamp version
            socket.send(JSON.stringify({ type: "chat", message_id: aiMsg.messageId, reply, timestamp: aiMsg.timestamp.toString() }));
        }
        else if (parsedMessage.type == "createMemory") {
            const { characterId, memoryTitle, memoryContent, memorySplashArts } = parsedMessage;
            const newMemory = { memoryId: (0, uuid_1.v4)(), characterId, memoryTitle, memoryContent, memorySplashArts, timestamp: Date.now() };
            await dbMemories.create(newMemory);
            if (userData?.memories) {
                userData.memories.push(newMemory);
                await redisClient.setSession(userId, userData, TTL);
            }
            await updateSyncTimestamp(userId); // Update the timestamp version
            socket.send(JSON.stringify({ type: "createMemoryResponse", status: "success", data: newMemory }));
        }
        else if (parsedMessage.type == "updateMemory") {
            const { memoryId, characterId, memoryTitle, memoryContent, memorySplashArts } = parsedMessage;
            await dbMemories.update({ memoryId, characterId }, { $set: { memoryTitle, memoryContent, memorySplashArts } });
            if (userData?.memories) {
                const idx = userData.memories.findIndex((m) => m.memoryId === memoryId);
                if (idx !== -1) {
                    userData.memories[idx] = { ...userData.memories[idx], memoryTitle, memoryContent, memorySplashArts };
                    await redisClient.setSession(userId, userData, TTL);
                }
            }
            await updateSyncTimestamp(userId); // Update the timestamp version
            socket.send(JSON.stringify({ type: "updateMemoryResponse", status: "success", memoryId }));
        }
        else if (parsedMessage.type == "deleteMemory") {
            const { memoryId, characterId } = parsedMessage;
            await dbMemories.delete({ memoryId, characterId });
            if (userData?.memories) {
                userData.memories = userData.memories.filter((m) => m.memoryId !== memoryId);
                await redisClient.setSession(userId, userData, TTL);
            }
            await updateSyncTimestamp(userId); // Update the timestamp version
            socket.send(JSON.stringify({ type: "deleteMemoryResponse", status: "success", memoryId }));
        }
    };
    try {
        // --- AUTHENTICATION ---
        if (token === "test_token") {
            console.log("⚠️ WARNING: Test Backdoor Accessed ⚠️");
            userId = "test_user_id";
        }
        else {
            try {
                const decodedToken = await firebase_admin_1.default.auth().verifyIdToken(token ?? "");
                userId = decodedToken.uid;
            }
            catch (err) {
                console.error("Invalid Firebase token:", err.message);
                socket.close();
                return;
            }
        }
        console.log("Authenticated user:", userId);
        socket.on("close", async () => {
            console.log(`WebSocket closed for ${userId}`);
            const cachedUserData = await redisClient.getSession(userId);
            if (cachedUserData) {
                await dbUsers.update({ uid: userId }, { $set: { timestampVersion: cachedUserData.timestampVersion } }); // Update the timestamp version in the database
            }
            await redisClient.expireSession(userId, TTL);
        });
        // --- SESSION INITIALIZATION ---
        let cachedSession = await redisClient.getSession(userId);
        if (cachedSession) {
            userData = cachedSession;
        }
        else {
            let userDoc = await dbUsers.findOne({ uid: userId });
            if (!userDoc) {
                const newChar = {
                    characterId: (0, uuid_1.v4)(), uid: userId, characterName: "Yuuki", characterImagePath: "assets/images/purple_kawaii.jpg",
                    characterMetaData: { characterStickers: [], chatBackgroundImage: "", relationship: "Friend", characterPersonality: "Helpful", characterBackstory: "Yuuki is kind." }
                };
                await Promise.all([dbUsers.create({ uid: userId, timestampVersion: Date.now() }), dbCharacters.create(newChar)]);
            }
            userData = { timestampVersion: Date.now() };
            await redisClient.setSession(userId, userData, TTL);
        }
        // --- COMPLETION & BUFFER PROCESSING ---
        isInitialized = true;
        socket.off("message", earlyMessageHandler);
        socket.on("message", processMessage);
        console.log(`Processing ${messageBuffer.length} buffered messages...`);
        for (const msg of messageBuffer)
            await processMessage(msg);
    }
    catch (err) {
        console.error("Connection initialization error:", err);
        socket.close();
    }
});
console.log(`WebSocket server running`);
