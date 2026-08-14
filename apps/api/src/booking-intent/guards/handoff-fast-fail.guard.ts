import { CanActivate, ConflictException, ExecutionContext, Injectable, Optional } from '@nestjs/common';
import { ChatHandoffService } from '@/chat-handoff/chat-handoff.service';

type HandoffRequest = {
  body?: { handoffToken?: string };
  user?: { id?: string };
  handoffFastFailReservation?: { token: string; reservationId: string };
};

@Injectable()
export class HandoffFastFailGuard implements CanActivate {
  constructor(@Optional() private readonly chatHandoffService?: ChatHandoffService) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.chatHandoffService) return true;
    const req = context.switchToHttp().getRequest<HandoffRequest>();
    const token = req.body?.handoffToken;
    const userId = req.user?.id;

    if (token && userId) {
      if (typeof this.chatHandoffService.tryAcquireInFlight === 'function') {
        const reservationId = this.chatHandoffService.tryAcquireInFlight(token, userId);
        if (!reservationId) {
          throw new ConflictException({ code: 'HANDOFF_IN_PROGRESS', message: 'Handoff in progress' });
        }
        req.handoffFastFailReservation = { token, reservationId };
      } else if (typeof this.chatHandoffService.isClaimed === 'function') {
        if (this.chatHandoffService.isClaimed(token, userId)) {
          throw new ConflictException({ code: 'HANDOFF_IN_PROGRESS', message: 'Handoff in progress' });
        }
      }
    }
    return true;
  }
}
