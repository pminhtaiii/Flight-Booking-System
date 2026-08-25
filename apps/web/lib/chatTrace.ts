const OPAQUE_CHAT_ID_PATTERN = /^chat_[a-f0-9]{32}$/;

export function createOpaqueChatId(): string {
  return `chat_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function isOpaqueChatId(value: string | null | undefined): value is string {
  return typeof value === 'string' && OPAQUE_CHAT_ID_PATTERN.test(value);
}
