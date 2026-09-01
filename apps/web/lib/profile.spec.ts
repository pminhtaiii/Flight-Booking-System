import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  fetchProfile,
  getTravelerProfile,
  ProfileRequestError,
  updateProfile,
  updateTravelerProfile,
} from './profile';
import type { TravelerProfileResponse, UpdateProfilePayload } from './profile';

function stubJsonResponse(
  body: unknown,
  status = 200,
  capture?: (input: RequestInfo | URL, init?: RequestInit) => void,
): typeof fetch {
  return async function jsonResponseStub(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    capture?.(input, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

describe('Profile Client Contract Tests', () => {
  const originalEnv = process.env;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.NEXT_PUBLIC_API_URL = 'http://127.0.0.1:3001';
  });

  afterEach(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  });

  describe('API URL Configuration', () => {
    it('throws when NEXT_PUBLIC_API_URL is undefined', async () => {
      delete process.env.NEXT_PUBLIC_API_URL;

      await assert.rejects(
        () => fetchProfile('sample-token'),
        /NEXT_PUBLIC_API_URL is required but not configured\./,
      );
    });

    it('throws when NEXT_PUBLIC_API_URL is empty or whitespace', async () => {
      process.env.NEXT_PUBLIC_API_URL = '   ';

      await assert.rejects(
        () => fetchProfile('sample-token'),
        /NEXT_PUBLIC_API_URL is required but not configured\./,
      );
    });

    it('trims single and multiple trailing slashes from NEXT_PUBLIC_API_URL', async () => {
      process.env.NEXT_PUBLIC_API_URL = 'https://api.wayfinder.internal///';

      let requestedUrl = '';
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        requestedUrl = String(input);
        return new Response(JSON.stringify({ profileId: 'prof-123', revision: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;

      const profile = await fetchProfile('sample-token');
      assert.strictEqual(requestedUrl, 'https://api.wayfinder.internal/api/profile');
      assert.strictEqual(profile.profileId, 'prof-123');
    });
  });

  describe('fetchProfile and getTravelerProfile Contract', () => {
    const mockProfileData: TravelerProfileResponse = {
      profileId: 'prof-999',
      identity: {
        givenName: 'Jane',
        middleName: 'Marie',
        familyName: 'Doe',
        dateOfBirth: '1990-05-15',
        gender: 'female',
        title: 'Ms',
      },
      contact: {
        email: 'jane.doe@example.com',
        phoneCountryCode: '+1',
        phoneNumber: '5550199',
      },
      travelDocument: {
        documentType: 'PASSPORT',
        passportNumber: 'A12345678',
        passportExpiry: '2030-01-01',
        issuingCountry: 'USA',
        nationality: 'USA',
      },
      preferences: {
        seatPreference: 'WINDOW',
        classPreference: 'BUSINESS',
      },
      revision: 3,
    };

    it('issues GET /api/profile with Authorization, Cache-Control, and cache: no-store', async () => {
      let capturedUrl = '';
      let capturedInit: RequestInit | undefined;

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedInit = init;
        return new Response(JSON.stringify(mockProfileData), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;

      const result = await fetchProfile('jwt-auth-token-123');

      assert.strictEqual(capturedUrl, 'http://127.0.0.1:3001/api/profile');
      assert.strictEqual(capturedInit?.method, 'GET');
      assert.strictEqual(capturedInit?.cache, 'no-store');

      const headers = capturedInit?.headers as Record<string, string>;
      assert.strictEqual(headers['Authorization'], 'Bearer jwt-auth-token-123');
      assert.strictEqual(headers['Cache-Control'], 'no-store, private');
      assert.deepStrictEqual(result, mockProfileData);
    });

    it('preserves every modern scoring preference returned by GET', async () => {
      const modernProfile: TravelerProfileResponse = {
        ...mockProfileData,
        preferences: {
          ...mockProfileData.preferences,
          preferredAirlines: ['VN', 'SQ'],
          blacklistedAirlines: ['XX'],
          preferredDepartureWindow: { start: 9, end: 12 },
          preferredArrivalWindow: { start: 22, end: 2 },
          maxStops: 0,
          priceSensitivity: 'MODERATE',
          requiresCheckedBaggage: false,
        },
        updatedAt: '2026-09-01T10:00:00.000Z',
      };

      globalThis.fetch = stubJsonResponse(modernProfile);

      assert.deepStrictEqual(await fetchProfile('sample-token'), modernProfile);
    });

    it('keeps a legacy profile unchanged when scoring preferences are absent', async () => {
      const legacyProfile: TravelerProfileResponse = {
        ...mockProfileData,
        updatedAt: '2026-08-31T23:59:59.000Z',
      };

      globalThis.fetch = stubJsonResponse(legacyProfile);

      assert.deepStrictEqual(await fetchProfile('sample-token'), legacyProfile);
    });

    it('keeps legacy profile sections when every scoring preference is explicitly null', async () => {
      const nullScoringProfile: TravelerProfileResponse = {
        ...mockProfileData,
        preferences: {
          ...mockProfileData.preferences,
          preferredAirlines: null,
          blacklistedAirlines: null,
          preferredDepartureWindow: null,
          preferredArrivalWindow: null,
          maxStops: null,
          priceSensitivity: null,
          requiresCheckedBaggage: null,
        },
        updatedAt: '2026-09-01T00:00:00.000Z',
      };

      globalThis.fetch = stubJsonResponse(nullScoringProfile);

      assert.deepStrictEqual(await fetchProfile('sample-token'), nullScoringProfile);
    });

    it('rejects a successful response without a profile object', async () => {
      globalThis.fetch = stubJsonResponse([]);

      await assert.rejects(
        () => fetchProfile('sample-token'),
        /Invalid traveler profile response\./,
      );
    });

    it('rejects an object response without a profile identifier', async () => {
      globalThis.fetch = stubJsonResponse({ revision: 1 });

      await assert.rejects(
        () => fetchProfile('sample-token'),
        /Invalid traveler profile response\./,
      );
    });

    it('getTravelerProfile alias behaves identically to fetchProfile', async () => {
      assert.strictEqual(getTravelerProfile, fetchProfile);

      let capturedUrl = '';
      let capturedInit: RequestInit | undefined;

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedInit = init;
        return new Response(JSON.stringify(mockProfileData), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;

      const result = await getTravelerProfile('jwt-auth-token-456');

      assert.strictEqual(capturedUrl, 'http://127.0.0.1:3001/api/profile');
      assert.strictEqual(capturedInit?.method, 'GET');
      const headers = capturedInit?.headers as Record<string, string>;
      assert.strictEqual(headers['Authorization'], 'Bearer jwt-auth-token-456');
      assert.strictEqual(headers['Cache-Control'], 'no-store, private');
      assert.deepStrictEqual(result, mockProfileData);
    });
  });

  describe('updateProfile and updateTravelerProfile Contract', () => {
    const updatePayload: UpdateProfilePayload = {
      expectedRevision: 3,
      identity: {
        givenName: 'Jane',
        middleName: 'M',
        familyName: 'Doe',
        dateOfBirth: '1990-05-15',
        gender: 'female',
        title: 'Dr',
      },
      contact: {
        email: 'dr.jane.doe@example.com',
        phoneCountryCode: '+1',
        phoneNumber: '5550199',
      },
      travelDocument: null,
      preferences: {
        seatPreference: 'AISLE',
        classPreference: 'FIRST',
      },
    };

    const updatedProfileResponse: TravelerProfileResponse = {
      profileId: 'prof-999',
      identity: updatePayload.identity ?? null,
      contact: updatePayload.contact ?? null,
      travelDocument: null,
      preferences: updatePayload.preferences ?? null,
      revision: 4,
      updatedAt: '2026-08-17T12:00:00.000Z',
    };

    it('issues PATCH /api/profile with expectedRevision body, Content-Type, Authorization, and Cache-Control', async () => {
      let capturedUrl = '';
      let capturedInit: RequestInit | undefined;

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedInit = init;
        return new Response(JSON.stringify(updatedProfileResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;

      const result = await updateProfile('jwt-auth-token-patch', updatePayload);

      assert.strictEqual(capturedUrl, 'http://127.0.0.1:3001/api/profile');
      assert.strictEqual(capturedInit?.method, 'PATCH');
      assert.strictEqual(capturedInit?.cache, 'no-store');

      const headers = capturedInit?.headers as Record<string, string>;
      assert.strictEqual(headers['Authorization'], 'Bearer jwt-auth-token-patch');
      assert.strictEqual(headers['Cache-Control'], 'no-store, private');
      assert.strictEqual(headers['Content-Type'], 'application/json');

      assert.deepStrictEqual(JSON.parse(String(capturedInit?.body)), updatePayload);
      assert.deepStrictEqual(result, updatedProfileResponse);
    });

    it('serializes every populated scoring preference without dropping zero or false', async () => {
      const populatedPayload: UpdateProfilePayload = {
        expectedRevision: 4,
        preferences: {
          seatPreference: 'WINDOW',
          classPreference: 'ECONOMY',
          preferredAirlines: ['VN', 'SQ'],
          blacklistedAirlines: ['XX'],
          preferredDepartureWindow: { start: 6, end: 9 },
          preferredArrivalWindow: { start: 23, end: 1 },
          maxStops: 0,
          priceSensitivity: 'MODERATE',
          requiresCheckedBaggage: false,
        },
      };
      let capturedInit: RequestInit | undefined;

      globalThis.fetch = stubJsonResponse(updatedProfileResponse, 200, (_input, init) => {
        capturedInit = init;
      });

      await updateProfile('sample-token', populatedPayload);

      assert.deepStrictEqual(JSON.parse(String(capturedInit?.body)), populatedPayload);
    });

    it('serializes explicit clearing values for every scoring preference', async () => {
      const clearPayload: UpdateProfilePayload = {
        expectedRevision: 4,
        preferences: {
          seatPreference: 'WINDOW',
          classPreference: 'ECONOMY',
          preferredAirlines: null,
          blacklistedAirlines: null,
          preferredDepartureWindow: null,
          preferredArrivalWindow: null,
          maxStops: null,
          priceSensitivity: null,
          requiresCheckedBaggage: null,
        },
      };
      let capturedInit: RequestInit | undefined;

      globalThis.fetch = stubJsonResponse(updatedProfileResponse, 200, (_input, init) => {
        capturedInit = init;
      });

      await updateProfile('sample-token', clearPayload);

      assert.deepStrictEqual(JSON.parse(String(capturedInit?.body)), clearPayload);
    });

    it('updateTravelerProfile alias behaves identically to updateProfile', async () => {
      assert.strictEqual(updateTravelerProfile, updateProfile);

      let capturedUrl = '';
      let capturedInit: RequestInit | undefined;

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedInit = init;
        return new Response(JSON.stringify(updatedProfileResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;

      const result = await updateTravelerProfile('jwt-auth-token-alias', updatePayload);

      assert.strictEqual(capturedUrl, 'http://127.0.0.1:3001/api/profile');
      assert.strictEqual(capturedInit?.method, 'PATCH');
      const headers = capturedInit?.headers as Record<string, string>;
      assert.strictEqual(headers['Authorization'], 'Bearer jwt-auth-token-alias');
      assert.strictEqual(headers['Cache-Control'], 'no-store, private');
      assert.strictEqual(headers['Content-Type'], 'application/json');
      assert.deepStrictEqual(JSON.parse(String(capturedInit?.body)), updatePayload);
      assert.deepStrictEqual(result, updatedProfileResponse);
    });
  });

  describe('Sanitized Error Mapping (ProfileRequestError)', () => {
    const errorCases = [
      {
        status: 400,
        name: '400 Bad Request',
        body: { message: 'Invalid passport expiration date format.' },
        expectedMessage: 'Invalid passport expiration date format.',
        expectedCode: null,
      },
      {
        status: 400,
        name: '400 Bad Request with array message',
        body: { message: ['givenName is required.', 'email must be a valid email.'] },
        expectedMessage: 'givenName is required. email must be a valid email.',
        expectedCode: null,
      },
      {
        status: 401,
        name: '401 Unauthorized',
        body: { message: 'Authentication required.', code: 'UNAUTHORIZED' },
        expectedMessage: 'Authentication required.',
        expectedCode: 'UNAUTHORIZED',
      },
      {
        status: 403,
        name: '403 Forbidden',
        body: { message: 'Access to profile is forbidden.', code: 'FORBIDDEN' },
        expectedMessage: 'Access to profile is forbidden.',
        expectedCode: 'FORBIDDEN',
      },
      {
        status: 404,
        name: '404 Not Found',
        body: { message: 'Profile not found.', code: 'PROFILE_NOT_FOUND' },
        expectedMessage: 'Profile not found.',
        expectedCode: 'PROFILE_NOT_FOUND',
      },
      {
        status: 500,
        name: '500 Internal Server Error',
        body: { message: 'Internal server error processing profile.' },
        expectedMessage: 'Internal server error processing profile.',
        expectedCode: null,
      },
      {
        status: 502,
        name: '502 Bad Gateway',
        body: { message: 'Upstream profile database unreachable.' },
        expectedMessage: 'Upstream profile database unreachable.',
        expectedCode: null,
      },
    ];

    for (const ec of errorCases) {
      it(`correctly maps ${ec.name} to ProfileRequestError`, async () => {
        globalThis.fetch = (async () => {
          return new Response(JSON.stringify(ec.body), {
            status: ec.status,
            headers: { 'Content-Type': 'application/json' },
          });
        }) as typeof fetch;

        await assert.rejects(
          () => fetchProfile('test-token'),
          (err: unknown) => {
            assert.ok(err instanceof ProfileRequestError);
            assert.strictEqual(err.status, ec.status);
            assert.strictEqual(err.message, ec.expectedMessage);
            assert.strictEqual(err.code, ec.expectedCode);
            return true;
          },
        );
      });
    }

    it('falls back to default sanitized message when error body is non-JSON or missing message', async () => {
      globalThis.fetch = (async () => {
        return new Response('<html>502 Bad Gateway</html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        });
      }) as typeof fetch;

      await assert.rejects(
        () => fetchProfile('test-token'),
        (err: unknown) => {
          assert.ok(err instanceof ProfileRequestError);
          assert.strictEqual(err.status, 502);
          assert.strictEqual(err.message, 'We could not update your traveler profile.');
          assert.strictEqual(err.code, null);
          return true;
        },
      );
    });

    it('replaces a sensitive server error message with the generic profile failure message', async () => {
      const sensitiveMessage =
        'Unable to update jane.doe@example.com with Passport A12345678 using Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature.';

      globalThis.fetch = stubJsonResponse({ message: sensitiveMessage }, 500);

      await assert.rejects(
        () => fetchProfile('test-token'),
        (err: unknown) => {
          assert.ok(err instanceof ProfileRequestError);
          assert.strictEqual(err.message, 'We could not update your traveler profile.');
          assert.ok(!err.message.includes('jane.doe@example.com'));
          assert.ok(!err.message.includes('A12345678'));
          assert.ok(!err.message.includes('eyJhbGciOiJIUzI1NiJ9'));
          return true;
        },
      );
    });

    it('replaces an unallowlisted server error message that contains unrecognized sensitive data', async () => {
      const customerName = 'Maya Chen';
      const phoneNumber = '+84 912 345 678';
      const opaqueCredential = 'credential_9f4c2a';
      const sensitiveMessage = `Unable to update ${customerName}; contact ${phoneNumber}; credential ${opaqueCredential}.`;

      globalThis.fetch = stubJsonResponse({ message: sensitiveMessage }, 500);

      await assert.rejects(
        () => fetchProfile('test-token'),
        (err: unknown) => {
          assert.ok(err instanceof ProfileRequestError);
          assert.strictEqual(err.message, 'We could not update your traveler profile.');
          assert.ok(!err.message.includes(customerName));
          assert.ok(!err.message.includes(phoneNumber));
          assert.ok(!err.message.includes(opaqueCredential));
          return true;
        },
      );
    });
  });

  describe('Optimistic Concurrency Conflict Handling (409 Conflict)', () => {
    const conflictBody = {
      code: 'PROFILE_UPDATE_CONFLICT',
      message: 'Profile has been modified by another session. Refresh and retry.',
    };

    it('maps the production legacy message-only conflict to a safe local semantic', async () => {
      globalThis.fetch = stubJsonResponse(
        { message: 'PROFILE_UPDATE_CONFLICT', statusCode: 409 },
        409,
      );

      await assert.rejects(
        () =>
          updateProfile('test-token', {
            expectedRevision: 1,
            preferences: { seatPreference: 'AISLE', classPreference: null },
          }),
        (err: unknown) => {
          assert.ok(err instanceof ProfileRequestError);
          assert.strictEqual(err.status, 409);
          assert.strictEqual(err.code, 'PROFILE_UPDATE_CONFLICT');
          assert.strictEqual(
            err.message,
            'Profile has been modified by another session. Refresh and retry.',
          );
          return true;
        },
      );
    });

    it('extracts PROFILE_UPDATE_CONFLICT code and message on updateProfile 409 conflict', async () => {
      globalThis.fetch = (async () => {
        return new Response(JSON.stringify(conflictBody), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;

      await assert.rejects(
        () =>
          updateProfile('test-token', {
            expectedRevision: 1,
            preferences: { seatPreference: 'AISLE', classPreference: null },
          }),
        (err: unknown) => {
          assert.ok(err instanceof ProfileRequestError);
          assert.strictEqual(err.status, 409);
          assert.strictEqual(err.code, 'PROFILE_UPDATE_CONFLICT');
          assert.strictEqual(
            err.message,
            'Profile has been modified by another session. Refresh and retry.',
          );
          return true;
        },
      );
    });

    it('extracts PROFILE_REVISION_CONFLICT code and safe message on updateProfile 409 conflict', async () => {
      globalThis.fetch = stubJsonResponse(
        {
          code: 'PROFILE_REVISION_CONFLICT',
          message: 'Profile revision conflict.',
        },
        409,
      );

      await assert.rejects(
        () =>
          updateProfile('test-token', {
            expectedRevision: 1,
            preferences: { seatPreference: 'AISLE', classPreference: null },
          }),
        (err: unknown) => {
          assert.ok(err instanceof ProfileRequestError);
          assert.strictEqual(err.status, 409);
          assert.strictEqual(err.code, 'PROFILE_REVISION_CONFLICT');
          assert.strictEqual(err.message, 'Profile revision conflict.');
          return true;
        },
      );
    });

    it('extracts PROFILE_UPDATE_CONFLICT code and message on updateTravelerProfile 409 conflict', async () => {
      globalThis.fetch = (async () => {
        return new Response(JSON.stringify(conflictBody), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;

      await assert.rejects(
        () =>
          updateTravelerProfile('test-token', {
            expectedRevision: 2,
            preferences: { seatPreference: 'WINDOW', classPreference: 'BUSINESS' },
          }),
        (err: unknown) => {
          assert.ok(err instanceof ProfileRequestError);
          assert.strictEqual(err.status, 409);
          assert.strictEqual(err.code, 'PROFILE_UPDATE_CONFLICT');
          assert.strictEqual(
            err.message,
            'Profile has been modified by another session. Refresh and retry.',
          );
          return true;
        },
      );
    });
  });
});
