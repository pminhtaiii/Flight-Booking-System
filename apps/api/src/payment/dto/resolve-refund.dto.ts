import { IsIn } from 'class-validator';

export const refundResolutionActions = ['RETRY_WITH_FRESH_KEY', 'MARK_RESOLVED_MANUALLY'] as const;

export type RefundResolutionAction = (typeof refundResolutionActions)[number];

export class ResolveRefundDto {
  @IsIn(refundResolutionActions)
  action!: RefundResolutionAction;
}
