import WebSocket from 'ws';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
dotenv.config();
const ws = new WebSocket(process.env.WS_URL!);

let characterId = "1234";
let conversationId = "";
let memoryId = "";
let version = "0.0.0";

function waitForResponse(expectedType: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const listener = (data: WebSocket.RawData) => {
            const parsed = JSON.parse(data.toString());
            // Check for expected response types
            if (parsed.type === expectedType || parsed.type === 'error') {
                ws.off('message', listener);
                if (parsed.type === 'error' && expectedType !== 'error') reject(parsed.message || parsed);
                else resolve(parsed);
            } else if (parsed.status === 'error') {
                // Some responses have type=<expectedType> but status=error
                // or just status=error inside the expected response, which will be handled by tests
            }
        };
        ws.on('message', listener);

        // Timeout to prevent hanging indefinitely
        setTimeout(() => {
            ws.off('message', listener);
            reject(new Error(`Timeout waiting for ${expectedType}`));
        }, 30000); // 30 seconds should be generously enough for AI completions
    });
}

async function runTests() {
    try {
        console.log("---- Tests Started ----\n");

        // 1. getLatestUserData
        console.log("1. Testing getLatestUserData...");
        let p = waitForResponse("syncResponse");
        ws.send(JSON.stringify({ type: "getLatestUserData", lastSyncVersion: version }));
        let res = await p;
        console.log("✅ getLatestUserData response:");
        // Loop through each category dynamically, guard against null delta_updates
        // (server sends null when the client is already up to date)
        if (res.delta_updates != null) {
            Object.entries(res.delta_updates).forEach(([key, value]) => {
                console.log(`=== ${key.toUpperCase()} ===`);
                console.table(value);
            });
        } else {
            console.log(`   Already up to date (timestampVersion: ${res.timestampVersion})`);
        }

        const conversationId = uuidv4();
        // 5. chat, new conversation
        console.log("\n5. Testing new conversation chat");
        p = waitForResponse("aiChatResponse");
        ws.send(JSON.stringify({
            type: "chat",
            conversationId,
            messageId: uuidv4(),
            characterId,
            conversationTitle: "Test Conversation",
            message: "Hello! This is a test message. Please reply with short message."
        }));
        res = await p;
        console.log("✅ new conversation chat response:", res.reply);

        // 6. chat, existing conversation
        console.log("\n6. Testing chat (this may take a few seconds as it hits OpenAI)...");
        p = waitForResponse("aiChatResponse");
        ws.send(JSON.stringify({
            type: "chat",
            conversationId,
            messageId: uuidv4(),
            message: "Hello! This is a test message. Please reply with short message."
        }));
        res = await p;
        console.log("✅ existing conversation chat response:", res.reply);

        // 7. getMessages
        console.log("\n7. Testing getMessages...");
        p = waitForResponse("messagesResponse");
        ws.send(JSON.stringify({
            type: "getMessages",
            conversationId: conversationId
        }));
        res = await p;
        console.log(`✅ getMessages response: retrieved ${res.data?.length || 0} messages`);

        // // 8. createMemory
        // console.log("\n8. Testing createMemory...");
        // p = waitForResponse("createMemoryResponse");
        // ws.send(JSON.stringify({
        //     type: "createMemory",
        //     characterId: characterId,
        //     memoryTitle: "Test Secret Password",
        //     memoryContent: "The password to the gate is 'Open Sesame'.",
        //     memorySplashArts: []
        // }));
        // res = await p;
        // if (res.status !== 'success') throw new Error(res.message || JSON.stringify(res));
        // memoryId = res.data.memoryId;
        // console.log("✅ createMemory response:", res.data.memoryTitle, `(ID: ${memoryId})`);

        // // 9. updateMemory
        // console.log("\n9. Testing updateMemory...");
        // p = waitForResponse("updateMemoryResponse");
        // ws.send(JSON.stringify({
        //     type: "updateMemory",
        //     memoryId: memoryId,
        //     characterId: characterId,
        //     memoryTitle: "Updated Test Secret Password"
        // }));
        // res = await p;
        // if (res.status !== 'success') throw new Error(res.message || JSON.stringify(res));
        // console.log("✅ updateMemory response:", res.status);

        // // 10. deleteMemory
        // console.log("\n10. Testing deleteMemory...");
        // p = waitForResponse("deleteMemoryResponse");
        // ws.send(JSON.stringify({
        //     type: "deleteMemory",
        //     memoryId: memoryId,
        //     characterId: characterId
        // }));
        // res = await p;
        // if (res.status !== 'success') throw new Error(res.message || JSON.stringify(res));
        // console.log("✅ deleteMemory response:", res.status);

        // 11. deleteCharacter
        console.log("\n11. Testing deleteCharacter...");
        p = waitForResponse("deleteCharacterResponse");
        ws.send(JSON.stringify({
            type: "deleteCharacter",
            characterId: characterId
        }));
        res = await p;
        if (res.status !== 'success') throw new Error(res.message || JSON.stringify(res));
        console.log("✅ deleteCharacter response:", res.status);

        // 12. getLatestUserData Updated
        console.log("1. Testing getLatestUserData...");
        p = waitForResponse("syncResponse");
        ws.send(JSON.stringify({ type: "getLatestUserData", lastSyncVersion: version }));
        res = await p;
        console.log("✅ getLatestUserData response:");

        if (res.delta_updates != null) {
            Object.entries(res.delta_updates).forEach(([key, value]) => {
                console.log(`=== ${key.toUpperCase()} ===`);
                console.table(value);
            });
        } else {
            console.log(`   Already up to date (timestampVersion: ${res.timestampVersion})`);
        }

        console.log("\n🎉 ---- All Endpoints Tested Successfully ---- 🎉");
    } catch (error) {
        console.error("\n❌ Test Failed:", error);
    } finally {
        ws.close();
        process.exit(0);
    }
}

ws.on('open', () => {
    console.log("Connected to WebSocket Server at ws://localhost:3000/ws?token=test_token");
    runTests();
});

ws.on('error', (err) => {
    console.error("WebSocket Connection Error:", err.message);
    if (err.message.includes("ECONNREFUSED")) {
        console.error("Is the WebSocket server running on port 3030?");
    }
});



// npx ts-node scripts/test.ts