"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ws_1 = require("ws");
const express_1 = __importDefault(require("express"));
const path_1 = __importDefault(require("path"));
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
// Setup Express mapping strictly for the Admin Dashboard
const app = (0, express_1.default)();
const dashboardPort = 3031;
app.use(express_1.default.static(path_1.default.join(__dirname, '../public')));
app.listen(dashboardPort, '0.0.0.0', () => {
    console.log(`Admin Dashboard running on http://localhost:${dashboardPort}`);
});
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
        if (parsedMessage['type'] == "getLatestUserData") {
            socket.send(JSON.stringify({ "type": "syncResponse", "uid": userId, "data": userData }));
            console.log("Sent latest user data");
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
                return;
            }
            const newChar = { characterId: (0, uuid_1.v4)(), uid: userId, characterName: name, characterImagePath: parsedMessage.characterImagePath, characterMetaData: parsedMessage.characterMetaData };
            await dbCharacters.create(newChar);
            if (userData?.characters) {
                userData.characters.push(newChar);
                await redisClient.setSession(userId, userData, TTL);
            }
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
            socket.send(JSON.stringify({ type: "updateCharacterResponse", status: "success", characterId }));
        }
        else if (parsedMessage.type == "deleteCharacter") {
            const { characterId } = parsedMessage;
            await dbCharacters.delete({ characterId, uid: userId });
            if (userData?.characters) {
                userData.characters = userData.characters.filter((c) => c.characterId !== characterId);
                await redisClient.setSession(userId, userData, TTL);
            }
            socket.send(JSON.stringify({ type: "deleteCharacterResponse", status: "success", characterId }));
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
            socket.send(JSON.stringify({ type: "chat", message_id: aiMsg.messageId, reply, timestamp: aiMsg.timestamp.toString() }));
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
                await Promise.all([dbUsers.create({ uid: userId, timestampVersion: "prototype" }), dbCharacters.create(newChar)]);
            }
            const chars = await dbCharacters.find({ uid: userId });
            userData = { timestampVersion: "prototype", characters: chars };
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
