import { v4 as uuidv4 } from 'uuid';
import { Context } from "../types";
import { MessageDocument, ConversationDocument } from "../interface_types";

// In-memory set to prevent overlapping AI generations for the same conversation
const generatingConversations = new Set<string>();

type Response = {
  title: string;
  message: string;
};

class ResponseGenerator {
  private responses: Response[];

  constructor() {
    this.responses = [
      { title: "Greeting", message: "Hello there! Hope you're having a great day." },
      { title: "Motivation", message: "Keep pushing forward, success is closer than you think." },
      { title: "Reminder", message: "Don't forget to take breaks and stay hydrated." },
      { title: "Fun Fact", message: "Did you know? Honey never spoils." },
    ];
  }

  public getRandomResponse(): Response {
    const randomIndex = Math.floor(Math.random() * this.responses.length);
    return this.responses[randomIndex];
  }
}


export async function handleMessage(context: Context, parsedMessage: any) {
  const { socket, userId, db, redisClient, ai, updateSyncTimestamp, TTL } = context;
  const generator = new ResponseGenerator();

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
    let { conversationId, characterId, conversationTitle, message: msgContent, messageId } = parsedMessage;

    console.log("chat message received: ", parsedMessage);

    conversationTitle = conversationTitle ?? generator.getRandomResponse().title;

    const createConversation = async () => {
      const newConv: ConversationDocument = {
        uid: userId,
        conversationId: uuidv4(),
        characterId,
        conversationTitle: conversationTitle,
        lastModified: Date.now().toString()
      };
      await db.conversations.create(newConv as any);
      console.log("Conversation created: ", newConv);
      await updateSyncTimestamp(userId);
      return newConv;
    };


    if (!conversationId) {
      console.error("chat: conversationId is missing , new conversation will be created");
      conversationId = (await createConversation()).conversationId;

    }

    if (!characterId) {
      console.error("chat: characterId is missing");
      socket.send(JSON.stringify({ type: "error", message: "characterId required" }));
      return;
    }

    if (generatingConversations.has(conversationId)) {
      console.log(`[Message Handler] Skipping overlapping AI request for conversation ${conversationId}`);
      return;
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
      // const reply = await ai.generateReply(characterId, conversationId);
      const reply = generator.getRandomResponse().message;
      const timestamp = new Date().toISOString();
      const aiMsg: MessageDocument = {
        messageId: uuidv4(),
        uid: userId,
        conversationId,
        messageTitle: "Untitled",
        messageContent: reply,
        lastModified: timestamp,
        sender: "ai"
      };
      await db.messages.create(aiMsg as any);
      await redisClient.appendMessageToCache(conversationId, aiMsg, TTL);
      await db.conversations.update({ conversationId }, { $set: { lastModified: timestamp } });

      await updateSyncTimestamp(userId);
      socket.send(JSON.stringify({ type: "aiChatResponse", conversationTitle: conversationTitle, message_id: aiMsg.messageId, reply, lastModified: timestamp, conversationId }));
    } finally {
      generatingConversations.delete(conversationId);
    }
  }
}
