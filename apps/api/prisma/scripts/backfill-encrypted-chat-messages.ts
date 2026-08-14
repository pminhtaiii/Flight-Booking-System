import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';

const prisma = new PrismaClient();

export async function backfillChatMessages() {
  const ENCRYPTION_KEY = process.env.CHAT_ENCRYPTION_KEY;
  if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64) {
    throw new Error('CHAT_ENCRYPTION_KEY must be a 64-character hex string');
  }
  const KEY_BUFFER = Buffer.from(ENCRYPTION_KEY, 'hex');
  const KEY_VERSION = 1;
  const BATCH_SIZE = 1000;

  // Check if title column still exists in chat_sessions
  const sessionTitleCol: any[] = await prisma.$queryRaw`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'chat_sessions' AND column_name = 'title'
  `;

  if (sessionTitleCol.length > 0) {
    while (true) {
      const sessions: any[] = await prisma.$queryRaw`
        SELECT id, title FROM "chat_sessions"
        WHERE "titleCiphertext" IS NULL AND "title" IS NOT NULL
        ORDER BY id ASC
        LIMIT ${BATCH_SIZE}
      `;

      if (sessions.length === 0) break;

      for (const session of sessions) {
        if (!session.title) continue;
        const nonce = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', KEY_BUFFER, nonce);
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
          },
        });
      }
    }
  }

  // Check if content column still exists in chat_messages
  const msgContentCol: any[] = await prisma.$queryRaw`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'chat_messages' AND column_name = 'content'
  `;

  if (msgContentCol.length > 0) {
    while (true) {
      const messages: any[] = await prisma.$queryRaw`
        SELECT id, "sessionId", sender, type, content FROM "chat_messages"
        WHERE "contentCiphertext" IS NULL AND "content" IS NOT NULL
        ORDER BY id ASC
        LIMIT ${BATCH_SIZE}
      `;

      if (messages.length === 0) break;

      for (const message of messages) {
        if (!message.content) continue;
        const nonce = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', KEY_BUFFER, nonce);

        cipher.setAAD(
          Buffer.from(
            `ChatMessage:${message.id}:${message.sessionId}:${message.sender}:${message.type}:v${KEY_VERSION}`,
          ),
        );

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
          },
        });
      }
    }
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
