import * as admin from "firebase-admin";
import { getSecret } from "./secretManager";

export async function initFirebase() {
  const clientEmail = await getSecret("FIREBASE_CLIENT_EMAIL");
  const privateKey = (await getSecret("FIREBASE_PRIVATE_KEY")).replace(/\\n/g, '\n');
  const projectId = process.env.FIREBASE_PROJECT_ID;

  if (!projectId) {
    throw new Error("FIREBASE_PROJECT_ID is not defined");
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });

  console.log("Firebase Admin initialized");
  return admin;
}

export default admin;
