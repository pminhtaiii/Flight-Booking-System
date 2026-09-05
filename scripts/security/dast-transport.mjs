import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

function scopedUrl(value) {
  try {
    const raw = String(value);
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(?:[/?#]|$)/.test(raw)) throw new Error();
    const url = new URL(raw);
    if (url.username || url.password || url.hash) throw new Error();
    return url;
  } catch {
    throw new Error('DAST destination refused');
  }
}

export function createTransport({ origins, maxRequests = 5000, minimumIntervalMs = 210, maxDurationMs = 1800000, signal, maxResponseBytes = 1048576, maxRequestBytes = 1048576 }) {
  const allowed = new Set(origins.map((origin) => scopedUrl(origin).origin));
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 5000 || !Number.isFinite(minimumIntervalMs) || minimumIntervalMs < 200) throw new Error('Invalid DAST budget');
  if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0 || maxDurationMs > 1800000) throw new Error('Invalid DAST budget');
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 1048576) throw new Error('Invalid DAST budget');
  if (!Number.isInteger(maxRequestBytes) || maxRequestBytes < 1 || maxRequestBytes > 1048576) throw new Error('Invalid DAST budget');
  const deadline = performance.now() + maxDurationMs;
  const controller = new AbortController();
  const expire = () => controller.abort(new Error('DAST time budget exhausted'));
  const timer = setTimeout(expire, maxDurationMs);
  timer.unref();
  const cancel = () => controller.abort(new Error('DAST transport closed'));
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  function check() {
    if (performance.now() >= deadline) expire();
    if (controller.signal.aborted) throw controller.signal.reason;
  }
  let requests = 0;
  let lastDispatch = -Infinity;
  let queue = Promise.resolve();
  return {
    get requests() { return requests; },
    get remainingMs() { return Math.max(0, deadline - performance.now()); },
    close() { clearTimeout(timer); signal?.removeEventListener('abort', cancel); cancel(); },
    async request(url, options = {}) {
      url = scopedUrl(url);
      if (!allowed.has(url.origin)) throw new Error('DAST destination refused');
      if (Object.keys(options).some((key) => !['method', 'headers', 'body'].includes(key))) throw new Error('DAST request options refused');
      const { method = 'GET', headers = {}, body: requestBody } = options;
      if (Object.keys(headers).some((key) => ['host', 'proxy-authorization', 'proxy-connection'].includes(key.toLowerCase()))) throw new Error('DAST request options refused');
      let requestBodyBytes = 0;
      if (requestBody !== undefined && requestBody !== null) {
        if (typeof requestBody === 'string') requestBodyBytes = Buffer.byteLength(requestBody);
        else if (Buffer.isBuffer(requestBody) || requestBody instanceof Uint8Array) requestBodyBytes = requestBody.byteLength;
        else throw new Error('DAST request body refused');
        if (requestBodyBytes > maxRequestBytes) throw new Error('DAST request body too large');
      }
      const slot = queue.then(async () => {
        check();
        if (requests >= maxRequests) throw new Error('DAST request budget exhausted');
        const wait = minimumIntervalMs - (performance.now() - lastDispatch);
        if (wait > 0) {
          try { await delay(wait, undefined, { signal: controller.signal }); }
          catch { check(); }
        }
        check();
        lastDispatch = performance.now();
        requests += 1;
      });
      queue = slot.catch(() => {});
      await slot;
      return new Promise((resolve, reject) => {
        const request = http.request(url, {
          method,
          headers,
          agent: false,
          family: 4,
          signal: controller.signal,
          lookup: (_hostname, _options, callback) => callback(null, '127.0.0.1', 4),
        }, (response) => {
          if (response.statusCode >= 300 && response.statusCode < 400) {
            response.destroy();
            reject(new Error('DAST redirect refused'));
            return;
          }
          const chunks = [];
          let bytes = 0;
          response.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > maxResponseBytes) {
              reject(new Error('DAST response too large'));
              response.destroy();
            } else chunks.push(chunk);
          });
          response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
          response.on('error', () => reject(controller.signal.reason ?? new Error('DAST response failed')));
        });
        request.on('error', () => reject(controller.signal.reason ?? new Error('DAST request failed')));
        request.end(requestBody);
      });
    },
  };
}
