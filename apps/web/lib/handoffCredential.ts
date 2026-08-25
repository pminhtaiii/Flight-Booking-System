const VERSIONED_HANDOFF_TOKEN = /^chk_handoff_v1_[A-Za-z0-9_-]{43}$/;

function isValidHandoffCredential(value: string): boolean {
  return VERSIONED_HANDOFF_TOKEN.test(value);
}

export async function readHandoffCredential(request: Request): Promise<string | null> {
  try {
    const contentType = request.headers.get('content-type') ?? '';
    if (
      !contentType.includes('application/x-www-form-urlencoded') &&
      !contentType.includes('multipart/form-data')
    ) {
      return null;
    }

    if (contentType.includes('application/x-www-form-urlencoded')) {
      const text = await request.clone().text();
      const params = new URLSearchParams(text);
      const entries = Array.from(params.entries());
      if (entries.length === 1 && entries[0][0] === 'handoffToken') {
        const handoffToken = entries[0][1];
        return isValidHandoffCredential(handoffToken) ? handoffToken : null;
      }
      return null;
    }

    const formEntries = Array.from((await request.clone().formData()).entries());
    if (formEntries.length !== 1 || formEntries[0][0] !== 'handoffToken') {
      return null;
    }
    const val = formEntries[0][1];
    return typeof val === 'string' && isValidHandoffCredential(val) ? val : null;
  } catch {
    return null;
  }
}
