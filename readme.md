# Memoir WebSocket Server API Documentation

The WebSocket server operates on `ws://localhost:3030`. 
All incoming messages must be strictly formatted as JSON.

## 1. Authentication & Connecting
To establish a connection, you **must** pass a valid Firebase ID Token in the connection URL.
```
ws://localhost:3030?authToken=YOUR_FIREBASE_ID_TOKEN
```
*(For testing environments without Firebase, you can pass `?authToken=test_token` to bypass authentication).*

---

## 2. Global State & User Data

### `getLatestUserData`
Gets the basic user account info and a simple array of their characters. This hits the Redis cache first for lightning-fast loads.
```json
{
  "type": "getLatestUserData"
}
```

---

## 3. Character Management
Gets the basic user account info and a simple list of their characters (without full chat histories).
```json
{
  "type": "getLatestUserData"
}
```

### `createCharacter`
Registers a new character to the user's account. Name duplicates are automatically blocked.
```json
{
  "type": "createCharacter",
  "characterName": "Eldrin",
  "characterImagePath": "https://example.com/eldrin.png",
  "characterMetaData": {
    "characterStickers": [],
    "chatBackgroundImage": "",
    "relationship": "Friend",
    "characterPersonality": "Helpful and wise",
    "characterBackstory": "An old wizard from the mountains."
  }
}
```

### `updateCharacter`
Updates an existing character's details. Only include the fields you want to change.
```json
{
  "type": "updateCharacter",
  "characterId": "the-character-uuid-string",
  "characterName": "Eldrin The Wise", 
  "characterImagePath": "https://example.com/new-eldrin.png",
  "characterMetaData": {
    "characterStickers": [],
    "chatBackgroundImage": "",
    "relationship": "Mentor",
    "characterPersonality": "Helpful and very wise",
    "characterBackstory": "An old wizard from the high mountains."
  }
}
```

### `deleteCharacter`
Permanently deletes a character from the database and removes them from your `getLatestUserData` list.
```json
{
  "type": "deleteCharacter",
  "characterId": "the-character-uuid-string"
}
```

---

## 4. Conversation & Chat

### `getCharacterDetails`
Gets the list of conversation threads and memory nodes for a specific character. Needed to find the `conversationId` before loading messages.
```json
{
  "type": "getCharacterDetails",
  "characterId": "the-character-uuid-string"
}
```

### `createConversation`
Starts a new chat thread for a character.
```json
{
  "type": "createConversation",
  "characterId": "the-character-uuid-string",
  "conversationTitle": "Chapter 1: The Meeting"
}
```

### `getMessages`
Downloads an array of chat bubbles for a specific conversation. 
**Note:** The initial load is fetched from and heavily cached in Redis.
**Note:** AI generation context relies on this endpoint pulling from the Redis array.
```json
{
  "type": "getMessages",
  "conversationId": "the-conversation-uuid-string",
  "limit": 20, 
  "lastMessageTimestamp": 1710576192000 
}
```
```
*(Note: `limit` and `lastMessageTimestamp` are optional. If you just send `conversationId`, it will return the cached 20 most recent messages).*

### `chat`
Sends a message to the AI.
1. Saves to MongoDB and instantly pushes to Redis Cache.
2. Formulates a system prompt using the Character's Personality and Memories.
3. Pulls short-term Chat History from Redis.
4. Calls OpenAI `gpt-4o-mini`.
5. Pushes AI response to Database, Redis, and sends back to Client.

```json
{
  "type": "chat",
  "conversationId": "the-conversation-uuid-string",
  "message": "Hello Eldrin, how are you today?"
}
```

---

## 5. Memory Management

### `createMemory`
Saves a new memory node for a character. The AI injects these memories directly into its prompt.
```json
{
  "type": "createMemory",
  "characterId": "the-character-uuid-string",
  "memoryTitle": "The Secret Password",
  "memoryContent": "Eldrin told me the password to the gate is 'Open Sesame'.",
  "memorySplashArts": ["https://example.com/gate.png"]
}
```

### `updateMemory`
Updates an existing character memory. Only include the fields you want to change.
```json
{
  "type": "updateMemory",
  "memoryId": "the-memory-uuid-string",
  "characterId": "the-character-uuid-string",
  "memoryTitle": "The Secret Password (Updated)",
  "memoryContent": "Eldrin told me the password to the gate is actually 'Close Sesame'.",
  "memorySplashArts": ["https://example.com/gate.png", "https://example.com/scroll.png"]
}
```

### `deleteMemory`
Permanently deletes a memory node for a character.
```json
{
  "type": "deleteMemory",
  "memoryId": "the-memory-uuid-string",
  "characterId": "the-character-uuid-string"
}
```