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
    console.log(`WebSocket: Connection request for ${fullUrl.pathname}${fullUrl.search ? ' with token' : ' without token'}`);
    let userId;
    // --- TEST BACKDOOR ---
    // Allow a specific token string for Postman testing
    if (token === "test_token") {
        console.log("⚠️ WARNING: Test Backdoor Accessed ⚠️");
        userId = "test_user_id";
    }
    else {
        // Normal Production Flow
        let decodedToken;
        try {
            decodedToken = await firebase_admin_1.default.auth().verifyIdToken(token ?? "");
            userId = decodedToken.uid;
        }
        catch (err) {
            console.log("Invalid Firebase token :" + token);
            console.error("Invalid Firebase token:", err.message);
            socket.close();
            return;
        }
    }
    console.log("Authenticated user UID:", userId);
    socket.on("close", async () => {
        console.log(`WebSocket connection closed for user ${userId}`);
        // Keep session alive for 10 minutes (600 seconds) after disconnect
        await redisClient.expireSession(userId, 600);
    });
    socket.on("error", async (error) => {
        console.error("WebSocket error:", error);
    });
    // 1. Try to get session from Redis
    // let cachedSession = await redisClient.getSession(userId);
    let cachedSession = null;
    if (cachedSession) {
        console.log(`Loaded user ${userId} from Redis (Cache)`);
        userData = cachedSession;
    }
    else {
        console.log(`Loading user ${userId} from MongoDB`);
        let userDoc = await dbUsers.findOne({ uid: userId });
        if (!userDoc) {
            const newUserDoc = {
                uid: userId,
                timestampVersion: "prototype",
                characters: [
                    {
                        characterId: (0, uuid_1.v4)(),
                        characterName: "Yuuki",
                        characterImagePath: "assets/images/purple_kawaii.jpg",
                        characterMetaData: {
                            characterStickers: [],
                            chatBackgroundImage: "",
                            relationship: "Friend",
                            characterPersonality: "Helpful and wise",
                            characterBackstory: "Yuuki is a kind and caring friend who is always there to support you. She is a great listener and always knows the right thing to say."
                        }
                    }
                ]
            };
            await dbUsers.create(newUserDoc);
            userDoc = newUserDoc;
        }
        const userCharacters = await dbCharacters.find({ uid: userId });
        userData = {
            timestampVersion: userDoc.timestampVersion,
            characters: userCharacters
        };
        // 2. Save to Redis with a 1-hour TTL (3600 seconds)
        await redisClient.setSession(userId, userData, 3600);
    }
    try {
        socket.on("message", async (data) => {
            // Refresh Redis TTL on active use (keep alive for 1 hour)
            await redisClient.expireSession(userId, 3600);
            const message = data.toString();
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
                const data = { "type": "syncResponse", "uid": userId, "data": userData };
                socket.send(JSON.stringify(data));
                console.log("Sent latest user data");
            }
            else if (parsedMessage.type == "getCharacterDetails") {
                const { characterId } = parsedMessage;
                // Fetch conversations and memories, sorted by newest first
                const conversations = await dbConversations.find({ characterId }, { sort: { timestamp: -1 } });
                const memories = await dbMemories.find({ characterId }, { sort: { timestamp: -1 } });
                socket.send(JSON.stringify({
                    type: "characterDetailsResponse",
                    characterId,
                    data: {
                        conversations,
                        memories
                    }
                }));
                console.log(`Sent details for character ${characterId}`);
            }
            else if (parsedMessage.type == "getMessages") {
                const { conversationId, lastMessageTimestamp, limit = 20 } = parsedMessage;
                // Build filter for pagination
                let filter = { conversationId };
                // Only use cache if no pagination timestamp is provided (getting initial load)
                if (!lastMessageTimestamp) {
                    const cachedMessages = await redisClient.getConversationCache(conversationId);
                    if (cachedMessages) {
                        socket.send(JSON.stringify({
                            type: "messagesResponse",
                            conversationId,
                            data: cachedMessages
                        }));
                        console.log(`Sent ${cachedMessages.length} messages for conversation ${conversationId} (Loaded from Redis Cache)`);
                        // Refresh TTL
                        await redisClient.expireSession(`conv:${conversationId}`, 3600);
                        return;
                    }
                }
                else {
                    filter.timestamp = { $lt: lastMessageTimestamp };
                }
                // Fetch messages, sort descending (newest first), limit results
                const messages = await dbMessages.find(filter, {
                    sort: { timestamp: -1 },
                    limit: limit
                });
                // Cache the initial load
                if (!lastMessageTimestamp) {
                    await redisClient.setConversationCache(conversationId, messages, 3600);
                    console.log(`Saved ${messages.length} messages for conversation ${conversationId} to Redis Cache`);
                }
                socket.send(JSON.stringify({
                    type: "messagesResponse",
                    conversationId,
                    data: messages
                }));
                console.log(`Sent ${messages.length} messages for conversation ${conversationId}`);
            }
            else if (parsedMessage.type == "createCharacter") {
                const characterName = parsedMessage.characterName?.trim();
                // Check if character already exists for this user
                const existingCharacter = await dbCharacters.findOne({
                    uid: userId,
                    characterName: characterName
                });
                if (existingCharacter) {
                    socket.send(JSON.stringify({
                        type: "createCharacterResponse",
                        status: "error",
                        message: `A character named '${characterName}' already exists.`
                    }));
                    console.log(`Character creation failed: '${characterName}' already exists for user ${userId}`);
                    return;
                }
                const newCharDoc = {
                    characterId: (0, uuid_1.v4)(),
                    uid: userId,
                    characterName: characterName,
                    characterImagePath: parsedMessage.characterImagePath,
                    characterMetaData: parsedMessage.characterMetaData
                };
                await dbCharacters.create(newCharDoc);
                // Update local memory and Redis cache to prevent stale data
                if (userData && Array.isArray(userData.characters)) {
                    userData.characters.push(newCharDoc);
                    await redisClient.setSession(userId, userData, 3600);
                }
                socket.send(JSON.stringify({
                    type: "createCharacterResponse",
                    status: "success",
                    data: newCharDoc
                }));
                console.log(`Created new character: ${characterName}`);
            }
            else if (parsedMessage.type == "updateCharacter") {
                const { characterId, characterName, characterImagePath, characterMetaData } = parsedMessage;
                // 1. Verify character belongs to user
                const existingCharacter = await dbCharacters.findOne({ characterId, uid: userId });
                if (!existingCharacter) {
                    socket.send(JSON.stringify({
                        type: "updateCharacterResponse",
                        status: "error",
                        message: "Character not found or access denied."
                    }));
                    return;
                }
                // 2. Prevent duplicate names if name is changing
                if (characterName && characterName.trim() !== existingCharacter.characterName) {
                    const duplicate = await dbCharacters.findOne({ uid: userId, characterName: characterName.trim() });
                    if (duplicate) {
                        socket.send(JSON.stringify({
                            type: "updateCharacterResponse",
                            status: "error",
                            message: `A character named '${characterName.trim()}' already exists.`
                        }));
                        return;
                    }
                }
                // 3. Build update payload
                const updateData = {};
                if (characterName)
                    updateData.characterName = characterName.trim();
                if (characterImagePath !== undefined)
                    updateData.characterImagePath = characterImagePath;
                if (characterMetaData !== undefined)
                    updateData.characterMetaData = characterMetaData;
                await dbCharacters.update({ characterId }, { $set: updateData });
                // 4. Update local memory array and Redis Cache
                if (userData && Array.isArray(userData.characters)) {
                    const charIndex = userData.characters.findIndex((c) => c.characterId === characterId);
                    if (charIndex !== -1) {
                        userData.characters[charIndex] = { ...userData.characters[charIndex], ...updateData };
                        await redisClient.setSession(userId, userData, 3600);
                    }
                }
                socket.send(JSON.stringify({
                    type: "updateCharacterResponse",
                    status: "success",
                    characterId,
                    updatedFields: updateData
                }));
                console.log(`Updated character: ${characterId}`);
            }
            else if (parsedMessage.type == "deleteCharacter") {
                const { characterId } = parsedMessage;
                // 1. Verify character belongs to user
                const existingCharacter = await dbCharacters.findOne({ characterId, uid: userId });
                if (!existingCharacter) {
                    socket.send(JSON.stringify({
                        type: "deleteCharacterResponse",
                        status: "error",
                        message: "Character not found or access denied."
                    }));
                    return;
                }
                // 2. Delete character
                await dbCharacters.delete({ characterId });
                // 3. Update local memory array and Redis cache
                if (userData && Array.isArray(userData.characters)) {
                    userData.characters = userData.characters.filter((c) => c.characterId !== characterId);
                    await redisClient.setSession(userId, userData, 3600);
                }
                socket.send(JSON.stringify({
                    type: "deleteCharacterResponse",
                    status: "success",
                    characterId
                }));
                console.log(`Deleted character: ${characterId}`);
            }
            else if (parsedMessage.type == "createConversation") {
                const newConvDoc = {
                    conversationId: (0, uuid_1.v4)(),
                    characterId: parsedMessage.characterId,
                    conversationTitle: parsedMessage.conversationTitle,
                    timestamp: Date.now()
                };
                await dbConversations.create(newConvDoc);
                socket.send(JSON.stringify({
                    type: "createConversationResponse",
                    status: "success",
                    data: newConvDoc
                }));
                console.log("Created new conversation");
            }
            else if (parsedMessage.type == "createMemory") {
                const newMemoryDoc = {
                    memoryId: (0, uuid_1.v4)(),
                    characterId: parsedMessage.characterId,
                    memoryTitle: parsedMessage.memoryTitle,
                    memoryContent: parsedMessage.memoryContent,
                    memorySplashArts: parsedMessage.memorySplashArts || [],
                    timestamp: Date.now()
                };
                await dbMemories.create(newMemoryDoc);
                socket.send(JSON.stringify({
                    type: "createMemoryResponse",
                    status: "success",
                    data: newMemoryDoc
                }));
                console.log("Created new memory");
            }
            else if (parsedMessage.type == "updateMemory") {
                const { memoryId, characterId, memoryTitle, memoryContent, memorySplashArts } = parsedMessage;
                // 1. Verify character belongs to user
                const existingCharacter = await dbCharacters.findOne({ characterId, uid: userId });
                if (!existingCharacter) {
                    socket.send(JSON.stringify({
                        type: "updateMemoryResponse",
                        status: "error",
                        message: "Character not found or access denied."
                    }));
                    return;
                }
                // 2. Build update payload
                const updateData = {};
                if (memoryTitle !== undefined)
                    updateData.memoryTitle = memoryTitle;
                if (memoryContent !== undefined)
                    updateData.memoryContent = memoryContent;
                if (memorySplashArts !== undefined)
                    updateData.memorySplashArts = memorySplashArts;
                await dbMemories.update({ memoryId, characterId }, { $set: updateData });
                socket.send(JSON.stringify({
                    type: "updateMemoryResponse",
                    status: "success",
                    memoryId,
                    updatedFields: updateData
                }));
                console.log(`Updated memory: ${memoryId}`);
            }
            else if (parsedMessage.type == "deleteMemory") {
                const { memoryId, characterId } = parsedMessage;
                // 1. Verify character belongs to user
                const existingCharacter = await dbCharacters.findOne({ characterId, uid: userId });
                if (!existingCharacter) {
                    socket.send(JSON.stringify({
                        type: "deleteMemoryResponse",
                        status: "error",
                        message: "Character not found or access denied."
                    }));
                    return;
                }
                // 2. Delete memory
                await dbMemories.delete({ memoryId, characterId });
                socket.send(JSON.stringify({
                    type: "deleteMemoryResponse",
                    status: "success",
                    memoryId
                }));
                console.log(`Deleted memory: ${memoryId}`);
            }
            else if (parsedMessage.type == "chat") {
                const { conversationId, message } = parsedMessage;
                // 1. Fetch Conversation to get characterId
                const conversationDoc = await dbConversations.findOne({ conversationId });
                if (!conversationDoc) {
                    socket.send(JSON.stringify({ type: "error", message: "Conversation not found." }));
                    return;
                }
                // 2. Save User Message
                const userMessageDoc = {
                    messageId: (0, uuid_1.v4)(),
                    conversationId: conversationId,
                    messageTitle: "User",
                    messageContent: message,
                    timestamp: Date.now(),
                    sender: "user"
                };
                await dbMessages.create(userMessageDoc);
                await redisClient.appendMessageToCache(conversationId, userMessageDoc, 3600);
                // 3. Generate AI Reply using AIService
                const aiReplyContent = await aiService_1.default.generateReply(conversationDoc.characterId, conversationId);
                // 4. Save AI Message
                const aiMessageDoc = {
                    messageId: (0, uuid_1.v4)(),
                    conversationId: conversationId,
                    messageTitle: "AI",
                    messageContent: aiReplyContent,
                    timestamp: Date.now() + 1, // Ensure slightly later timestamp
                    sender: "ai"
                };
                await dbMessages.create(aiMessageDoc);
                await redisClient.appendMessageToCache(conversationId, aiMessageDoc, 3600);
                // 5. Bump Conversation Timestamp
                await dbConversations.update({ conversationId }, { $set: { timestamp: aiMessageDoc.timestamp } });
                // 5. Send response back
                socket.send(JSON.stringify({
                    'type': "chat",
                    "message_id": aiMessageDoc.messageId,
                    "reply": aiReplyContent,
                    "timestamp": aiMessageDoc.timestamp.toString(),
                }));
                console.log(`Sent and saved AI response for conversation ${conversationId}`);
            }
        });
    }
    catch (err) {
        console.error("Invalid token:", err.message);
        socket.close();
    }
});
console.log(`WebSocket server running`);
