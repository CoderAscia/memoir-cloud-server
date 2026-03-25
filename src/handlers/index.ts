import { Context } from "../types";
import { handleSync } from "./syncHandler";
import { handleCharacter } from "./characterHandler";
import { handleMessage } from "./messageHandler";
import { handleMemory } from "./memoryHandler";
import { UserDocument } from "../interface_types";

export async function routeMessage(context: Context, parsedMessage: any, userData: UserDocument) {
  const { type } = parsedMessage;

  if (type === "getLatestUserData") {
    await handleSync(context, parsedMessage);
  } else if (["getCharacterDetails", "createCharacter", "updateCharacter", "deleteCharacter"].includes(type)) {
    await handleCharacter(context, parsedMessage, userData);
  } else if (["getMessages", "createConversation", "chat"].includes(type)) {
    await handleMessage(context, parsedMessage);
  } else if (["createMemory", "updateMemory", "deleteMemory"].includes(type)) {
    await handleMemory(context, parsedMessage, userData);
  } else {
    console.warn(`Unknown message type: ${type}`);
  }
}
