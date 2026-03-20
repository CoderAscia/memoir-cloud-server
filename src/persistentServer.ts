import WebSocket, { WebSocketServer } from "ws";
import admin from "./firebase_admin";
import { v4 as uuidv4 } from 'uuid';
import Database from "./database";
import DBHandler from "./dbHandler";
import RedisClient from "./redisClient";
import aiService from "./aiService";
import { UserDocument, CharacterDocument, MemoryDocument, ConversationDocument, MessageDocument } from "./interface_types";

const port = 3030;
const API_KEY = process.env.OPENAI_API_KEY ?? null;

// Initialize Database connection
Database.getInstance().catch(err => {
  console.error("Failed to initialize database:", err);
  process.exit(1);
});

const dbUsers = new DBHandler<UserDocument>("users");
const dbCharacters = new DBHandler<CharacterDocument>("characters");
const dbConversations = new DBHandler<ConversationDocument>("conversations");
const dbMessages = new DBHandler<MessageDocument>("messages");
const dbMemories = new DBHandler<MemoryDocument>("memories");

const redisClient = RedisClient.getInstance();

interface DeltaData {
  deltaCharacters: CharacterDocument[];
  deltaConversations: ConversationDocument[];
  deltaMessages: MessageDocument[];
  deltaMemories: MemoryDocument[];
  deltaVersion: string;
}

// Clear Redis cache on server restart
redisClient.flushAll().then(() => {
  console.log("Redis cache cleared on startup.");
}).catch(err => {
  console.error("Failed to clear Redis cache:", err);
});

const wss = new WebSocketServer({ port: port, host: "0.0.0.0" });

if (API_KEY == null) throw new Error("API Key cannot be null");

// FIX #1 & #8: Moved updateSyncTimestamp outside processMessage (no longer re-created
// on every message), and fixed it to also write to the DB when the Redis cache is cold
// so the version is never silently lost.
const TTL = 180;

async function updateSyncTimestamp(userId: string) {
  const newVersion = Date.now().toString();
  const cachedUserData = await redisClient.getSession(userId);
  if (cachedUserData) {
    cachedUserData.timestampVersion = newVersion;
    await redisClient.setSession(userId, cachedUserData, TTL);
  } else {
    // Cache is cold (expired/evicted) — persist directly to DB so it's not lost
    await dbUsers.update({ uid: userId }, { $set: { timestampVersion: newVersion } });
  }
}

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

    if (parsedMessage['type'] == "getLatestUserData") {

      // Get the last sync timestamp from the client
      const currentTimeStampVersion = parsedMessage['lastSyncVersion'];
      let user_timestampVersion: string;

      // Check if the user data is already in the cache
      const cachedUserData = await redisClient.getSession(userId);
      if (cachedUserData) {
        user_timestampVersion = cachedUserData.timestampVersion;
      } else {
        // Cache miss (expired/evicted) — fall back to the DB value
        const userDoc = await dbUsers.findOne({ uid: userId });
        user_timestampVersion = userDoc?.timestampVersion ?? '0';
      }

      // FIX #2: Use else-if so only ONE branch fires. '0.0.0' is checked first
      // because it is the most specific case (full initial sync), and would also
      // satisfy the `< user_timestampVersion` condition causing a double-send.
      if (currentTimeStampVersion === '0.0.0') {

        const deltaCharacters = await dbCharacters.find({ uid: userId });
        const deltaConversations = await dbConversations.find({ uid: userId });
        const deltaMessages = await dbMessages.find({ uid: userId });
        const deltaMemories = await dbMemories.find({ uid: userId });

        const deltaData: DeltaData = {
          deltaCharacters: deltaCharacters,
          deltaConversations: deltaConversations,
          deltaMessages: deltaMessages,
          deltaMemories: deltaMemories,
          deltaVersion: user_timestampVersion
        };

        socket.send(JSON.stringify({ "type": "syncResponse", "isLatest": false, "uid": userId, "delta_updates": deltaData, "timestampVersion": user_timestampVersion }));

      } else if (currentTimeStampVersion < user_timestampVersion) {

        const deltaCharacters = await dbCharacters.find({ uid: userId, lastModified: { $gt: currentTimeStampVersion } }) ?? [];
        const deltaConversations = await dbConversations.find({ uid: userId, lastModified: { $gt: currentTimeStampVersion } }) ?? [];
        const deltaMessages = await dbMessages.find({ uid: userId, lastModified: { $gt: currentTimeStampVersion } }) ?? [];
        const deltaMemories = await dbMemories.find({ uid: userId, lastModified: { $gt: currentTimeStampVersion } }) ?? [];

        const deltaData: DeltaData = {
          deltaCharacters: deltaCharacters,
          deltaConversations: deltaConversations,
          deltaMessages: deltaMessages,
          deltaMemories: deltaMemories,
          deltaVersion: user_timestampVersion
        };

        socket.send(JSON.stringify({ "type": "syncResponse", "isLatest": false, "uid": userId, "delta_updates": deltaData }));

      } else if (currentTimeStampVersion === user_timestampVersion) {
        socket.send(JSON.stringify({ "type": "syncResponse", "isLatest": true, "uid": userId, "delta_updates": null, "timestampVersion": user_timestampVersion }));
        console.log("Sent latest user data");
      }

    } else if (parsedMessage.type == "getCharacterDetails") {
      const { characterId } = parsedMessage;
      // FIX #7: Sort by 'lastModified' (the actual field name) instead of 'timestamp'
      const conversations = await dbConversations.find({ characterId }, { sort: { lastModified: -1 } });
      const memories = await dbMemories.find({ characterId }, { sort: { lastModified: -1 } });
      socket.send(JSON.stringify({ type: "characterDetailsResponse", characterId, data: { conversations, memories } }));

    } else if (parsedMessage.type == "getMessages") {
      const { conversationId, lastMessageTimestamp, limit = 20 } = parsedMessage;
      let filter: any = { conversationId };

      if (!lastMessageTimestamp) {
        const cachedMessages = await redisClient.getConversationCache(conversationId);
        if (cachedMessages) {
          socket.send(JSON.stringify({ type: "messagesResponse", conversationId, data: cachedMessages }));
          await redisClient.expireSession(`conv:${conversationId}`, TTL);
          return;
        }
      } else {
        // FIX #6: Use 'lastModified' (the actual field name) instead of 'timestamp'
        filter.lastModified = { $lt: lastMessageTimestamp };
      }

      const messages = await dbMessages.find(filter, { sort: { lastModified: -1 }, limit: limit });
      if (!lastMessageTimestamp) await redisClient.setConversationCache(conversationId, messages, TTL);
      socket.send(JSON.stringify({ type: "messagesResponse", conversationId, data: messages }));

    } else if (parsedMessage.type == "createCharacter") {

      const name = parsedMessage.characterName?.trim();

      // FIX #4: Reject blank/missing character names before hitting the DB
      if (!name) {
        socket.send(JSON.stringify({ type: "createCharacterResponse", status: "error", message: "Character name is required" }));
        return;
      }

      if (await dbCharacters.findOne({ uid: userId, characterName: name })) {
        socket.send(JSON.stringify({ type: "createCharacterResponse", status: "error", message: "Character exists" }));
        await updateSyncTimestamp(userId);
        return;
      }
      const newChar: CharacterDocument = { characterId: uuidv4(), lastModified: Date.now().toString(), uid: userId, characterName: name, characterImagePath: parsedMessage.characterImagePath, characterMetaData: parsedMessage.characterMetaData };
      await dbCharacters.create(newChar as any);
      if (userData?.characters) { userData.characters.push(newChar); await redisClient.setSession(userId, userData, TTL); }
      await updateSyncTimestamp(userId);
      socket.send(JSON.stringify({ type: "createCharacterResponse", status: "success", data: newChar }));

    } else if (parsedMessage.type == "updateCharacter") {
      const { characterId, ...updateData } = parsedMessage;
      await dbCharacters.update({ characterId, uid: userId }, { $set: updateData });
      if (userData?.characters) {
        const idx = userData.characters.findIndex((c: any) => c.characterId === characterId);
        if (idx !== -1) { userData.characters[idx] = { ...userData.characters[idx], ...updateData }; await redisClient.setSession(userId, userData, TTL); }
      }
      await updateSyncTimestamp(userId);
      socket.send(JSON.stringify({ type: "updateCharacterResponse", status: "success", characterId }));

    } else if (parsedMessage.type == "deleteCharacter") {
      const { characterId } = parsedMessage;
      await dbCharacters.delete({ characterId, uid: userId });
      if (userData?.characters) { userData.characters = userData.characters.filter((c: any) => c.characterId !== characterId); await redisClient.setSession(userId, userData, TTL); }
      await updateSyncTimestamp(userId);
      socket.send(JSON.stringify({ type: "deleteCharacterResponse", status: "success", characterId }));

    } else if (parsedMessage.type == "createConversation") {
      const { characterId, conversationTitle } = parsedMessage;
      const newConv: ConversationDocument = { uid: userId, conversationId: uuidv4(), characterId, conversationTitle, lastModified: Date.now().toString() };
      await dbConversations.create(newConv as any);
      if (userData?.conversations) { userData.conversations.push(newConv); await redisClient.setSession(userId, userData, TTL); }
      await updateSyncTimestamp(userId);
      socket.send(JSON.stringify({ type: "createConversationResponse", status: "success", data: newConv }));

    } else if (parsedMessage.type == "chat") {
      const { conversationId, message: msgContent } = parsedMessage;
      const conv = await dbConversations.findOne({ conversationId });

      // FIX #3: Send an error back instead of silently dropping the request
      if (!conv) {
        socket.send(JSON.stringify({ type: "error", message: "Conversation not found" }));
        return;
      }

      const userMsg: MessageDocument = { messageId: uuidv4(), uid: userId, conversationId, messageTitle: "User", messageContent: msgContent, lastModified: Date.now().toString(), sender: "user" };
      await dbMessages.create(userMsg as any);
      await redisClient.appendMessageToCache(conversationId, userMsg, TTL);

      const reply = await aiService.generateReply(conv.characterId, conversationId);
      const aiMsg: MessageDocument = { messageId: uuidv4(), uid: userId, conversationId, messageTitle: "AI", messageContent: reply, lastModified: Date.now().toString(), sender: "ai" };
      await dbMessages.create(aiMsg as any);
      await redisClient.appendMessageToCache(conversationId, aiMsg, TTL);
      await dbConversations.update({ conversationId }, { $set: { lastModified: aiMsg.lastModified } });

      await updateSyncTimestamp(userId);

      socket.send(JSON.stringify({ type: "chat", message_id: aiMsg.messageId, reply, lastModified: aiMsg.lastModified }));

    } else if (parsedMessage.type == "createMemory") {
      const { characterId, memoryTitle, memoryContent, memorySplashArts } = parsedMessage;
      const newMemory: MemoryDocument = { uid: userId, memoryId: uuidv4(), characterId, memoryTitle, memoryContent, memorySplashArts, lastModified: Date.now().toString() };
      await dbMemories.create(newMemory as any);
      if (userData?.memories) { userData.memories.push(newMemory); await redisClient.setSession(userId, userData, TTL); }
      await updateSyncTimestamp(userId);
      socket.send(JSON.stringify({ type: "createMemoryResponse", status: "success", data: newMemory }));

    } else if (parsedMessage.type == "updateMemory") {
      const { memoryId, characterId, memoryTitle, memoryContent, memorySplashArts } = parsedMessage;
      await dbMemories.update({ memoryId, characterId }, { $set: { memoryTitle, memoryContent, memorySplashArts } });
      if (userData?.memories) { const idx = userData.memories.findIndex((m: any) => m.memoryId === memoryId); if (idx !== -1) { userData.memories[idx] = { ...userData.memories[idx], memoryTitle, memoryContent, memorySplashArts }; await redisClient.setSession(userId, userData, TTL); } }
      await updateSyncTimestamp(userId);
      socket.send(JSON.stringify({ type: "updateMemoryResponse", status: "success", memoryId }));

    } else if (parsedMessage.type == "deleteMemory") {
      const { memoryId, characterId } = parsedMessage;
      await dbMemories.delete({ memoryId, characterId });
      if (userData?.memories) { userData.memories = userData.memories.filter((m: any) => m.memoryId !== memoryId); await redisClient.setSession(userId, userData, TTL); }
      await updateSyncTimestamp(userId);
      socket.send(JSON.stringify({ type: "deleteMemoryResponse", status: "success", memoryId }));

    }
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
    let cachedSession = await redisClient.getSession(userId);
    if (cachedSession) {
      userData = cachedSession;
    } else {
      let userDoc = await dbUsers.findOne({ uid: userId });
      if (!userDoc) {
        const newChar: CharacterDocument = {
          characterId: uuidv4(), lastModified: Date.now().toString(), uid: userId, characterName: "Yuuki", characterImagePath: "assets/images/purple_kawaii.jpg",
          characterMetaData: { characterStickers: [], chatBackgroundImage: "", relationship: "Friend", characterPersonality: "Helpful", characterBackstory: "Yuuki is kind." }
        };
        // FIX #5: Store timestampVersion as a string everywhere for consistent comparisons
        await Promise.all([dbUsers.create({ uid: userId, timestampVersion: Date.now().toString() } as any), dbCharacters.create(newChar as any)]);
      }

      userData = { timestampVersion: Date.now().toString() }; // FIX #5: string, not number
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

console.log(`WebSocket server running`);
