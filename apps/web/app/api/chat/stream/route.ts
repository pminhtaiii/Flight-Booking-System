import { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

const OPAQUE_CHAT_ID_PATTERN = /^chat_[a-f0-9]{32}$/;

function isOpaqueChatId(value: string | null): value is string {
  return value !== null && value.length === 37 && OPAQUE_CHAT_ID_PATTERN.test(value);
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  
  if (!session || !(session as { accessToken?: string }).accessToken) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  
  const accessToken = (session as { accessToken?: string }).accessToken;
  const agentUrl = process.env.AGENT_SERVICE_URL || 'http://127.0.0.1:3002';
  
  try {
    const body = await req.json();
    const upstreamHeaders: Record<string, string> = {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
    const traceId = req.headers.get('X-Trace-Id');
    const correlationId = req.headers.get('X-Correlation-Id');

    if (isOpaqueChatId(traceId)) {
      upstreamHeaders['X-Trace-Id'] = traceId;
    }
    if (isOpaqueChatId(correlationId)) {
      upstreamHeaders['X-Correlation-Id'] = correlationId;
    }

    const response = await fetch(`${agentUrl}/chat/stream`, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      return new Response(JSON.stringify({ error: 'Upstream error' }), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Return the response body directly to stream SSE
    return new Response(response.body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
