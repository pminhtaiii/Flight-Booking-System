import { UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { BookingHandoffController } from './booking-handoff.controller';
import { ChatHandoffService } from './chat-handoff.service';

describe('BookingHandoffController', () => {
  // The casts below adapt minimal typed controller doubles; no production value crosses this boundary.
  it('resolves the contract body through the safe service boundary', async () => {
    const chatHandoffService = {
      resolveSafe: jest.fn().mockResolvedValue({
        status: 'ACTIVE',
        expiresAt: '2026-12-01T00:00:00.000Z',
        offer: { airline: 'T093 Airways' },
      }),
    };
    const controller = new BookingHandoffController(
      chatHandoffService as unknown as ChatHandoffService,
    );
    const response = { setHeader: jest.fn() } as unknown as Response;

    await expect(
      controller.resolve(
        { handoffToken: 'chk_handoff_v1_test' },
        { user: { sub: 'user-1' } },
        response,
        'trace-1',
        'correlation-1',
      ),
    ).resolves.toMatchObject({ status: 'ACTIVE' });
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store, private');
    expect(chatHandoffService.resolveSafe).toHaveBeenCalled();
    expect(chatHandoffService.resolveSafe).toHaveBeenCalledWith('chk_handoff_v1_test', 'user-1', {
      traceId: 'trace-1',
      correlationId: 'correlation-1',
    });
  });

  it('rejects a request without a canonical user identity', async () => {
    const chatHandoffService = { resolveSafe: jest.fn() };
    const controller = new BookingHandoffController(
      chatHandoffService as unknown as ChatHandoffService,
    );

    await expect(
      controller.resolve(
        { handoffToken: 'chk_handoff_v1_test' },
        { user: {} },
        { setHeader: jest.fn() } as unknown as Response,
      ),
    ).rejects.toThrow(UnauthorizedException);
    expect(chatHandoffService.resolveSafe).not.toHaveBeenCalled();
  });
});
