import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PaymentMethodService } from './payment-method.service';

@Module({
  imports: [PrismaModule],
  providers: [PaymentMethodService],
  exports: [PaymentMethodService],
})
export class PaymentMethodsModule {}
