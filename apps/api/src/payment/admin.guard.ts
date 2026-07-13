import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { Observable } from 'rxjs';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    const adminHeader = request.headers['x-admin-role'];

    const isAdminEmail = user?.email && user.email.includes('admin');
    const isAdminHeader = adminHeader === 'true';

    if (!isAdminEmail && !isAdminHeader) {
      throw new ForbiddenException('Admin access required');
    }

    return true;
  }
}
