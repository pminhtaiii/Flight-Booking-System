# Phase 2: Idempotency Module Extraction & Ancillaries Decoupling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract `IdempotencyModule` and `PaymentIdempotencyService` into an independent domain module and decouple `AncillariesModule` from `PaymentModule`.

**Architecture:** Create `IdempotencyModule` in `apps/api/src/idempotency/` importing `PrismaModule` and exporting `PaymentIdempotencyService`. Move existing idempotency service and unit tests into `apps/api/src/idempotency/` while retaining a deprecation re-export in `apps/api/src/payment/payment-idempotency.service.ts`. Rewire `PaymentModule` and `AncillariesModule` so that `AncillariesModule` imports `IdempotencyModule` with zero imports from `PaymentModule`, avoiding duplicate provider registration.

**Tech Stack:** NestJS 10, TypeScript, Prisma, Jest.

**Spec:** `specs/024-event-driven-module-deepening/spec.md`, `specs/024-event-driven-module-deepening/plan.md`, `GOAL.md`.

## Global Constraints

- Preserve exact `acquireOrReplay` logic, hash calculation, 409 active request conflict, 422 mismatch, 5-minute stale lock CAS, `lockedAt` return, `isLocked`, `getResumePoint`, `recordSuccess`, `recordFailure`, and `abandonAcquiredKey` semantics verbatim.
- `AncillariesModule` MUST NOT import `PaymentModule`.
- `PaymentIdempotencyService` must only be provided by `IdempotencyModule`.
- Do NOT implement saga ports, adapters, or saga orchestration (Phase 3 / Tasks T005–T014) in this phase.
- Always run tests with `$env:NODE_OPTIONS = "--require=$PWD/tests/ci/node-network-guard.cjs"`.

---

### Task 1: [Foundation] Extract `IdempotencyModule` & Service (T003)

**Files:**
- Create: `apps/api/src/idempotency/idempotency.module.ts`
- Create/Move: `apps/api/src/idempotency/payment-idempotency.service.ts`
- Create/Move: `apps/api/src/idempotency/payment-idempotency.service.spec.ts`
- Modify: `apps/api/src/payment/payment-idempotency.service.ts`

**Interfaces:**
- Consumes: `PrismaService` from `../prisma/prisma.service` (or `@/prisma/prisma.service`).
- Produces: `IdempotencyModule` and `PaymentIdempotencyService` exported from `@/idempotency/idempotency.module` and `@/idempotency/payment-idempotency.service`, plus `IdempotencyKey` decorator.

- [x] **Step 1: Create `apps/api/src/idempotency/payment-idempotency.service.ts` and `apps/api/src/idempotency/idempotency.module.ts`**

Copy the entire content of `apps/api/src/payment/payment-idempotency.service.ts` into `apps/api/src/idempotency/payment-idempotency.service.ts`, updating Prisma import to `../prisma/prisma.service` (or `@/prisma/prisma.service`).

Create `apps/api/src/idempotency/idempotency.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PaymentIdempotencyService } from './payment-idempotency.service';

@Module({
  imports: [PrismaModule],
  providers: [PaymentIdempotencyService],
  exports: [PaymentIdempotencyService],
})
export class IdempotencyModule {}
```

- [x] **Step 2: Create `apps/api/src/idempotency/payment-idempotency.service.spec.ts`**

Move/copy `apps/api/src/payment/payment-idempotency.service.spec.ts` into `apps/api/src/idempotency/payment-idempotency.service.spec.ts` and ensure import `./payment-idempotency.service` resolves correctly.

- [x] **Step 3: Setup backward-compatible deprecation re-export in `apps/api/src/payment/payment-idempotency.service.ts`**

Replace content of `apps/api/src/payment/payment-idempotency.service.ts` with:
```typescript
/**
 * @deprecated Use '@/idempotency/payment-idempotency.service' instead.
 */
export * from '../idempotency/payment-idempotency.service';
```

- [x] **Step 4: Run unit tests for idempotency service in new location**

Run:
```powershell
pnpm --filter @api/backend test -- apps/api/src/idempotency/payment-idempotency.service.spec.ts
```
Expected: PASS (23/23 tests pass).

- [x] **Step 5: Commit changes**

```powershell
git add apps/api/src/idempotency/ apps/api/src/payment/payment-idempotency.service.ts
git commit -m "feat(api): extract IdempotencyModule and PaymentIdempotencyService (T003)"
```

---

### Task 2: [Foundation] Rewire Imports & Decouple `AncillariesModule` (T004)

**Files:**
- Modify: `apps/api/src/payment/payment.module.ts`
- Modify: `apps/api/src/ancillaries/ancillaries.module.ts`
- Modify: `apps/api/src/ancillaries/ancillaries.service.ts`
- Modify: `apps/api/src/payment/payment.service.ts`
- Modify: `apps/api/src/payment/payment.controller.ts`
- Modify: `apps/api/src/payment/payment-refund.service.ts`
- Modify: `apps/api/src/payment/payment.service.spec.ts`
- Modify: `apps/api/src/payment/payment-refund.service.spec.ts`
- Modify: `apps/api/src/payment/payment-ancillary-validation-boundary.spec.ts`
- Modify: `apps/api/src/payment/payment-ancillary-pipeline.spec.ts`
- Modify: `apps/api/src/payment/payment-ancillary-order-recovery.spec.ts`
- Modify: `apps/api/src/payment/payment-ancillary-final-fixes.spec.ts`
- Modify: `apps/api/src/payment/payment-ancillary-binding.spec.ts`
- Modify: `apps/api/src/payment/payment-ancillary-binding-supplemental.spec.ts`
- Modify: `apps/api/src/payment/payment-ancillary-binding-fixes.spec.ts`
- Modify: `apps/api/test/payment-fulfillment.e2e-spec.ts`
- Create: `apps/api/src/ancillaries/ancillaries.module.spec.ts`

**Interfaces:**
- Consumes: `IdempotencyModule` and `PaymentIdempotencyService` from `@/idempotency/idempotency.module` and `@/idempotency/payment-idempotency.service`.
- Produces: `AncillariesModule` without `PaymentModule` dependency; `PaymentModule` without duplicate `PaymentIdempotencyService` provider.

- [x] **Step 1: Write failing test verifying `AncillariesModule` decoupling**

Create `apps/api/src/ancillaries/ancillaries.module.spec.ts`:
```typescript
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
```

- [x] **Step 2: Run test to verify it fails**

Run:
```powershell
pnpm --filter @api/backend test -- apps/api/src/ancillaries/ancillaries.module.spec.ts
```
Expected: FAIL (because `AncillariesModule` still imports `PaymentModule`).

- [x] **Step 3: Rewire `AncillariesModule` and `PaymentModule`**

In `apps/api/src/ancillaries/ancillaries.module.ts`:
- Remove `PaymentModule` from `imports`.
- Add `IdempotencyModule` to `imports`.

In `apps/api/src/payment/payment.module.ts`:
- Import `IdempotencyModule` and add to `imports`.
- Remove `PaymentIdempotencyService` from `providers`.
- Export `IdempotencyModule` (and keep `PaymentIdempotencyService` in `exports` or export `IdempotencyModule`).

In `apps/api/src/ancillaries/ancillaries.service.ts`:
- Update import from `@/payment/payment-idempotency.service` to `@/idempotency/payment-idempotency.service`.

- [x] **Step 4: Update payment caller and spec imports**

Update import `from '@/payment/payment-idempotency.service'` (and `./payment-idempotency.service`) to `@/idempotency/payment-idempotency.service`:
- `apps/api/src/payment/payment.service.ts`
- `apps/api/src/payment/payment.controller.ts`
- `apps/api/src/payment/payment-refund.service.ts`
- `apps/api/src/payment/payment.service.spec.ts`
- `apps/api/src/payment/payment-refund.service.spec.ts`
- `apps/api/src/payment/payment-ancillary-validation-boundary.spec.ts`
- `apps/api/src/payment/payment-ancillary-pipeline.spec.ts`
- `apps/api/src/payment/payment-ancillary-order-recovery.spec.ts`
- `apps/api/src/payment/payment-ancillary-final-fixes.spec.ts`
- `apps/api/src/payment/payment-ancillary-binding.spec.ts`
- `apps/api/src/payment/payment-ancillary-binding-supplemental.spec.ts`
- `apps/api/src/payment/payment-ancillary-binding-fixes.spec.ts`
- `apps/api/test/payment-fulfillment.e2e-spec.ts`

- [x] **Step 5: Run tests to verify they pass**

Run:
```powershell
pnpm --filter @api/backend test -- apps/api/src/ancillaries/
pnpm --filter @api/backend test -- apps/api/test/payment-fulfillment.e2e-spec.ts
```
Expected: PASS.

- [x] **Step 6: Commit changes**

```powershell
git add apps/api/src/ancillaries/ apps/api/src/payment/ apps/api/test/payment-fulfillment.e2e-spec.ts
git commit -m "refactor(api): rewire idempotency imports and decouple AncillariesModule (T004)"
```

---

### Task 3: [Foundation] Verification, Task Checklist & Documentation Updates

**Files:**
- Modify: `specs/024-event-driven-module-deepening/tasks.md`
- Modify: `context/architecture.md`
- Modify: `context/progress-checker.md`

- [x] **Step 1: Run full verification suite**

Run:
```powershell
pnpm exec eslint "apps/api/**/*.ts" --max-warnings 0
pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit
$env:NODE_OPTIONS = "--require=$PWD/tests/ci/node-network-guard.cjs"
pnpm --filter @api/backend test -- apps/api/src/idempotency/payment-idempotency.service.spec.ts
pnpm --filter @api/backend test -- apps/api/src/ancillaries/
pnpm --filter @api/backend test -- apps/api/test/payment-fulfillment.e2e-spec.ts
```
Expected: All commands exit with code 0.

- [x] **Step 2: Update `specs/024-event-driven-module-deepening/tasks.md`**

Mark tasks `T003` and `T004` as completed (`[x]`).

- [x] **Step 3: Update `context/architecture.md` and `context/progress-checker.md`**

Reflect `IdempotencyModule` creation and decoupling of `AncillariesModule` in architecture documentation and update progress checker.

- [x] **Step 4: Commit documentation updates**

```powershell
git add specs/024-event-driven-module-deepening/tasks.md context/architecture.md context/progress-checker.md docs/superpowers/plans/2026-09-16-024-phase2-idempotency-extraction-plan.md
git commit -m "docs(phase2): complete T003 and T004 foundation extraction"
```
