import { randomUUID } from 'crypto';
import { Duffel } from '@duffel/api';
import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  DUFFEL_SDK,
  DUFFEL_SDK_CONFIGURATION,
  DuffelRateBudgetService,
} from '@/supplier/core/duffel-core.module';
import type { DuffelSdkConfiguration } from '@/supplier/core/duffel-core.module';
import type { BudgetReservationResult } from '@/supplier/core/duffel-rate-budget.service';

export type DuffelCreateOrderParams = {
  selected_offers: string[];
  passengers: Array<Record<string, unknown>>;
  services?: Array<{ id: string; quantity: number }>;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
};

@Injectable()
export class DuffelOrderAdapter {
  constructor(
    @Inject(DUFFEL_SDK) private readonly duffel: Duffel,
    @Inject(DUFFEL_SDK_CONFIGURATION) private readonly configuration: DuffelSdkConfiguration,
    private readonly rateBudgetService: DuffelRateBudgetService,
  ) {}

  async createOrder(input: DuffelCreateOrderParams): Promise<unknown> {
    const controller = new AbortController();
    const timeoutError = new HttpException(
      'Duffel order creation timed out.',
      HttpStatus.GATEWAY_TIMEOUT,
    );
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(timeoutError);
      }, 30000);
    });

    const orderPromise = (async (): Promise<unknown> => {
      await this.reserveAttempt();
      const response = await fetch(`${this.configuration.basePath}/air/orders`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.configuration.token}`,
          'Duffel-Version': 'v2',
          'Content-Type': 'application/json',
          'Idempotency-Key': `${input.idempotencyKey || randomUUID()}-duffel-order`,
        },
        body: JSON.stringify({
          data: {
            type: 'instant',
            selected_offers: input.selected_offers,
            passengers: input.passengers,
            services: input.services && input.services.length > 0 ? input.services : undefined,
            metadata: input.metadata,
          },
        }),
      });
      const body: unknown = await response.json().catch(() => {
        throw Object.assign(new Error('Failed to create Duffel order'), {
          status: response.status,
        });
      });
      if (!response.ok || this.hasErrors(body)) {
        throw Object.assign(new Error(this.errorMessage(body)), { status: response.status });
      }
      if (!this.isRecord(body) || !('data' in body)) {
        throw Object.assign(new Error('Failed to create Duffel order'), {
          status: response.status,
        });
      }
      return body.data;
    })();

    orderPromise.catch(() => {});

    try {
      return await Promise.race([orderPromise, timeoutPromise]);
    } catch (error: unknown) {
      if (error instanceof HttpException) {
        throw error;
      }
      if (this.statusOf(error) === HttpStatus.TOO_MANY_REQUESTS) {
        throw new HttpException(
          {
            code: 'UPSTREAM_RATE_LIMITED',
            message: 'Duffel API rate limit exceeded',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw new HttpException(
        {
          code: 'UPSTREAM_UNAVAILABLE',
          message: error instanceof Error ? error.message : 'Failed to create Duffel order',
        },
        HttpStatus.BAD_GATEWAY,
      );
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  async createCancellationQuote(duffelOrderId: string): Promise<unknown> {
    return this.meteredCall(
      () => this.duffel.orderCancellations.create({ order_id: duffelOrderId }),
      'UPSTREAM_CANCELLATION_QUOTE_FAILED',
      'Failed to create cancellation quote',
    );
  }

  async confirmCancellationQuote(quoteId: string): Promise<unknown> {
    const result = await this.meteredCall(
      () => this.duffel.orderCancellations.confirm(quoteId),
      'UPSTREAM_CANCELLATION_CONFIRM_FAILED',
      'Failed to confirm Duffel cancellation quote',
    );
    const cancellation = this.requireRecord(
      result,
      'UPSTREAM_CANCELLATION_CONFIRM_FAILED',
      'Invalid Duffel cancellation response',
    );
    const confirmedAt = this.nullableString(cancellation.confirmed_at) ?? null;
    const refundAmount = this.nullableString(cancellation.refund_amount);
    return {
      id: this.requireString(
        cancellation.id,
        'UPSTREAM_CANCELLATION_CONFIRM_FAILED',
        'Invalid Duffel cancellation response',
      ),
      order_id: this.requireString(
        cancellation.order_id,
        'UPSTREAM_CANCELLATION_CONFIRM_FAILED',
        'Invalid Duffel cancellation response',
      ),
      status: confirmedAt ? 'CONFIRMED' : 'PENDING',
      refund_amount: refundAmount,
      refund_currency: this.nullableString(cancellation.refund_currency),
      refundable:
        refundAmount !== null && refundAmount !== undefined && Number(refundAmount) > 0,
      confirmed_at: confirmedAt,
    };
  }

  async cancelOrder(duffelOrderId: string): Promise<unknown> {
    const quote = await this.meteredCall(
      () => this.duffel.orderCancellations.create({ order_id: duffelOrderId }),
      'UPSTREAM_CANCELLATION_QUOTE_FAILED',
      'Failed to create cancellation quote',
    );
    const quoteRecord = this.requireRecord(
      quote,
      'UPSTREAM_CANCELLATION_QUOTE_FAILED',
      'Invalid Duffel cancellation quote',
    );
    const quoteId = this.requireString(
      quoteRecord.id,
      'UPSTREAM_CANCELLATION_QUOTE_FAILED',
      'Invalid Duffel cancellation quote',
    );
    return this.meteredCall(
      () => this.duffel.orderCancellations.confirm(quoteId),
      'UPSTREAM_CANCELLATION_CONFIRM_FAILED',
      'Failed to confirm Duffel cancellation quote',
    );
  }

  async retrieveOrder(
    duffelOrderId: string,
  ): Promise<{
    id: string;
    order_id: string;
    status: 'ACTIVE' | 'CANCELLED';
    cancelled_at: string | null;
    cancellation_id: string | null;
  }> {
    const result = await this.meteredCall(
      () => this.duffel.orders.get(duffelOrderId),
      'UPSTREAM_ORDER_RETRIEVAL_FAILED',
      'Failed to retrieve Duffel order',
    );
    const order = this.requireRecord(
      result,
      'UPSTREAM_ORDER_RETRIEVAL_FAILED',
      'Invalid Duffel order response',
    );
    const orderId = this.requireString(
      order.id,
      'UPSTREAM_ORDER_RETRIEVAL_FAILED',
      'Invalid Duffel order response',
    );
    const cancellation = this.isRecord(order.cancellation) ? order.cancellation : undefined;
    const cancelledAt = this.nullableString(order.cancelled_at) ?? null;
    const confirmedAt = this.nullableString(cancellation?.confirmed_at);

    return {
      id: orderId,
      order_id: orderId,
      status: cancelledAt !== null || confirmedAt != null ? 'CANCELLED' : 'ACTIVE',
      cancelled_at: cancelledAt,
      cancellation_id: this.nullableString(cancellation?.id) ?? null,
    };
  }

  async retrieveCompleteOrder(duffelOrderId: string): Promise<unknown> {
    const result = await this.meteredCall(
      () => this.duffel.orders.get(duffelOrderId),
      'UPSTREAM_ORDER_RETRIEVAL_FAILED',
      'Failed to retrieve Duffel order',
    );
    return this.requireRecord(
      result,
      'UPSTREAM_ORDER_RETRIEVAL_FAILED',
      'Invalid Duffel order response',
    );
  }

  private async reserveAttempt(): Promise<void> {
    const result: BudgetReservationResult = await this.rateBudgetService.reserveAttempt();
    if (!result.ok) {
      if (result.error === 'UNAVAILABLE') {
        throw new HttpException(
          {
            message: 'Duffel rate budget store temporarily unavailable',
            code: 'BUDGET_UNAVAILABLE',
            retryAfterSeconds: result.retryAfterSeconds,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw new HttpException(
        {
          message: 'Daily Duffel API rate limit exceeded',
          code: 'RATE_LIMIT_EXCEEDED',
          retryAfterSeconds: result.retryAfterSeconds,
          resetAt: result.resetAt,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async meteredCall(
    call: () => Promise<{ data: unknown }>,
    code: string,
    fallbackMessage: string,
  ): Promise<unknown> {
    try {
      await this.reserveAttempt();
      const response = await call();
      return response.data;
    } catch (error: unknown) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        {
          code,
          message: fallbackMessage,
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  private requireRecord(
    value: unknown,
    code: string,
    message: string,
  ): Record<string, unknown> {
    if (this.isRecord(value)) {
      return value;
    }
    throw new HttpException({ code, message }, HttpStatus.BAD_GATEWAY);
  }

  private requireString(value: unknown, code: string, message: string): string {
    if (typeof value === 'string') {
      return value;
    }
    throw new HttpException({ code, message }, HttpStatus.BAD_GATEWAY);
  }

  private nullableString(value: unknown): string | null | undefined {
    return typeof value === 'string' || value === null ? value : undefined;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private hasErrors(value: unknown): boolean {
    return this.isRecord(value) && Boolean(value.errors);
  }

  private errorMessage(value: unknown): string {
    if (!this.isRecord(value)) {
      return 'Failed to create Duffel order';
    }
    const errors = value.errors;
    if (Array.isArray(errors)) {
      const firstError = errors[0];
      if (this.isRecord(firstError) && typeof firstError.message === 'string') {
        return firstError.message;
      }
    }
    return 'Failed to create Duffel order';
  }

  private statusOf(value: unknown): number | undefined {
    return this.isRecord(value) && typeof value.status === 'number' ? value.status : undefined;
  }
}
