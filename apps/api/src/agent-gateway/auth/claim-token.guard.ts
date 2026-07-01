import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ClaimTokenService } from './claim-token.service';

@Injectable()
export class ClaimTokenGuard implements CanActivate {
  constructor(private readonly claimTokenService: ClaimTokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = request.headers['x-user-claim'];

    if (!token || typeof token !== 'string') {
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Missing or invalid X-User-Claim header',
        code: 'INVALID_CLAIM_TOKEN',
      });
    }

    const user = await this.claimTokenService.validateToken(token);
    request.user = user;
    return true;
  }
}
