import OpenAI from 'openai';
import DBHandler from './dbHandler';
import RedisClient from './redisClient';
import { CharacterDocument, MemoryDocument, MessageDocument } from './interface_types';

const redisClient = RedisClient.getInstance();

class AIService {
    private openai: OpenAI;
    private dbCharacters: DBHandler<CharacterDocument>;
    private dbMemories: DBHandler<MemoryDocument>;
    private dbMessages: DBHandler<MessageDocument>;

    constructor() {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            throw new Error("OPENAI_API_KEY environment variable is missing.");
        }

        this.openai = new OpenAI({ apiKey });
        this.dbCharacters = new DBHandler<CharacterDocument>("characters");
        this.dbMemories = new DBHandler<MemoryDocument>("memories");
        this.dbMessages = new DBHandler<MessageDocument>("messages");
    }

    /**
     * Generates an AI reply based on the character's soul, memories, and chat history.
     */
    public async generateReply(characterId: string, conversationId: string): Promise<string> {
        
        // 1. Fetch Character Soul (MetaData)
        const characterDoc = await this.dbCharacters.findOne({ characterId });
        if (!characterDoc) {
            throw new Error(`Character ${characterId} not found.`);
        }

        const { characterName, characterMetaData } = characterDoc;
        const { characterPersonality, characterBackstory, relationship } = characterMetaData;

        // 2. Fetch Character Memories
        // We fetch all memories for this character to inject into the system prompt.
        const memories = await this.dbMemories.find({ characterId });
        let memoriesText = "";
        
        if (memories.length > 0) {
            memoriesText = "Here are important memories you must remember regarding the user:\n";
            memories.forEach(mem => {
                memoriesText += `- [${mem.memoryTitle}]: ${mem.memoryContent}\n`;
            });
        }

        // 3. Construct the System Prompt
        const systemPrompt = `
You are playing the role of ${characterName}.
Your personality: ${characterPersonality || "Unknown"}
Your backstory: ${characterBackstory || "Unknown"}
Your relationship with the user: ${relationship || "Acquaintance"}

${memoriesText}

Instructions:
1. Respond completely in character. Never break character.
2. Adopt the tone, vocabulary, and mannerisms described in your personality.
3. Use the memories provided to reference past events if they naturally fit the conversation.
4. Keep responses concise and conversational unless the user asks for a long explanation.
`;

        // 4. Fetch Chat History (Try Redis cache first, then MongoDB)
        let messageHistoryDocs: any[] | null = await redisClient.getConversationCache(conversationId);
        
        if (messageHistoryDocs) {
            // Redis array has newest first, we just want the latest 20
            messageHistoryDocs = messageHistoryDocs.slice(0, 20);
        } else {
            // Fallback to MongoDB
            messageHistoryDocs = await this.dbMessages.find(
                { conversationId }, 
                { sort: { timestamp: -1 }, limit: 20 }
            );
        }

        // Reverse the array because OpenAI needs chronological order (oldest to newest)
        messageHistoryDocs.reverse();

        // 5. Build OpenAI Message Array
        // Map our MessageDocuments to OpenAI's ChatCompletionMessageParam format
        const openAIMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
            { role: "system", content: systemPrompt }
        ];

        messageHistoryDocs.forEach(msg => {
            openAIMessages.push({
                role: msg.sender === "ai" ? "assistant" : "user",
                content: msg.messageContent
            });
        });

        // 6. Call OpenAI API
        try {
            const completion = await this.openai.chat.completions.create({
                model: "gpt-4o-mini", // Or gpt-4o depending on preference/cost
                messages: openAIMessages,
                temperature: 0.7, // Slightly creative but consistent personality
                max_tokens: 300,  // Keep chat bubbles reasonable
            });

            return completion.choices[0].message.content || "I don't know what to say.";

        } catch (error) {
            console.error("OpenAI API Error:", error);
            return "*The character seems lost in thought and cannot communicate right now.*";
        }
    }
}

export default new AIService();
