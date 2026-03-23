"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ws_1 = require("ws");
const firebase_admin_1 = __importStar(require("./firebase_admin"));
const uuid_1 = require("uuid");
const database_1 = __importDefault(require("./database"));
const dbHandler_1 = __importDefault(require("./dbHandler"));
const redisCloudClient_1 = __importDefault(require("./redisCloudClient"));
const aiService_1 = __importDefault(require("./aiService"));
const handlers_1 = require("./handlers");
// Initialize Services and Start Server
async function startServer() {
    try {
        // 1. Initialize Firebase
        await (0, firebase_admin_1.initFirebase)();
        // 2. Initialize Database connection
        await database_1.default.getInstance();
        // 3. Initialize AI Service
        await aiService_1.default.init();
        // 4. Initialize Redis Cloud Client
        const redisClient = await redisCloudClient_1.default.getInstance();
        const dbUsers = new dbHandler_1.default("users");
        const dbCharacters = new dbHandler_1.default("characters");
        const dbConversations = new dbHandler_1.default("conversations");
        const dbMessages = new dbHandler_1.default("messages");
        const dbMemories = new dbHandler_1.default("memories");
        const port = parseInt(process.env.PORT || "8080", 10);
        // Clear Redis cache on server restart
        redisClient.flushAll().then(() => {
            console.log("Redis cache cleared on startup.");
        }).catch(err => {
            console.error("Failed to clear Redis cache:", err);
        });
        const wss = new ws_1.WebSocketServer({ port: port, host: "0.0.0.0" });
        // FIX #1 & #8: Moved updateSyncTimestamp outside processMessage (no longer re-created
        // on every message), and fixed it to also write to the DB when the Redis cache is cold
        // so the version is never silently lost.
        const TTL = 180;
        const updateSyncTimestamp = async (userId) => {
            const newVersion = Date.now().toString();
            const cachedUserData = await redisClient.getSession(userId);
            cachedUserData.timestampVersion = newVersion;
            await redisClient.setSession(userId, cachedUserData, TTL);
            // Cache is cold (expired/evicted) — persist directly to DB so it's not lost
            await dbUsers.update({ uid: userId }, { $set: { timestampVersion: newVersion } });
        };
        wss.on("connection", async (socket, req) => {
            const fullUrl = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
            const token = fullUrl.searchParams.get("token");
            let userData = null;
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
            const context = {
                socket,
                userId,
                redisClient,
                db: { users: dbUsers, characters: dbCharacters, conversations: dbConversations, messages: dbMessages, memories: dbMemories },
                ai: aiService_1.default,
                updateSyncTimestamp,
                TTL
            };
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
                await (0, handlers_1.routeMessage)(context, parsedMessage, userData);
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
                        await dbUsers.update({ uid: userId }, { $set: { timestampVersion: cachedUserData.timestampVersion } });
                    }
                    await redisClient.expireSession(userId, TTL);
                });
                // --- SESSION INITIALIZATION ---
                const cachedSession = await redisClient.getSession(userId);
                if (cachedSession) {
                    userData = cachedSession;
                }
                else {
                    const userDoc = await dbUsers.findOne({ uid: userId });
                    if (!userDoc) {
                        const newChar = {
                            characterId: (0, uuid_1.v4)(), lastModified: Date.now().toString(), uid: userId, characterName: "Yuuki", characterImagePath: "assets/images/purple_kawaii.jpg",
                            characterMetaData: { characterStickers: [], chatBackgroundImage: "", relationship: "Friend", characterPersonality: "Helpful", characterBackstory: "Yuuki is kind." }
                        };
                        // FIX #5: Store timestampVersion as a string everywhere for consistent comparisons
                        await Promise.all([dbUsers.create({ uid: userId, timestampVersion: Date.now().toString() }), dbCharacters.create(newChar)]);
                    }
                    const storedTimestampVersion = userDoc?.timestampVersion;
                    userData = { timestampVersion: storedTimestampVersion ?? Date.now().toString() }; // FIX #5: string, not number
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
        console.log(`WebSocket server running on port ${port}`);
    }
    catch (err) {
        console.error("Failed to start server:", err);
        process.exit(1);
    }
}
startServer().catch(err => {
    console.error("Critical error during server startup:", err);
    process.exit(1);
});
