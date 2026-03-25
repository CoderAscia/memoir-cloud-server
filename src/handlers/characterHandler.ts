import { v4 as uuidv4 } from 'uuid';
import { Context } from "../types";
import { CharacterDocument, UserDocument } from "../interface_types";

export async function handleCharacter(context: Context, parsedMessage: any, userData: UserDocument) {
  const { socket, userId, db, redisClient, updateSyncTimestamp, TTL } = context;

  if (parsedMessage.type === "getCharacterDetails") {
    const { characterId } = parsedMessage;
    const conversations = await db.conversations.find({ characterId }, { sort: { lastModified: -1 } });
    const memories = await db.memories.find({ characterId }, { sort: { lastModified: -1 } });
    socket.send(JSON.stringify({ type: "characterDetailsResponse", characterId, data: { conversations, memories } }));

  } else if (parsedMessage.type === "createCharacter") {
    const name = parsedMessage.characterName?.trim();

    if (!name) {
      socket.send(JSON.stringify({ type: "createCharacterResponse", status: "error", message: "Character name is required" }));
      return;
    }

    if (await db.characters.findOne({ uid: userId, characterName: name })) {
      socket.send(JSON.stringify({ type: "createCharacterResponse", status: "error", message: "Character exists" }));
      await updateSyncTimestamp(userId);
      return;
    }

    const newChar: CharacterDocument = {
      characterId: uuidv4(),
      lastModified: Date.now().toString(),
      uid: userId,
      characterName: name,
      characterImagePath: parsedMessage.characterImagePath,
      characterMetaData: parsedMessage.characterMetaData
    };

    await db.characters.create(newChar as any);
    if (userData?.list_characters) {
      userData.list_characters.push(newChar.characterId);
      await redisClient.setSession(userId, userData, TTL);
    }
    await updateSyncTimestamp(userId);
    socket.send(JSON.stringify({ type: "createCharacterResponse", status: "success", data: newChar }));

  } else if (parsedMessage.type === "updateCharacter") {
    const { characterId, ...updateData } = parsedMessage;
    await db.characters.update({ characterId, uid: userId }, { $set: updateData });
    if (userData?.list_characters) {
      const idx = userData.list_characters.findIndex((c: any) => c.characterId === characterId);
      if (idx !== -1) {
        userData.list_characters[idx] = characterId;
        await redisClient.setSession(userId, userData, TTL);
      }
    }
    await updateSyncTimestamp(userId);
    socket.send(JSON.stringify({ type: "updateCharacterResponse", status: "success", characterId }));

  } else if (parsedMessage.type === "deleteCharacter") {
    const { characterId } = parsedMessage;
    await db.characters.delete({ characterId, uid: userId });
    if (userData?.list_characters) {
      userData.list_characters = userData.list_characters.filter((c: any) => c.characterId !== characterId);
      await redisClient.setSession(userId, userData, TTL);
    }
    await updateSyncTimestamp(userId);
    socket.send(JSON.stringify({ type: "deleteCharacterResponse", status: "success", characterId }));
  }
}
