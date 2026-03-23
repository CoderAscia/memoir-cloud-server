"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleMessage = handleMessage;
const uuid_1 = require("uuid");
async function handleMessage(context, parsedMessage) {
    const { socket, userId, db, redisClient, ai, updateSyncTimestamp, TTL } = context;
    if (parsedMessage.type === "getMessages") {
        const { conversationId, lastMessageTimestamp, limit = 20 } = parsedMessage;
        const filter = { conversationId };
        if (!lastMessageTimestamp) {
            const cachedMessages = await redisClient.getConversationCache(conversationId);
            if (cachedMessages) {
                socket.send(JSON.stringify({ type: "messagesResponse", conversationId, data: cachedMessages }));
                await redisClient.expireSession(`conv:${conversationId}`, TTL);
                return;
            }
        }
        else {
            filter.lastModified = { $lt: lastMessageTimestamp };
        }
        const messages = await db.messages.find(filter, { sort: { lastModified: -1 }, limit: limit });
        if (!lastMessageTimestamp)
            await redisClient.setConversationCache(conversationId, messages, TTL);
        socket.send(JSON.stringify({ type: "messagesResponse", conversationId, data: messages }));
    }
    else if (parsedMessage.type === "createConversation") {
        const { characterId, conversationTitle } = parsedMessage;
        const newConv = { uid: userId, conversationId: (0, uuid_1.v4)(), characterId, conversationTitle, lastModified: Date.now().toString() };
        await db.conversations.create(newConv);
        await updateSyncTimestamp(userId);
        socket.send(JSON.stringify({ type: "createConversationResponse", status: "success", data: newConv }));
    }
    else if (parsedMessage.type === "chat") {
        const { conversationId, message: msgContent, messageId } = parsedMessage;
        const conv = await db.conversations.findOne({ conversationId });
        if (!conv)
            throw new Error("Conversation not found");
        const userMsg = { messageId, uid: userId, conversationId, messageTitle: "User", messageContent: msgContent, lastModified: Date.now().toString(), sender: "user" };
        await db.messages.create(userMsg);
        await redisClient.appendMessageToCache(conversationId, userMsg, TTL);
        const reply = await ai.generateReply(conv.characterId, conversationId);
        const timestamp = Date.now().toString();
        const aiMsg = { messageId: (0, uuid_1.v4)(), uid: userId, conversationId, messageTitle: "AI", messageContent: reply, lastModified: timestamp, sender: "ai" };
        await db.messages.create(aiMsg);
        await redisClient.appendMessageToCache(conversationId, aiMsg, TTL);
        await db.conversations.update({ conversationId }, { $set: { lastModified: timestamp } });
        await updateSyncTimestamp(userId);
        socket.send(JSON.stringify({ type: "chat", message_id: aiMsg.messageId, reply, lastModified: timestamp }));
    }
}
