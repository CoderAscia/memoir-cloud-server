
interface UserDocument {
    uid: string;
    timestampVersion: string;
}

interface CharacterDocument {
    uid: string;
    characterId: string;
    characterName: string;
    characterImagePath: string;
    characterMetaData: CharacterMetaData;
}

interface CharacterMetaData {
    characterStickers: string[];
    chatBackgroundImage: string;
    relationship: string;
    characterPersonality: string;
    characterBackstory: string;
}

interface MemoryDocument {
    uid: string;
    memoryId: string;
    characterId: string;
    memoryTitle: string;
    memoryContent: string;
    memorySplashArts: string[];
    timestamp: number;
}

interface ConversationDocument {
    uid: string;
    conversationId: string;
    characterId: string;
    conversationTitle: string;
    timestamp: number;
}

interface MessageDocument {
    messageId: string;
    uid: string;
    conversationId: string;
    messageTitle: string;
    messageContent: string;
    timestamp: number;
    sender: "user" | "ai";
}

export {
    UserDocument,
    CharacterDocument,
    CharacterMetaData,
    MemoryDocument,
    ConversationDocument,
    MessageDocument
}
