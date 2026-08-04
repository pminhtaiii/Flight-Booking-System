'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { BookingActionCard, parseActionRequiredEvent, type SafeActionRequiredEvent } from './BookingActionCard';

const OFFER_ID_PATTERN = /^off_[A-Za-z0-9_-]{1,128}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function getSafeOfferId(candidate: string | null): string | null {
  return candidate && OFFER_ID_PATTERN.test(candidate) ? candidate : null;
}

function getSafeSessionId(candidate: string | null): string | null {
  return candidate && SESSION_ID_PATTERN.test(candidate) ? candidate : null;
}

function consumeSseBlock(block: string, onActionRequired: (payload: unknown) => void): void {
  const lines = block.split(/\r?\n/);
  const eventName = lines.find((line) => line.startsWith('event:'))?.slice('event:'.length).trim();
  const data = lines.find((line) => line.startsWith('data:'))?.slice('data:'.length).trim();

  if (eventName !== 'ACTION_REQUIRED' || !data) {
    return;
  }

  try {
    onActionRequired(JSON.parse(data));
  } catch {
    // A malformed event is deliberately discarded without logging its content.
  }
}

async function consumeChatStream(
  message: string,
  sessionId: string,
  signal: AbortSignal,
  onActionRequired: (payload: unknown) => void,
): Promise<void> {
  try {
    const response = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message, sessionId }),
      signal,
    });

    if (!response.ok || !response.body) {
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (!signal.aborted) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? '';
      blocks.forEach((block) => consumeSseBlock(block, onActionRequired));

      if (done) {
        if (buffer) {
          consumeSseBlock(buffer, onActionRequired);
        }
        return;
      }
    }
  } catch {
    // Stream failures remain generic because the stream can contain sensitive conversational context.
    return;
  }
}

export function ChatWidget(): JSX.Element {
  const [actionEvent, setActionEvent] = useState<SafeActionRequiredEvent | null>(null);
  const [inputMessage, setInputMessage] = useState('');
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const offerId = getSafeOfferId(searchParams.get('offerId'));
  const sessionId = getSafeSessionId(searchParams.get('sessionId'));
  const autoResume = searchParams.get('autoResume') === 'true';
  const scenario = searchParams.get('scenario'); // For E2E tests

  const acceptActionRequiredEvent = useCallback((payload: unknown): void => {
    const safeEvent = parseActionRequiredEvent(payload);
    if (safeEvent) {
      setActionEvent(safeEvent);
    }
  }, []);

  // E2E test auto-trigger hook
  useEffect(() => {
    if (scenario) {
      const controller = new AbortController();
      void consumeChatStream(scenario, sessionId ?? 'test-session', controller.signal, acceptActionRequiredEvent);
      return () => controller.abort();
    }
  }, [scenario, sessionId, acceptActionRequiredEvent]);

  // Auto-resume hook
  useEffect(() => {
    if (autoResume && sessionId) {
      const controller = new AbortController();
      void consumeChatStream('resume', sessionId, controller.signal, acceptActionRequiredEvent);
      return () => controller.abort();
    }
  }, [autoResume, sessionId, acceptActionRequiredEvent]);

  const handleNavigate = (target: SafeActionRequiredEvent['target']): void => {
    const params = new URLSearchParams();
    if (offerId) params.set('offerId', offerId);
    if (sessionId) params.set('sessionId', sessionId);
    params.set('autoResume', 'true');
    
    const qs = params.toString();
    const returnTo = `${pathname ?? '/'}${qs ? `?${qs}` : ''}`;

    if (target === '/checkout/passengers') {
      if (!offerId) {
        return;
      }
      router.push(`/checkout/passengers?offerId=${encodeURIComponent(offerId)}`);
      return;
    }

    router.push(`/profile?returnTo=${encodeURIComponent(returnTo)}`);
  };

  const handleSend = () => {
    if (!inputMessage.trim()) return;
    const controller = new AbortController();
    void consumeChatStream(inputMessage, sessionId ?? 'default-session', controller.signal, acceptActionRequiredEvent);
    setInputMessage('');
  };

  return (
    <aside className="card fixed bottom-4 right-4 flex h-96 w-80 flex-col overflow-hidden shadow-xl z-50" aria-label="Agent chat">
      <div className="bg-accent p-3 font-medium text-primary-foreground">Agent Chat</div>
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-4">
        <p className="rounded border border-card-border bg-card p-2 text-sm text-text-primary">
          Hello! How can I help you book your flight today?
        </p>
        {actionEvent ? <BookingActionCard event={actionEvent} onNavigate={handleNavigate} /> : null}
      </div>
      <div className="border-t border-card-border bg-card p-3">
        <input 
          type="text" 
          placeholder="Type a message..." 
          className="form-input w-full text-sm"
          value={inputMessage}
          onChange={e => setInputMessage(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') handleSend();
          }}
        />
      </div>
    </aside>
  );
}
