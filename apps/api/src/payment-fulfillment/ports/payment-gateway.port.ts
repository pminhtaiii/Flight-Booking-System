/**
 * Payment Gateway Port
 *
 * Provider-blind port defining normalized payment gateway contract.
 * Dependency-free: no NestJS modules, no external SDK types, strictly no any.
 */

export interface PortInvocationControl {
  beforeInvoke: () => Promise<void>;
}

export const PAYMENT_GATEWAY_PORT = Symbol('PaymentGatewayPort');

export type PaymentAuthorizationStatus =
  | 'authorized'
  | 'captured'
  | 'voided'
  | 'nonfinal'
  | 'invalid';

export interface AuthorizeHoldOutcome {
  status: PaymentAuthorizationStatus;
  intentId: string;
  amount?: number;
  currency?: string;
  rawStatus?: string;
}

export interface CapturePaymentOutcome {
  success: boolean;
  intentId: string;
  status: string;
  capturedAmount?: number;
  currency?: string;
}

export interface VoidHoldOutcome {
  success: boolean;
  intentId: string;
  status: string;
}

export interface PaymentGatewayPort {
  authorizeHold(intentId: string, control: PortInvocationControl): Promise<AuthorizeHoldOutcome>;
  capturePayment(
    intentId: string,
    captureKey: string,
    control: PortInvocationControl,
  ): Promise<CapturePaymentOutcome>;
  voidHold(intentId: string, control: PortInvocationControl): Promise<VoidHoldOutcome>;
}
