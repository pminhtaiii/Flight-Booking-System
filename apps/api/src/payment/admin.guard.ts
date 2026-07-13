import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AdminGuard implements CanActivate {
  private readonly adminEmails: string[];

  constructor(private readonly configService: ConfigService) {
    const emailsStr = this.configService.get<string>('ADMIN_EMAILS', 'admin@example.com');
    this.adminEmails = emailsStr.split(',').map((e) => e.trim().toLowerCase());
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || !user.email) {
      throw new ForbiddenException('Admin access required');
    }

    const email = user.email.toLowerCase().trim();
    if (!this.adminEmails.includes(email)) {
      throw new ForbiddenException('Admin access required');
    }

    return true;
  }
}

