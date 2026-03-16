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
if (API_KEY == null)
    throw new Error("API Key cannot be null");
wss.on("connection", async (socket, req) => {
    const fullUrl = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
    const token = fullUrl.searchParams.get("token");
    let userData = null;
    console.log(`WebSocket: Connection request for ${fullUrl.pathname}${fullUrl.search ? ' with token' : ' without token'}`);
    let decodedToken;
    try {
        decodedToken = await firebase_admin_1.default.auth().verifyIdToken(token ?? "") || token == "test_token";
    }
    catch (err) {
        console.log("Invalid Firebase token :" + token);
        console.error("Invalid Firebase token:", err.message);
        socket.close();
        return;
    }
    const userId = decodedToken.uid;
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
    let cachedSession = await redisClient.getSession(userId);
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
                timestampVersion: "prototype"
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
                // Fetch conversations and memories for this character
                const conversations = await dbConversations.find({ characterId });
                const memories = await dbMemories.find({ characterId });
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
                if (lastMessageTimestamp) {
                    filter.timestamp = { $lt: lastMessageTimestamp };
                }
                // Fetch messages, sort descending (newest first), limit results
                const messages = await dbMessages.find(filter, {
                    sort: { timestamp: -1 },
                    limit: limit
                });
                socket.send(JSON.stringify({
                    type: "messagesResponse",
                    conversationId,
                    data: messages
                }));
                console.log(`Sent ${messages.length} messages for conversation ${conversationId}`);
            }
            else if (parsedMessage.type == "createCharacter") {
                const newCharDoc = {
                    characterId: (0, uuid_1.v4)(),
                    uid: userId,
                    characterName: parsedMessage.characterName,
                    characterImagePath: parsedMessage.characterImagePath,
                    characterMetaData: parsedMessage.characterMetaData
                };
                await dbCharacters.create(newCharDoc);
                socket.send(JSON.stringify({
                    type: "createCharacterResponse",
                    status: "success",
                    data: newCharDoc
                }));
                console.log("Created new character");
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
            else if (parsedMessage.type == "chat") {
                const { conversationId, message } = parsedMessage;
                // Save User Message
                const userMessageDoc = {
                    messageId: (0, uuid_1.v4)(),
                    conversationId: conversationId,
                    messageTitle: "User",
                    messageContent: message,
                    timestamp: Date.now(),
                    sender: "user"
                };
                await dbMessages.create(userMessageDoc);
                // Generate AI Reply (Placeholder for actual OpenAI call)
                const aiReplyContent = `I received your message: ${message}`;
                // Save AI Message
                const aiMessageDoc = {
                    messageId: (0, uuid_1.v4)(),
                    conversationId: conversationId,
                    messageTitle: "AI",
                    messageContent: aiReplyContent,
                    timestamp: Date.now() + 1, // Ensure slightly later timestamp
                    sender: "ai"
                };
                await dbMessages.create(aiMessageDoc);
                // Send response back
                socket.send(JSON.stringify({
                    'type': "chat",
                    "message_id": aiMessageDoc.messageId,
                    "reply": aiReplyContent,
                    "timestamp": aiMessageDoc.timestamp.toString(),
                }));
                console.log("Sent and saved chat response");
            }
        });
    }
    catch (err) {
        console.error("Invalid token:", err.message);
        socket.close();
    }
});
console.log(`WebSocket server running`);
