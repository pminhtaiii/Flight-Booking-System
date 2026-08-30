import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { StripeService } from '@/common/stripe.service';

@Injectable()
export class PaymentMethodService {
  private readonly logger = new Logger(PaymentMethodService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
  ) {}

  async listMethods(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { stripeCustomerId: true },
    });

    const methods = await this.prisma.paymentMethod.findMany({
      where: { userId },
      select: {
        id: true,
        stripePaymentMethodId: true,
        cardBrand: true,
        cardLast4: true,
        isDefault: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      methods,
      hasStripeCustomer: !!user?.stripeCustomerId,
    };
  }

  async saveMethod(userId: string, stripeCustomerId: string, stripePaymentIntentId: string) {
    const paymentIntent = await this.stripeService.retrievePaymentIntent(stripePaymentIntentId);

    const savedWithConsent = paymentIntent.setup_future_usage === 'off_session';
    if (!savedWithConsent) {
      this.logger.warn(
        `PaymentIntent ${stripePaymentIntentId} was not approved for future use; skipping payment method save`,
      );
      return;
    }

    const paymentMethodId =
      typeof paymentIntent.payment_method === 'string'
        ? paymentIntent.payment_method
        : paymentIntent.payment_method?.id;

    if (!paymentMethodId) {
      this.logger.warn(`No payment method attached to PaymentIntent ${stripePaymentIntentId}`);
      return;
    }

    const alreadySaved = await this.prisma.paymentMethod.findUnique({
      where: { stripePaymentMethodId: paymentMethodId },
    });

    if (alreadySaved) {
      return alreadySaved;
    }

    let cardBrand: string | null = null;
    let cardLast4: string | null = null;
    if (
      paymentIntent.payment_method &&
      typeof paymentIntent.payment_method !== 'string' &&
      paymentIntent.payment_method.card
    ) {
      cardBrand = paymentIntent.payment_method.card.brand ?? null;
      cardLast4 = paymentIntent.payment_method.card.last4 ?? null;
    }

    return this.prisma.paymentMethod.create({
      data: {
        userId,
        stripeCustomerId,
        stripePaymentMethodId: paymentMethodId,
        cardBrand,
        cardLast4,
        savedWithConsent,
      },
    });
  }

  async deleteMethod(methodId: string, userId: string) {
    const method = await this.prisma.paymentMethod.findUnique({
      where: { id: methodId },
    });

    if (!method) {
      throw new NotFoundException('Payment method not found');
    }

    if (method.userId !== userId) {
      throw new ForbiddenException('You do not own this payment method');
    }

    try {
      await this.stripeService.detachPaymentMethod(method.stripePaymentMethodId);
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to detach Stripe payment method ${method.stripePaymentMethodId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await this.prisma.paymentMethod.delete({ where: { id: methodId } });
  }

  async setDefault(methodId: string, userId: string) {
    const method = await this.prisma.paymentMethod.findUnique({
      where: { id: methodId },
    });

    if (!method) {
      throw new NotFoundException('Payment method not found');
    }

    if (method.userId !== userId) {
      throw new ForbiddenException('You do not own this payment method');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.paymentMethod.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false },
      });

      await tx.paymentMethod.update({
        where: { id: methodId },
        data: { isDefault: true },
      });
    });
  }
}
