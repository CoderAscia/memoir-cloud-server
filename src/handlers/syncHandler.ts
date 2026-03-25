import { Context, DeltaData } from "../types";
import { UserDocument } from "../interface_types";

export async function handleSync(context: Context, parsedMessage: any) {
  const { socket, userId, redisClient, db } = context;
  const TTL = context.TTL;
  // Get the last sync timestamp from the client
  const currentTimeStampVersion = parsedMessage['lastSyncVersion'];
  let user_timestampVersion: string;

  // Check if the user data is already in the cache
  const cachedUserData: UserDocument | null = await redisClient.getSession(userId);
  if (cachedUserData) {
    user_timestampVersion = cachedUserData.lastSync;
  } else {
    // Cache miss (expired/evicted) — fall back to the DB value
    const userDoc = await db.users.findOne({ userId: userId });

    if (userDoc === null) {
      console.error(`User not found: ${userId}`);
      return;
    }
    user_timestampVersion = userDoc.lastSync;

    await redisClient.safeSetSession(userId, userDoc, TTL);
  }

  if (currentTimeStampVersion === '0.0.0') {
    const deltaCharacters = await db.characters.find({ uid: userId }, { projection: { _id: 0, type: 0 } });
    const deltaConversations = await db.conversations.find({ uid: userId }, { projection: { _id: 0, type: 0 } });
    const deltaMessages = await db.messages.find({ uid: userId }, { projection: { _id: 0, type: 0 } });
    const deltaMemories = await db.memories.find({ uid: userId }, { projection: { _id: 0, type: 0 } });

    const deltaData: DeltaData = {
      deltaCharacters,
      deltaConversations,
      deltaMessages,
      deltaMemories,
      deltaVersion: user_timestampVersion
    };

    socket.send(JSON.stringify({ "type": "syncResponse", "isLatest": false, "uid": userId, "delta_updates": deltaData, "timestampVersion": user_timestampVersion }));
    console.log("Sent full user data");
  } else if (currentTimeStampVersion < user_timestampVersion) {
    const deltaCharacters = await db.characters.find({ uid: userId, lastModified: { $gt: currentTimeStampVersion } }, { projection: { _id: 0, type: 0 } }) ?? [];
    const deltaConversations = await db.conversations.find({ uid: userId, lastModified: { $gt: currentTimeStampVersion } }, { projection: { _id: 0, type: 0 } }) ?? [];
    const deltaMessages = await db.messages.find({ uid: userId, lastModified: { $gt: currentTimeStampVersion } }, { projection: { _id: 0, type: 0 } }) ?? [];
    const deltaMemories = await db.memories.find({ uid: userId, lastModified: { $gt: currentTimeStampVersion } }, { projection: { _id: 0, type: 0 } }) ?? [];

    const deltaData: DeltaData = {
      deltaCharacters,
      deltaConversations,
      deltaMessages,
      deltaMemories,
      deltaVersion: user_timestampVersion
    };

    socket.send(JSON.stringify({ "type": "syncResponse", "isLatest": false, "uid": userId, "delta_updates": deltaData }));
  } else if (currentTimeStampVersion === user_timestampVersion) {
    socket.send(JSON.stringify({ "type": "syncResponse", "isLatest": true, "uid": userId, "delta_updates": null, "timestampVersion": user_timestampVersion }));
    console.log("Sent latest user data");
  }
}
