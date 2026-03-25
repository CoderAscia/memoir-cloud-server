import { v4 as uuidv4 } from 'uuid';
import { Context } from "../types";
import { MessageDocument, ConversationDocument } from "../interface_types";

// In-memory set to prevent overlapping AI generations for the same conversation
const generatingConversations = new Set<string>();

export async function handleMessage(context: Context, parsedMessage: any) {
  const { socket, userId, db, redisClient, ai, updateSyncTimestamp, TTL } = context;

  if (parsedMessage.type === "getMessages") {
    const { conversationId, lastMessageTimestamp, limit = 20 } = parsedMessage;

    if (!conversationId) {
      console.error("❌ getMessages: conversationId is missing");
      socket.send(JSON.stringify({ type: "error", message: "conversationId required" }));
      return;
    }

    const filter: any = { conversationId };

    if (!lastMessageTimestamp) {
      const cachedMessages = await redisClient.getConversationCache(conversationId);
      if (cachedMessages) {
        socket.send(JSON.stringify({ type: "messagesResponse", conversationId, data: cachedMessages }));
        await redisClient.expireSession(`conv:${conversationId}`, TTL);
        return;
      }
    } else {
      filter.lastModified = { $lt: lastMessageTimestamp };
    }

    const messages = await db.messages.find(filter, { sort: { lastModified: -1 }, limit });
    if (!lastMessageTimestamp) await redisClient.setConversationCache(conversationId, messages, TTL);
    socket.send(JSON.stringify({ type: "messagesResponse", conversationId, data: messages }));

  } else if (parsedMessage.type === "chat") {
    const { conversationId, characterId, conversationTitle, message: msgContent, messageId } = parsedMessage;

    if (!conversationId) {
      console.error("❌ chat: conversationId is missing");
      socket.send(JSON.stringify({ type: "error", message: "conversationId required" }));
      return;
    }
    if (!characterId) {
      console.error("❌ chat: characterId is missing");
      socket.send(JSON.stringify({ type: "error", message: "characterId required" }));
      return;
    }

    const createConversation = async () => {
      const newConv: ConversationDocument = {
        uid: userId,
        conversationId: uuidv4(),
        characterId,
        conversationTitle: conversationTitle ?? "Untitled",
        lastModified: Date.now().toString()
      };
      await db.conversations.create(newConv as any);
      await updateSyncTimestamp(userId);
      return newConv;
    };

    if (generatingConversations.has(conversationId)) {
      console.log(`[Message Handler] Skipping overlapping AI request for conversation ${conversationId}`);
      return;
    }

    let conv = await db.conversations.findOne({ conversationId }) as ConversationDocument | null;
    if (!conv) {
      console.log(`[Message Handler] Creating new conversation for user ${userId}`);
      conv = await createConversation();
    }

    const userMsg: MessageDocument = {
      messageId,
      uid: userId,
      conversationId,
      messageTitle: "User",
      messageContent: msgContent,
      lastModified: Date.now().toString(),
      sender: "user"
    };
    await db.messages.create(userMsg as any);
    await redisClient.appendMessageToCache(conversationId, userMsg, TTL);

    try {
      generatingConversations.add(conversationId);
      const reply = await ai.generateReply(conv.characterId, conversationId);
      const timestamp = Date.now().toString();
      const aiMsg: MessageDocument = {
        messageId: uuidv4(),
        uid: userId,
        conversationId,
        messageTitle: "AI",
        messageContent: reply,
        lastModified: timestamp,
        sender: "ai"
      };
      await db.messages.create(aiMsg as any);
      await redisClient.appendMessageToCache(conversationId, aiMsg, TTL);
      await db.conversations.update({ conversationId }, { $set: { lastModified: timestamp } });

      await updateSyncTimestamp(userId);
      socket.send(JSON.stringify({ type: "aiChatResponse", message_id: aiMsg.messageId, reply, lastModified: timestamp }));
    } finally {
      generatingConversations.delete(conversationId);
    }
  }
}
