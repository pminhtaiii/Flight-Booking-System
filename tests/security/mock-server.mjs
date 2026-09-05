import http from 'node:http';
import { pathToFileURL } from 'node:url';

const send = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

// This fixture has no proxy or outbound client. Unsupported provider operations fail closed.
export function createMockServer() {
  return http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      return send(response, 200, { status: 'ok', synthetic: true });
    }
    if (request.method === 'POST' && request.url === '/air/offer_requests') {
      return send(response, 201, { data: { id: 'orq_security_synthetic', offers: [] } });
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      return send(response, 501, { error: { code: 'security_stub_unsupported' } });
    }
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 1_048_576) return send(response, 413, { error: 'request_too_large' });
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const classifier = payload.messages?.some((message) =>
        message.role === 'system' && /SAFE.*UNSAFE|UNSAFE.*SAFE/s.test(message.content));
      const content = classifier ? 'SAFE' : 'Synthetic local security test response.';
      if (payload.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ id: 'security-stub', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`);
        response.end(`data: ${JSON.stringify({ id: 'security-stub', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      send(response, 200, { id: 'security-stub', object: 'chat.completion', model: 'security-stub', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    } catch {
      send(response, 400, { error: 'invalid_request' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createMockServer();
  server.listen(3400, '0.0.0.0');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
