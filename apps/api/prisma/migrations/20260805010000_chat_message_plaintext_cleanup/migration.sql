-- Phase 8E: Chat Plaintext Cleanup Migration
-- Drop legacy plaintext columns 'title' on chat_sessions and 'content' on chat_messages
-- only after confirming all existing rows possess complete AES-256-GCM ciphertext envelopes.

DO $$
DECLARE
  unmigrated_sessions INT;
  unmigrated_messages INT;
BEGIN
  -- Check if legacy title column still exists in chat_sessions
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_sessions' AND column_name = 'title'
  ) THEN
    SELECT COUNT(*) INTO unmigrated_sessions
    FROM "chat_sessions"
    WHERE "title" IS NOT NULL
      AND ("titleCiphertext" IS NULL OR "titleNonce" IS NULL OR "titleAuthTag" IS NULL OR "titleKeyVersion" IS NULL);

    IF unmigrated_sessions > 0 THEN
      RAISE EXCEPTION 'Preflight verification failed: % chat_sessions rows have title but incomplete ciphertext envelope', unmigrated_sessions;
    END IF;
  END IF;

  -- Check if legacy content column still exists in chat_messages
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_messages' AND column_name = 'content'
  ) THEN
    SELECT COUNT(*) INTO unmigrated_messages
    FROM "chat_messages"
    WHERE "content" IS NOT NULL
      AND ("contentCiphertext" IS NULL OR "contentNonce" IS NULL OR "contentAuthTag" IS NULL OR "contentKeyVersion" IS NULL);

    IF unmigrated_messages > 0 THEN
      RAISE EXCEPTION 'Preflight verification failed: % chat_messages rows have content but incomplete ciphertext envelope', unmigrated_messages;
    END IF;
  END IF;
END $$;

-- Drop legacy plaintext columns
ALTER TABLE "chat_sessions" DROP COLUMN IF EXISTS "title";
ALTER TABLE "chat_messages" DROP COLUMN IF EXISTS "content";
