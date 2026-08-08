'use client';

import React, { Suspense, useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { BookingActionCard, parseActionRequiredEvent, type SafeActionRequiredEvent } from './BookingActionCard';
import { CheckoutHandoffCard } from './CheckoutHandoffCard';
import { createChatStreamRequest } from '@/lib/chatStream';
import { actionHandoffSchema, type HandoffEvent } from '@shared/types/chat.types';

const OFFER_ID_PATTERN = /^off_[A-Za-z0-9_-]{1,128}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function getSafeOfferId(candidate: string | null): string | null {
  return candidate && OFFER_ID_PATTERN.test(candidate) ? candidate : null;
}

function getSafeSessionId(candidate: string | null): string | null {
  return candidate && SESSION_ID_PATTERN.test(candidate) ? candidate : null;
}

function consumeSseBlock(
  block: string,
  onActionRequired: (payload: unknown) => void,
  onDone?: (sessionId: string) => void,
  onHandoff?: (payload: unknown) => void,
): void {
  const lines = block.split(/\r?\n/);
  const eventName = lines.find((line) => line.startsWith('event:'))?.slice('event:'.length).trim();
  const data = lines.find((line) => line.startsWith('data:'))?.slice('data:'.length).trim();

  if (eventName === 'ACTION_REQUIRED' && data) {
    try {
      onActionRequired(JSON.parse(data));
    } catch {
      // A malformed event is deliberately discarded without logging its content.
    }
  } else if (eventName === 'ACTION_HANDOFF' && data && onHandoff) {
    try {
      onHandoff(JSON.parse(data));
    } catch {
      // Discard malformed event
    }
  } else if (eventName === 'done' && data) {
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed.sessionId === 'string') {
        const safeSessionId = getSafeSessionId(parsed.sessionId);
        if (safeSessionId && onDone) {
          onDone(safeSessionId);
        }
      }
    } catch {
      // Discard malformed event
    }
  }
}

async function consumeChatStream(
  message: string,
  sessionId: string,
  signal: AbortSignal,
  onActionRequired: (payload: unknown) => void,
  onDone?: (sessionId: string) => void,
  onHandoff?: (payload: unknown) => void,
): Promise<void> {
  try {
    const response = await createChatStreamRequest({
      message,
      sessionId,
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
      blocks.forEach((block) => consumeSseBlock(block, onActionRequired, onDone, onHandoff));

      if (done) {
        if (buffer) {
          consumeSseBlock(buffer, onActionRequired, onDone, onHandoff);
        }
        return;
      }
    }
  } catch {
    // Stream failures remain generic because the stream can contain sensitive conversational context.
    return;
  }
}

function ChatWidgetInner(): JSX.Element {
  const [actionEvent, setActionEvent] = useState<SafeActionRequiredEvent | null>(null);
  const [handoffEvent, setHandoffEvent] = useState<HandoffEvent | null>(null);
  const [inputMessage, setInputMessage] = useState('');
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const offerId = getSafeOfferId(searchParams.get('offerId'));
  const sessionIdFromUrl = getSafeSessionId(searchParams.get('sessionId'));
  const autoResume = searchParams.get('autoResume') === 'true';

  const [activeSessionId, setActiveSessionId] = useState<string | null>(sessionIdFromUrl);

  useEffect(() => {
    if (sessionIdFromUrl) {
      setActiveSessionId(sessionIdFromUrl);
    }
  }, [sessionIdFromUrl]);

  const acceptActionRequiredEvent = useCallback((payload: unknown): void => {
    const safeEvent = parseActionRequiredEvent(payload);
    if (safeEvent) {
      setActionEvent(safeEvent);
      setHandoffEvent(null);
    }
  }, []);

  const acceptHandoffEvent = useCallback((payload: unknown): void => {
    const result = actionHandoffSchema.safeParse(payload);
    if (result.success) {
      setHandoffEvent(result.data);
      setActionEvent(null);
    }
  }, []);

  const handleDone = useCallback((doneSessionId: string): void => {
    setActiveSessionId(doneSessionId);
  }, []);

  // Auto-resume hook
  useEffect(() => {
    if (autoResume && activeSessionId) {
      const controller = new AbortController();
      void consumeChatStream('resume', activeSessionId, controller.signal, acceptActionRequiredEvent, handleDone, acceptHandoffEvent);
      return () => controller.abort();
    }
  }, [autoResume, activeSessionId, acceptActionRequiredEvent, handleDone, acceptHandoffEvent]);

  const handleNavigate = (target: SafeActionRequiredEvent['target']): void => {
    const params = new URLSearchParams();
    const targetOfferId = actionEvent?.offerId || offerId;
    if (targetOfferId) params.set('offerId', targetOfferId);
    if (activeSessionId) params.set('sessionId', activeSessionId);
    params.set('autoResume', 'true');
    
    const qs = params.toString();
    const returnTo = `${pathname ?? '/'}${qs ? `?${qs}` : ''}`;

    if (target === '/checkout/passengers') {
      if (!targetOfferId) {
        return;
      }
      router.push(`/checkout/passengers?offerId=${encodeURIComponent(targetOfferId)}&returnTo=${encodeURIComponent(returnTo)}`);
      return;
    }

    router.push(`/profile?returnTo=${encodeURIComponent(returnTo)}`);
  };

  const handleSend = () => {
    if (!inputMessage.trim()) return;
    const controller = new AbortController();
    void consumeChatStream(inputMessage, activeSessionId ?? '', controller.signal, acceptActionRequiredEvent, handleDone, acceptHandoffEvent);
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
        {handoffEvent ? <CheckoutHandoffCard event={handoffEvent} /> : null}
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

export function ChatWidget(): JSX.Element {
  return (
    <Suspense fallback={null}>
      <ChatWidgetInner />
    </Suspense>
  );
}
