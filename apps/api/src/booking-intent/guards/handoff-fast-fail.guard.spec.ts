import { ConflictException, type ExecutionContext } from '@nestjs/common';
import { HandoffFastFailGuard } from './handoff-fast-fail.guard';

type RequestFixture = {
  body?: { handoffToken?: string };
  user?: { id: string };
  handoffFastFailReservation?: { token: string; reservationId: string };
};

function executionContext(request: RequestFixture): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as ExecutionContext;
}

describe('HandoffFastFailGuard', () => {
  it('attaches an owner-safe reservation for an authenticated handoff request', () => {
    const request: RequestFixture = {
      body: { handoffToken: 'chk_handoff_v1_token' },
      user: { id: 'user-1' },
    };
    const tryAcquireInFlight = jest.fn().mockReturnValue('reservation-1');
    const guard = new HandoffFastFailGuard({ tryAcquireInFlight } as never);

    expect(guard.canActivate(executionContext(request))).toBe(true);
    expect(request.handoffFastFailReservation).toEqual({
      token: 'chk_handoff_v1_token',
      reservationId: 'reservation-1',
    });
  });

  it('rejects a duplicate reservation before controller work', () => {
    const guard = new HandoffFastFailGuard({
      tryAcquireInFlight: jest.fn().mockReturnValue(null),
    } as never);

    expect(() =>
      guard.canActivate(
        executionContext({
          body: { handoffToken: 'chk_handoff_v1_token' },
          user: { id: 'user-1' },
        }),
      ),
    ).toThrow(ConflictException);
  });

  it('keeps the reservation identifier so the service can release only its own reservation', () => {
    const request: RequestFixture = {
      body: { handoffToken: 'chk_handoff_v1_token' },
      user: { id: 'user-1' },
    };
    const guard = new HandoffFastFailGuard({
      tryAcquireInFlight: jest.fn().mockReturnValue('reservation-1'),
    } as never);

    guard.canActivate(executionContext(request));

    expect(request.handoffFastFailReservation).toEqual({
      token: 'chk_handoff_v1_token',
      reservationId: 'reservation-1',
    });
  });

  it('bypasses in-flight reservation on advisory readiness route', () => {
    const request = {
      originalUrl: '/api/bookings/intents/readiness',
      body: { handoffToken: 'chk_handoff_v1_token' },
      user: { id: 'user-1' },
    };
    const tryAcquireInFlight = jest.fn();
    const guard = new HandoffFastFailGuard({ tryAcquireInFlight } as never);

    expect(guard.canActivate(executionContext(request as never))).toBe(true);
    expect(tryAcquireInFlight).not.toHaveBeenCalled();
  });
});
