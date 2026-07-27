import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { DuffelModule } from '@/duffel/duffel.module';
import { AuditModule } from '@/audit/audit.module';
import { PaymentModule } from '@/payment/payment.module';
import { AncillariesController } from './ancillaries.controller';
import { AncillariesService } from './ancillaries.service';
import { AncillaryCatalogService } from './ancillary-catalog.service';

@Module({
  imports: [PrismaModule, DuffelModule, AuditModule, PaymentModule],
  controllers: [AncillariesController],
  providers: [AncillariesService, AncillaryCatalogService],
})
export class AncillariesModule {}
