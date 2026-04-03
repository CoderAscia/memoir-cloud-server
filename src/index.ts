import WebSocket, { WebSocketServer } from "ws";
import FirebaseAdmin, { admin } from "./firebase_admin";
import { v4 as uuidv4 } from 'uuid';
import Database from "./database";
import DBHandler from "./dbHandler";
import RedisCloudClient from "./redisCloudClient";
import aiService from "./aiService";
import { UserDocument, CharacterDocument, MemoryDocument, ConversationDocument, MessageDocument } from "./interface_types";
import { Context } from "./types";
import { routeMessage } from "./handlers";


async function startServer() {
    try {
        // 1. Initialize Firebase
        await FirebaseAdmin.getInstance();
        // 2. Initialize Database connection
        await Database.getInstance();
        // 3. Initialize AI Service
        await aiService.init();
        // 4. Initialize Redis Cloud Client
        const redisClient = await RedisCloudClient.getInstance();

        const dbUsers = new DBHandler<UserDocument>("users");
        const dbCharacters = new DBHandler<CharacterDocument>("characters");
        const dbConversations = new DBHandler<ConversationDocument>("conversations");
        const dbMemories = new DBHandler<MemoryDocument>("memories");
        const dbMessages = new DBHandler<MessageDocument>("messages");
        const port = process.env.NODE_ENV == "production" ? 8080 : 3000;

        // Clear Redis cache on server restart
        redisClient.flushAll().then(async () => {
            console.log("Redis cache cleared on startup.");
            console.log("Deleting all data from database...");
            await dbUsers.deleteAll();
            await dbCharacters.deleteAll();
            await dbConversations.deleteAll();
            await dbMemories.deleteAll();
            await dbMessages.deleteAll();
            console.log("Database cleared on startup.");

        }).catch(err => {
            console.error("Failed to clear Redis cache:", err);
        });


        const wss = new WebSocketServer({ port: port, host: "0.0.0.0" });

        const TTL = 500;

        const updateSyncTimestamp = async (userId: string) => {
            const newVersion = new Date().toISOString();
            let cachedUserData = await redisClient.getSession(userId);
            if (!cachedUserData) {
                console.log(`[Update Sync Timestamp] User ${userId} not found in cache. Fetching from database.`);
                const userDoc = await dbUsers.findOne({ userId });
                if (!userDoc) return;
                cachedUserData = userDoc;
            };
            //Update user cache timestamp
            cachedUserData.lastSync = newVersion;

            // Cache is cold (expired/evicted) — persist directly to DB so it's not lost
            await dbUsers.update({ userId }, { $set: { lastSync: newVersion } });
        };

        wss.on("connection", async (socket: WebSocket, req) => {
            const fullUrl = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
            const token = fullUrl.searchParams.get("token");
            let userData: UserDocument = { userId: "", lastSync: "", list_conversation: [], list_characters: [] };

            socket.on('open', () => {
                console.log(`WebSocket: Connection request for ${fullUrl.pathname}${fullUrl.search ? ' with token' : ' without token'}`);
            })

            // --- EARLY MESSAGE HANDLER (BUFFERING) ---
            let isInitialized = false;
            const messageBuffer: WebSocket.RawData[] = [];
            const earlyMessageHandler = (data: WebSocket.RawData) => {
                if (!isInitialized) {
                    console.log("Buffering early message...");
                    messageBuffer.push(data);
                }
            };
            if (!isInitialized) {
                socket.on("message", earlyMessageHandler);
            }

            // Core message processing logic
            const processMessage = async (data: WebSocket.RawData, currentUserData: UserDocument) => {

                const context: Context = {
                    socket,
                    userId: currentUserData.userId,
                    redisClient,
                    db: { users: dbUsers, conversations: dbConversations, memories: dbMemories, messages: dbMessages, characters: dbCharacters },
                    ai: aiService,
                    updateSyncTimestamp,
                    TTL
                };


                const message = data.toString();
                console.log(`Processing message from user ${currentUserData.userId}: ${message.substring(0, 50)}...`);
                await redisClient.expireSession(currentUserData.userId, TTL);

                let parsedMessage;
                try {
                    parsedMessage = JSON.parse(message);
                } catch (err) {
                    console.error("Failed to parse message:", err);
                    socket.send(JSON.stringify({ type: "error", message: "Invalid JSON format" }));
                    return;
                }

                await routeMessage(context, parsedMessage, currentUserData);
            };

            try {
                // --- AUTHENTICATION ---
                if (token === "test_token") {
                    console.log("⚠️ WARNING: Test Backdoor Accessed ⚠️");
                    userData.userId = "test_user_id";
                } else {
                    try {
                        const decodedToken = await admin.auth().verifyIdToken(token ?? "");
                        userData.userId = decodedToken.uid;
                    } catch (err: any) {
                        console.error("Invalid Firebase token:", err.message);
                        socket.close();
                        return;
                    }
                }

                console.log("Authenticated user:", userData.userId);

                socket.on("close", async () => {
                    console.log(`WebSocket closed for ${userData.userId}`);
                    const cachedUserData = await redisClient.getSession(userData.userId);
                    if (cachedUserData) {
                        await dbUsers.update({ userId: userData.userId }, { $set: { lastSync: cachedUserData.lastSync } });
                    }
                    await redisClient.expireSession(userData.userId, TTL); // Set timer to clear cache

                });

                // --- SESSION INITIALIZATION ---
                const cachedSession = await redisClient.getSession(userData.userId);
                if (cachedSession) {
                    userData = cachedSession;
                } else {
                    const userDoc = await dbUsers.findOne({ userId: userData.userId });
                    if (!userDoc) {
                        const newChar: CharacterDocument = {
                            characterId: uuidv4(), lastModified: Date.now().toString(), uid: userData.userId, characterName: "Yuuki", characterImagePath: "assets/images/purple_kawaii.jpg",
                            characterMetaData: { characterStickers: [], chatBackgroundImage: "", relationship: "Friend", characterPersonality: "Helpful", characterBackstory: "Yuuki is kind." }
                        };

                        userData = {
                            userId: userData.userId,
                            lastSync: Date.now().toString(),
                            list_characters: [newChar.characterId],
                            list_conversation: []
                        } as UserDocument;
                        await Promise.all(
                            [
                                dbUsers.create(userData),
                                dbCharacters.create(newChar as any)
                            ]);
                    } else {
                        userData = userDoc;
                    }

                    console.log("Caching user data:", userData);
                    await redisClient.safeSetSession(userData.userId, userData, TTL);
                }

                // --- COMPLETION & BUFFER PROCESSING ---
                if (!isInitialized) {
                    isInitialized = true;
                    socket.off("message", earlyMessageHandler);
                    socket.on("message", (data) => processMessage(data, userData));
                    console.log(`Processing ${messageBuffer.length} buffered messages...`);
                    for (const msg of messageBuffer) await processMessage(msg, userData);
                }
            } catch (err) {
                console.error("Connection initialization error:", err);
                socket.close();
            }

        });

    } catch (err) {
        console.error("Failed to start server:", err);
        process.exit(1);
    }

}

startServer().then(() => {
    console.log("Server listening at port 3000");
}).catch(err => {
    console.error("Critical error during server startup:", err);
    process.exit(1);
});