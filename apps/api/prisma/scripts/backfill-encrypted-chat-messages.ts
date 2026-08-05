import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';

const prisma = new PrismaClient();

const ENCRYPTION_KEY = process.env.CHAT_ENCRYPTION_KEY;
if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64) {
  throw new Error('CHAT_ENCRYPTION_KEY must be a 64-character hex string');
}
const KEY_BUFFER = Buffer.from(ENCRYPTION_KEY, 'hex');
const KEY_VERSION = 1;

export async function backfillChatMessages() {
  const sessions = await prisma.chatSession.findMany({
    where: { titleCiphertext: null, title: { not: null } }
  });

  for (const session of sessions) {
    if (!session.title) continue;
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', KEY_BUFFER, nonce);
    
    // AAD: bind to record
    cipher.setAAD(Buffer.from(`ChatSession:${session.id}:v${KEY_VERSION}`));
    
    let ciphertext = cipher.update(session.title, 'utf8', 'hex');
    ciphertext += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    await prisma.chatSession.update({
      where: { id: session.id },
      data: {
        titleCiphertext: ciphertext,
        titleNonce: nonce.toString('hex'),
        titleAuthTag: authTag,
        titleKeyVersion: KEY_VERSION,
      }
    });
  }

  const messages = await prisma.chatMessage.findMany({
    where: { contentCiphertext: null, content: { not: null } }
  });

  for (const message of messages) {
    if (!message.content) continue;
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', KEY_BUFFER, nonce);
    
    cipher.setAAD(Buffer.from(`ChatMessage:${message.id}:${message.sessionId}:${message.sender}:${message.type}:v${KEY_VERSION}`));
    
    let ciphertext = cipher.update(message.content, 'utf8', 'hex');
    ciphertext += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    await prisma.chatMessage.update({
      where: { id: message.id },
      data: {
        contentCiphertext: ciphertext,
        contentNonce: nonce.toString('hex'),
        contentAuthTag: authTag,
        contentKeyVersion: KEY_VERSION,
      }
    });
  }
}

if (require.main === module) {
  backfillChatMessages()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
