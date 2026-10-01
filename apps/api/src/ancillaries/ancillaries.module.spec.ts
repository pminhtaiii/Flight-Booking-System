import { Test } from '@nestjs/testing';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { AncillariesModule } from './ancillaries.module';
import { PaymentModule } from '@/payment/payment.module';
import { IdempotencyModule } from '@/idempotency/idempotency.module';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/audit/audit.service';
import { PaymentIdempotencyService } from '@/idempotency/payment-idempotency.service';
import { SupplierAncillaryModule } from '@/supplier/ancillary/supplier-ancillary.module';
import { DuffelAncillaryService } from '@/supplier/ancillary/duffel-ancillary.service';
import { DUFFEL_SDK } from '@/supplier/core/duffel-core.module';
import { CacheService } from '@/cache/cache.service';

describe('AncillariesModule decoupling', () => {
  it('does not import PaymentModule and imports IdempotencyModule', () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AncillariesModule) || [];
    expect(imports).not.toContain(PaymentModule);
    expect(imports).toContain(IdempotencyModule);
  });

  it('uses SupplierAncillaryModule without importing DuffelModule directly', () => {
    const ancillaryImports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AncillariesModule) || [];
    const paymentImports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, PaymentModule) || [];
    const moduleNames = (imports: unknown): string[] =>
      Array.isArray(imports)
        ? imports.flatMap((module: unknown): string[] =>
            typeof module === 'function' && module.name ? [module.name] : [],
          )
        : [];

    expect(moduleNames(ancillaryImports)).toEqual(
      expect.arrayContaining([SupplierAncillaryModule.name]),
    );
    expect(moduleNames(ancillaryImports)).not.toContain('DuffelModule');
    expect(moduleNames(paymentImports)).toEqual(
      expect.arrayContaining([SupplierAncillaryModule.name]),
    );
    expect(moduleNames(paymentImports)).not.toContain('DuffelModule');
  });

  it('compiles and initializes without PaymentModule registered', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AncillariesModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(DuffelAncillaryService)
      .useValue({ getSeatMapsAndServices: jest.fn(), repriceOffer: jest.fn() })
      .overrideProvider(DUFFEL_SDK)
      .useValue({})
      .overrideProvider(CacheService)
      .useValue({})
      .overrideProvider(AuditService)
      .useValue({})
      .overrideProvider(PaymentIdempotencyService)
      .useValue({})
      .compile();

    expect(moduleRef).toBeDefined();
    expect(() => moduleRef.get(PaymentModule)).toThrow();
    await moduleRef.close();
  });
});
