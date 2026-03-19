
interface UserDocument {
    uid: string;
    timestampVersion: string;
}

interface CharacterDocument {
    uid: string;
    lastModified: string;
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
    lastModified: string;
}

interface ConversationDocument {
    uid: string;
    conversationId: string;
    characterId: string;
    conversationTitle: string;
    lastModified: string;
}

interface MessageDocument {
    messageId: string;
    uid: string;
    conversationId: string;
    messageTitle: string;
    messageContent: string;
    lastModified: string;
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
