const fs = require('fs');

const path = 'apps/api/src/payment/payment.service.ts';
let content = fs.readFileSync(path, 'utf8');

// 1. Add getUnresolvedRollbacks
const helperMethod = `
  private async getUnresolvedRollbacks(idempotencyKey?: string): Promise<{ id?: string, redisKey?: string, fileIndex?: number, piId: string, ikey?: string }[]> {
    const rollbacks: { id?: string, redisKey?: string, fileIndex?: number, piId: string, ikey?: string }[] = [];
    
    // 1. Audit Logs
    try {
      const pendingRollbacks = await this.prisma.auditLog.findMany({
        where: { action: 'failed_stripe_rollback' },
      });
      for (const r of pendingRollbacks) {
        const metadata = (r.metadata as any) || {};
        const ikey = metadata.idempotencyKey;
        if (!idempotencyKey || ikey === idempotencyKey) {
          if (r.resourceId) {
            rollbacks.push({ id: r.id, piId: r.resourceId, ikey });
          }
        }
      }
    } catch (err: any) {
      this.logger.warn(\`Failed to read rollbacks from DB: \${err.message}\`);
    }

    // 2. Redis
    if (this.cacheService) {
      try {
        const keys = await this.cacheService.keysDurable('stripe_rollback_failure:*');
        for (const key of keys) {
          const val = await this.cacheService.getDurable(key);
          if (val) {
            try {
              const parsed = JSON.parse(val);
              if (!idempotencyKey || parsed.idempotencyKey === idempotencyKey) {
                if (parsed.paymentIntentId) {
                  rollbacks.push({ redisKey: key, piId: parsed.paymentIntentId, ikey: parsed.idempotencyKey });
                }
              }
            } catch (e) {}
          }
        }
      } catch (err: any) {
        this.logger.warn(\`Failed to sweep Redis rollback failures: \${err.message}\`);
      }
    }

    // 3. Local file
    try {
      const fsModule = require('fs');
      const pathModule = require('path');
      const logPath = pathModule.join(process.cwd(), 'stripe_rollback_failures.log');
      if (fsModule.existsSync(logPath)) {
        const lines = fsModule.readFileSync(logPath, 'utf8').split('\\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line) {
            try {
              const parsed = JSON.parse(line);
              if (!idempotencyKey || parsed.idempotencyKey === idempotencyKey) {
                if (parsed.paymentIntentId) {
                  rollbacks.push({ fileIndex: i, piId: parsed.paymentIntentId, ikey: parsed.idempotencyKey });
                }
              }
            } catch(e) {}
          }
        }
      }
    } catch (err: any) {
      this.logger.warn(\`Failed to sweep local file rollback failures: \${err.message}\`);
    }

    return rollbacks;
  }
`;

// Insert helper method before sweepStripeRollbackFailures
content = content.replace('  private async sweepStripeRollbackFailures() {', helperMethod + '\\n  private async sweepStripeRollbackFailures() {');

// 2. Rewrite sweepStripeRollbackFailures
const newSweep = `  private async sweepStripeRollbackFailures() {
    try {
      const rollbacks = await this.getUnresolvedRollbacks();
      const resolvedFileIndices = new Set<number>();
      
      for (const rollback of rollbacks) {
        const piId = rollback.piId;
        const ikey = rollback.ikey;
        
        this.logger.log(\`Startup sweep: Attempting to cancel dangling Stripe PaymentIntent \${piId}...\`);
        try {
          await this.stripeService.cancelPaymentIntent(piId);
          this.logger.log(\`Startup sweep: Successfully cancelled dangling PaymentIntent \${piId}\`);

          if (rollback.id) {
            await this.prisma.auditLog.update({
              where: { id: rollback.id },
              data: { action: 'resolved_failed_stripe_rollback' },
            });
          }
          if (rollback.redisKey && this.cacheService) {
            await this.cacheService.delDurable(rollback.redisKey).catch(() => {});
          }
          if (rollback.fileIndex !== undefined) {
            resolvedFileIndices.add(rollback.fileIndex);
          }

          if (ikey) {
            try {
              const keyRecord = await this.prisma.idempotencyKey.findUnique({
                where: { key: ikey },
              });
              if (keyRecord) {
                const updatedParams = { ...(keyRecord.requestParams as any || {}) };
                delete updatedParams.backupPaymentIntentId;
                updatedParams.stripeRetryCount = (updatedParams.stripeRetryCount || 0) + 1;
                await this.prisma.idempotencyKey.update({
                  where: { key: ikey },
                  data: { requestParams: updatedParams },
                });
              }
            } catch (dbErr: any) {
              // Ignore DB error
            }
          }
        } catch (stripeErr: any) {
          this.logger.error(\`Startup sweep: Failed to cancel dangling PaymentIntent \${piId}: \${stripeErr.message}\`);
        }
      }
      
      // Rewrite local log if any file entries were resolved
      if (resolvedFileIndices.size > 0) {
        try {
          const fsModule = require('fs');
          const pathModule = require('path');
          const logPath = pathModule.join(process.cwd(), 'stripe_rollback_failures.log');
          if (fsModule.existsSync(logPath)) {
            const lines = fsModule.readFileSync(logPath, 'utf8').split('\\n');
            const remainingLines = lines.filter((_, idx) => !resolvedFileIndices.has(idx) && lines[idx].trim() !== '');
            fsModule.writeFileSync(logPath, remainingLines.join('\\n') + (remainingLines.length > 0 ? '\\n' : ''), 'utf8');
            this.logger.log(\`Startup sweep: Cleared \${resolvedFileIndices.size} resolved entries from local fallback log.\`);
          }
        } catch (err: any) {
          this.logger.warn(\`Startup sweep: Failed to rewrite local fallback log: \${err.message}\`);
        }
      }
    } catch (err: any) {
      this.logger.error(\`Failed to sweep Stripe rollback failures: \${err.message}\`, err.stack);
    }
  }`;

// replace the entire old sweepStripeRollbackFailures
const sweepRegex = /  private async sweepStripeRollbackFailures\(\) \{[\s\S]*?private async enrichPassengerSnapshot/m;
content = content.replace(sweepRegex, newSweep + '\n\n  private async enrichPassengerSnapshot');

// 3. Replace createPayment pendingRollbacks block
const oldCreatePaymentBlock = `      const pendingRollbacks = (await this.prisma.auditLog.findMany({
        where: {
          action: 'failed_stripe_rollback',
        },
      })) || [];
      const matchingRollbacks = pendingRollbacks.filter((rollback: any) => {
        const metadata = rollback.metadata as any || {};
        return metadata.idempotencyKey === idempotencyKey;
      });

      const canceledIntentIds = new Set<string>();
      if (matchingRollbacks.length > 0) {
        this.logger.warn(\`Found \${matchingRollbacks.length} unresolved failed stripe rollbacks for idempotency key \${idempotencyKey}. Resolving...\`);
        for (const rollback of matchingRollbacks) {
          const piId = rollback.resourceId;
          if (piId) {
            if (!canceledIntentIds.has(piId)) {
              try {
                await this.stripeService.cancelPaymentIntent(piId);
                canceledIntentIds.add(piId);
                this.logger.log(\`Successfully cancelled previously failed rollback PaymentIntent \${piId}\`);
              } catch (cancelError: any) {
                this.logger.error(\`Failed to cancel previously failed rollback PaymentIntent \${piId}: \${cancelError.message}\`, cancelError.stack);
                throw new ConflictException(\`Deferred rollback of previous PaymentIntent \${piId} failed. Please try again later.\`);
              }
            }
            await this.prisma.auditLog.update({
              where: { id: rollback.id },
              data: { action: 'resolved_failed_stripe_rollback' },
            });
          }
        }`;

const newCreatePaymentBlock = `      const matchingRollbacks = await this.getUnresolvedRollbacks(idempotencyKey);

      const canceledIntentIds = new Set<string>();
      if (matchingRollbacks.length > 0) {
        this.logger.warn(\`Found \${matchingRollbacks.length} unresolved failed stripe rollbacks for idempotency key \${idempotencyKey}. Resolving...\`);
        for (const rollback of matchingRollbacks) {
          const piId = rollback.piId;
          if (!canceledIntentIds.has(piId)) {
            try {
              await this.stripeService.cancelPaymentIntent(piId);
              canceledIntentIds.add(piId);
              this.logger.log(\`Successfully cancelled previously failed rollback PaymentIntent \${piId}\`);
            } catch (cancelError: any) {
              this.logger.error(\`Failed to cancel previously failed rollback PaymentIntent \${piId}: \${cancelError.message}\`, cancelError.stack);
              throw new ConflictException(\`Deferred rollback of previous PaymentIntent \${piId} failed. Please try again later.\`);
            }
          }
          
          if (rollback.id) {
            await this.prisma.auditLog.update({
              where: { id: rollback.id },
              data: { action: 'resolved_failed_stripe_rollback' },
            });
          }
          if (rollback.redisKey && this.cacheService) {
            await this.cacheService.delDurable(rollback.redisKey).catch(() => {});
          }
          // We do not eagerly remove from local file here to avoid concurrent rewrite corruption.
          // The background sweep will clean it up later. Stripe cancel is idempotent so retry is safe.
        }`;

content = content.replace(oldCreatePaymentBlock, newCreatePaymentBlock);

fs.writeFileSync(path, content, 'utf8');
console.log('Successfully updated payment.service.ts');
