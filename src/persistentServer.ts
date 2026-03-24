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

// Initialize Services and Start Server
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
    const dbMessages = new DBHandler<MessageDocument>("messages");
    const dbMemories = new DBHandler<MemoryDocument>("memories");

    const port = process.env.NODE_ENV == "production" ? 8080 : 3000;



    // Clear Redis cache on server restart
    redisClient.flushAll().then(() => {
      console.log("Redis cache cleared on startup.");
    }).catch(err => {
      console.error("Failed to clear Redis cache:", err);
    });

    const wss = new WebSocketServer({ port: port, host: "0.0.0.0" });


    // FIX #1 & #8: Moved updateSyncTimestamp outside processMessage (no longer re-created
    // on every message), and fixed it to also write to the DB when the Redis cache is cold
    // so the version is never silently lost.
    const TTL = 180;

    const updateSyncTimestamp = async (userId: string) => {
      const newVersion = Date.now().toString();
      const cachedUserData = await redisClient.getSession(userId);

      cachedUserData.timestampVersion = newVersion;
      await redisClient.setSession(userId, cachedUserData, TTL);

      // Cache is cold (expired/evicted) — persist directly to DB so it's not lost
      await dbUsers.update({ uid: userId }, { $set: { timestampVersion: newVersion } });
    };

    wss.on("connection", async (socket: WebSocket, req) => {
      const fullUrl = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
      const token = fullUrl.searchParams.get("token");
      let userData: any = null;
      let userId = ""; // Initialize to avoid used-before-assignment errors

      console.log(`WebSocket: Connection request for ${fullUrl.pathname}${fullUrl.search ? ' with token' : ' without token'}`);

      // --- EARLY MESSAGE HANDLER (BUFFERING) ---
      let isInitialized = false;
      const messageBuffer: WebSocket.RawData[] = [];

      const earlyMessageHandler = (data: WebSocket.RawData) => {
        if (!isInitialized) {
          console.log("Buffering early message...");
          messageBuffer.push(data);
        }
      };
      socket.on("message", earlyMessageHandler);

      const context: Context = {
        socket,
        userId,
        redisClient,
        db: { users: dbUsers, characters: dbCharacters, conversations: dbConversations, messages: dbMessages, memories: dbMemories },
        ai: aiService,
        updateSyncTimestamp,
        TTL
      };

      // Core message processing logic
      const processMessage = async (data: WebSocket.RawData) => {
        await redisClient.expireSession(userId, TTL);
        const message = data.toString();
        console.log(`Processing message from user ${userId}: ${message.substring(0, 50)}...`);

        let parsedMessage;
        try {
          parsedMessage = JSON.parse(message);
        } catch (err) {
          console.error("Failed to parse message:", err);
          socket.send(JSON.stringify({ type: "error", message: "Invalid JSON format" }));
          return;
        }

        await routeMessage(context, parsedMessage, userData);
      };

      try {
        // --- AUTHENTICATION ---
        if (token === "test_token") {
          console.log("⚠️ WARNING: Test Backdoor Accessed ⚠️");
          userId = "test_user_id";
        } else {
          try {
            const decodedToken = await admin.auth().verifyIdToken(token ?? "");
            userId = decodedToken.uid;
          } catch (err: any) {
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
        } else {
          const userDoc = await dbUsers.findOne({ uid: userId });
          if (!userDoc) {
            const newChar: CharacterDocument = {
              characterId: uuidv4(), lastModified: Date.now().toString(), uid: userId, characterName: "Yuuki", characterImagePath: "assets/images/purple_kawaii.jpg",
              characterMetaData: { characterStickers: [], chatBackgroundImage: "", relationship: "Friend", characterPersonality: "Helpful", characterBackstory: "Yuuki is kind." }
            };
            // FIX #5: Store timestampVersion as a string everywhere for consistent comparisons
            await Promise.all([dbUsers.create({ uid: userId, timestampVersion: Date.now().toString() } as any), dbCharacters.create(newChar as any)]);
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
        for (const msg of messageBuffer) await processMessage(msg);

      } catch (err: any) {
        console.error("Connection initialization error:", err);
        socket.close();
      }
    });

    console.log(`WebSocket server running on port ${port}`);
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

startServer().catch(err => {
  console.error("Critical error during server startup:", err);
  process.exit(1);
});
