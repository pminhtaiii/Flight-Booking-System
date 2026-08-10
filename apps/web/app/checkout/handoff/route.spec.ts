import { POST } from './route';

jest.mock('next-auth', () => ({
  getServerSession: jest.fn().mockResolvedValue({
    accessToken: 'session-access-token',
  }),
}));

jest.mock('@/lib/auth', () => ({ authOptions: {} }), { virtual: true });

const getServerSessionMock = jest.requireMock('next-auth').getServerSession as jest.Mock;

function makeRequest(
  handoffToken: unknown,
  headers?: Record<string, string>,
  extraFields: Record<string, string> = {},
): Request {
  const body = new FormData();
  if (handoffToken !== undefined) {
    body.append('handoffToken', handoffToken as string);
  }
  for (const [key, value] of Object.entries(extraFields)) {
    body.append(key, value);
  }

  return new Request('http://127.0.0.1:3000/checkout/handoff', {
    method: 'POST',
    headers: headers ?? {
      host: '127.0.0.1:3000',
      origin: 'http://127.0.0.1:3000',
    },
    body,
  });
}

describe('POST /checkout/handoff', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue({ accessToken: 'session-access-token' });
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it('requires an authenticated NextAuth checkout session', async () => {
    getServerSessionMock.mockResolvedValueOnce(null);

    const response = await POST(makeRequest('a'.repeat(43)));

    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('rejects malformed credentials without logging or setting a cookie', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await POST(makeRequest('test_token'));

    expect(response.status).toBe(400);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('requires exactly one handoffToken form field', async () => {
    const missing = await POST(makeRequest(undefined));
    expect(missing.status).toBe(400);

    const extra = await POST(makeRequest('a'.repeat(43), undefined, { csrf: 'unexpected' }));
    expect(extra.status).toBe(400);
  });

  it('accepts the current generator format and sets a strict clean-redirect cookie', async () => {
    const response = await POST(makeRequest('a'.repeat(43)));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('http://127.0.0.1:3000/checkout/passengers');
    expect(response.headers.get('set-cookie')).toEqual(
      expect.stringMatching(
        /chat_handoff_token=[^;]+; Path=\/; Max-Age=900; HttpOnly; Secure; SameSite=Strict/,
      ),
    );
  });

  it('accepts the versioned contract shape without exposing it in the redirect', async () => {
    const response = await POST(makeRequest('chk_handoff_v1_opaque'));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).not.toContain('chk_handoff_v1_opaque');
  });

  it('rejects cross-origin origin and referer before reading the credential', async () => {
    const originResponse = await POST(
      makeRequest('a'.repeat(43), {
        host: '127.0.0.1:3000',
        origin: 'https://attacker.test',
      }),
    );
    expect(originResponse.status).toBe(403);
    expect(originResponse.headers.get('set-cookie')).toBeNull();

    const refererResponse = await POST(
      makeRequest('a'.repeat(43), {
        host: '127.0.0.1:3000',
        referer: 'https://attacker.test/checkout',
      }),
    );
    expect(refererResponse.status).toBe(403);
    expect(refererResponse.headers.get('set-cookie')).toBeNull();

    const missingBoundaryHeaders = await POST(
      makeRequest('a'.repeat(43), { host: '127.0.0.1:3000' }),
    );
    expect(missingBoundaryHeaders.status).toBe(403);
    expect(missingBoundaryHeaders.headers.get('set-cookie')).toBeNull();
  });

  it.each([
    ['origin', 'https://127.0.0.1:3000'],
    ['origin', 'http://127.0.0.1:3001'],
    ['referer', 'https://127.0.0.1:3000/checkout'],
    ['referer', 'http://127.0.0.1:3001/checkout'],
  ])('rejects a same-host but non-identical %s scheme or port', async (header, value) => {
    const response = await POST(
      makeRequest('a'.repeat(43), {
        host: '127.0.0.1:3000',
        [header]: value,
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it.each([
    ['origin', 'not a URL'],
    ['referer', 'http://[::1'],
  ])('rejects malformed %s values without throwing', async (header, value) => {
    const response = await POST(
      makeRequest('a'.repeat(43), {
        host: '127.0.0.1:3000',
        [header]: value,
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});
