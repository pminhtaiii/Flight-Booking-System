import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { StripeService } from '@/common/stripe.service';
import { PaymentMethodStatus } from '@prisma/client';

@Injectable()
export class PaymentMethodService {
  private readonly logger = new Logger(PaymentMethodService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
  ) {}

  /**
   * Lists active, saved payment methods for a user.
   */
  async listMethods(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { stripeCustomerId: true },
    });

    if (!user) {
      throw new NotFoundException({
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    }

    const methods = await this.prisma.paymentMethod.findMany({
      where: {
        userId,
        status: PaymentMethodStatus.ACTIVE,
        savedWithConsent: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      methods: methods.map((m) => ({
        id: m.id,
        stripePaymentMethodId: m.stripePaymentMethodId,
        cardBrand: m.cardBrand,
        cardLast4: m.cardLast4,
        isDefault: m.isDefault,
        expMonth: m.expMonth,
        expYear: m.expYear,
      })),
      hasStripeCustomer: !!user.stripeCustomerId,
    };
  }

  /**
   * Detaches a payment method from the customer in Stripe and soft-deletes it locally.
   */
  async deleteMethod(methodId: string, userId: string): Promise<void> {
    const method = await this.prisma.paymentMethod.findUnique({
      where: { id: methodId },
    });

    if (!method) {
      throw new NotFoundException({
        code: 'PAYMENT_METHOD_NOT_FOUND',
        message: 'Payment method not found',
      });
    }

    if (method.userId !== userId) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Access denied',
      });
    }

    try {
      await this.stripeService.detachPaymentMethod(method.stripePaymentMethodId);
    } catch (error: any) {
      this.logger.warn(`Failed to detach payment method ${method.stripePaymentMethodId} from Stripe: ${error.message}`);
    }

    await this.prisma.paymentMethod.update({
      where: { id: methodId },
      data: {
        status: PaymentMethodStatus.DETACHED,
        isDefault: false,
      },
    });
  }

  /**
   * Sets a payment method as default and clears defaults on all others.
   */
  async setDefault(methodId: string, userId: string): Promise<void> {
    const method = await this.prisma.paymentMethod.findUnique({
      where: { id: methodId },
    });

    if (!method) {
      throw new NotFoundException({
        code: 'PAYMENT_METHOD_NOT_FOUND',
        message: 'Payment method not found',
      });
    }

    if (method.userId !== userId) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Access denied',
      });
    }

    if (method.status !== PaymentMethodStatus.ACTIVE) {
      throw new BadRequestException({
        code: 'PAYMENT_METHOD_INACTIVE',
        message: 'Cannot set an inactive payment method as default',
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.paymentMethod.updateMany({
        where: { userId, id: { not: methodId } },
        data: { isDefault: false },
      });

      await tx.paymentMethod.update({
        where: { id: methodId },
        data: { isDefault: true },
      });
    });
  }

  /**
   * Syncs/saves the payment method used in a successful PaymentIntent if saveCard was requested.
   */
  async syncPaymentMethod(paymentId: string): Promise<void> {
    try {
      const payment = await this.prisma.payment.findUnique({
        where: { id: paymentId },
        include: { idempotencyKey: true },
      });

      if (!payment) {
        return;
      }

      const requestParams = payment.idempotencyKey?.requestParams as any;
      if (!requestParams || !requestParams.saveCard) {
        return;
      }

      const bookingIntent = await this.prisma.bookingIntent.findUnique({
        where: { id: payment.bookingIntentId },
      });

      if (!bookingIntent) {
        return;
      }

      const userId = bookingIntent.userId;

      // Retrieve the PaymentIntent from Stripe to get the payment method ID
      const stripeIntent = await this.stripeService.retrievePaymentIntent(
        payment.stripePaymentIntentId
      );

      const stripePaymentMethodId =
        typeof stripeIntent.payment_method === 'string'
          ? stripeIntent.payment_method
          : stripeIntent.payment_method?.id;

      if (!stripePaymentMethodId) {
        this.logger.warn(`No payment method found on Stripe PaymentIntent ${payment.stripePaymentIntentId}`);
        return;
      }

      // Retrieve the PaymentMethod from Stripe to get card details
      const stripeMethod = await this.stripeService.retrievePaymentMethod(stripePaymentMethodId);

      if (stripeMethod.type !== 'card' || !stripeMethod.card) {
        this.logger.warn(`Stripe payment method ${stripePaymentMethodId} is not a card`);
        return;
      }

      // Fetch or lazy-create Stripe customer ID
      let stripeCustomerId = payment.stripeCustomerId;
      if (!stripeCustomerId) {
        const user = await this.prisma.user.findUnique({
          where: { id: userId },
        });
        stripeCustomerId = user?.stripeCustomerId || null;
      }

      if (!stripeCustomerId) {
        this.logger.warn(`No stripeCustomerId found for user ${userId}`);
        return;
      }

      // Check if this payment method already exists for the user
      const existing = await this.prisma.paymentMethod.findUnique({
        where: { stripePaymentMethodId },
      });

      if (existing) {
        if (existing.status !== PaymentMethodStatus.ACTIVE || !existing.savedWithConsent) {
          await this.prisma.paymentMethod.update({
            where: { id: existing.id },
            data: {
              status: PaymentMethodStatus.ACTIVE,
              savedWithConsent: true,
            },
          });
        }
        return;
      }

      const activeCount = await this.prisma.paymentMethod.count({
        where: {
          userId,
          status: PaymentMethodStatus.ACTIVE,
        },
      });

      await this.prisma.paymentMethod.create({
        data: {
          userId,
          stripeCustomerId,
          stripePaymentMethodId,
          cardBrand: stripeMethod.card.brand,
          cardLast4: stripeMethod.card.last4,
          expMonth: stripeMethod.card.exp_month,
          expYear: stripeMethod.card.exp_year,
          savedWithConsent: true,
          status: PaymentMethodStatus.ACTIVE,
          isDefault: activeCount === 0,
        },
      });

      this.logger.log(`Successfully saved payment method ${stripePaymentMethodId} for user ${userId}`);
    } catch (error: any) {
      this.logger.error(`Failed to sync payment method for payment ${paymentId}: ${error.message}`, error.stack);
    }
  }
}
