import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { SupplierAncillaryModule } from '@/supplier/ancillary/supplier-ancillary.module';
import { AuditModule } from '@/audit/audit.module';
import { IdempotencyModule } from '@/idempotency/idempotency.module';
import { AncillariesController } from './ancillaries.controller';
import { AncillariesService } from './ancillaries.service';
import { AncillaryCatalogService } from './ancillary-catalog.service';

@Module({
  imports: [PrismaModule, SupplierAncillaryModule, AuditModule, IdempotencyModule],
  controllers: [AncillariesController],
  providers: [AncillariesService, AncillaryCatalogService],
})
export class AncillariesModule {}
