import { Test } from '@nestjs/testing';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { AncillariesModule } from './ancillaries.module';
import { PaymentModule } from '@/payment/payment.module';
import { IdempotencyModule } from '@/idempotency/idempotency.module';
import { PrismaService } from '@/prisma/prisma.service';
import { DuffelService } from '@/duffel/duffel.service';
import { AuditService } from '@/audit/audit.service';
import { PaymentIdempotencyService } from '@/idempotency/payment-idempotency.service';

describe('AncillariesModule decoupling', () => {
  it('does not import PaymentModule and imports IdempotencyModule', () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AncillariesModule) || [];
    expect(imports).not.toContain(PaymentModule);
    expect(imports).toContain(IdempotencyModule);
  });

  it('compiles and initializes without PaymentModule registered', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AncillariesModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(DuffelService)
      .useValue({})
      .overrideProvider(AuditService)
      .useValue({})
      .overrideProvider(PaymentIdempotencyService)
      .useValue({})
      .compile();

    expect(moduleRef).toBeDefined();
    expect(() => moduleRef.get(PaymentModule)).toThrow();
  });
});
