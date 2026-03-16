Viewed persistentServer.ts:80-250

Here is the exact JSON payload the client (Flutter or Postman) needs to send for each WebSocket endpoint we created.

### 1. `getLatestUserData`
Gets the basic user account info and a simple list of their characters (without full chat histories).
```json
{
  "type": "getLatestUserData"
}
```

### 2. `getCharacterDetails`
Gets the list of conversation threads and memory nodes for a specific character.
```json
{
  "type": "getCharacterDetails",
  "characterId": "the-character-uuid-string"
}
```

### 3. `getMessages`
Downloads an array of chat bubbles for a specific conversation. Supports pagination.
```json
{
  "type": "getMessages",
  "conversationId": "the-conversation-uuid-string",
  "limit": 20, 
  "lastMessageTimestamp": 1710576192000 
}
```
*(Note: `limit` and `lastMessageTimestamp` are optional. If you just send `conversationId`, it will return the 20 most recent messages).*

### 4. `createCharacter`
Registers a new character to the user's account.
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

### 5. `createConversation`
Starts a new chat thread for a character.
```json
{
  "type": "createConversation",
  "characterId": "the-character-uuid-string",
  "conversationTitle": "Chapter 1: The Meeting"
}
```

### 6. `createMemory`
Saves a new memory node for a character.
```json
{
  "type": "createMemory",
  "characterId": "the-character-uuid-string",
  "memoryTitle": "The Secret Password",
  "memoryContent": "Eldrin told me the password to the gate is 'Open Sesame'.",
  "memorySplashArts": ["https://example.com/gate.png"]
}
```

### 7. `chat`
Sends a message to the AI, saves it to the database, and waits for the AI to generate and save a reply before pushing back the response.
```json
{
  "type": "chat",
  "conversationId": "the-conversation-uuid-string",
  "message": "Hello Eldrin, how are you today?"
}
```