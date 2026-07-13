import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
  ParseUUIDPipe,
  BadRequestException,
  Delete,
  Patch,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { PaymentService } from './payment.service';
import { PaymentMethodService } from './payment-method.service';
import { PaymentRefundService } from './payment-refund.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { ConfirmPaymentDto } from './dto/confirm-payment.dto';
import { RefundPaymentDto } from './dto/refund-payment.dto';
import { IdempotencyKey } from './idempotency-key.decorator';
import { AdminGuard } from './admin.guard';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
  };
}

@Controller('payments')
@UseGuards(JwtAuthGuard)
export class PaymentController {
  constructor(
    private readonly paymentService: PaymentService,
    private readonly paymentMethodService: PaymentMethodService,
    private readonly paymentRefundService: PaymentRefundService
  ) {}

  @Post('create')
  async createPayment(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreatePaymentDto,
    @IdempotencyKey() idempotencyKey: string | null
  ) {
    if (!idempotencyKey || idempotencyKey.trim() === '') {
      throw new BadRequestException('Missing Idempotency-Key header');
    }
    return this.paymentService.createPayment(req.user.id, dto, idempotencyKey);
  }

  @Post('confirm')
  async confirmPayment(
    @Req() req: AuthenticatedRequest,
    @Body() dto: ConfirmPaymentDto,
    @IdempotencyKey() idempotencyKey: string | null,
    @Res({ passthrough: true }) res: Response
  ) {
    if (!idempotencyKey || idempotencyKey.trim() === '') {
      throw new BadRequestException('Missing Idempotency-Key header');
    }
    const result = await this.paymentService.confirmPayment(req.user.id, dto, idempotencyKey);
    if ('message' in result) {
      res.status(202);
    } else {
      res.status(200);
    }
    return result;
  }

  @Get('methods')
  async listMethods(@Req() req: AuthenticatedRequest) {
    return this.paymentMethodService.listMethods(req.user.id);
  }

  @Delete('methods/:methodId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteMethod(
    @Req() req: AuthenticatedRequest,
    @Param('methodId', new ParseUUIDPipe({ version: '4' })) methodId: string
  ) {
    return this.paymentMethodService.deleteMethod(methodId, req.user.id);
  }

  @Patch('methods/:methodId/default')
  @HttpCode(HttpStatus.OK)
  async setDefault(
    @Req() req: AuthenticatedRequest,
    @Param('methodId', new ParseUUIDPipe({ version: '4' })) methodId: string
  ) {
    await this.paymentMethodService.setDefault(methodId, req.user.id);
    return { success: true };
  }

  @Get(':paymentId/status')
  async getPaymentStatus(
    @Req() req: AuthenticatedRequest,
    @Param('paymentId', new ParseUUIDPipe({ version: '4' })) paymentId: string
  ) {
    return this.paymentService.getPaymentStatus(req.user.id, paymentId);
  }

  @Post(':paymentId/refund')
  @UseGuards(AdminGuard)
  async refundPayment(
    @Req() req: AuthenticatedRequest,
    @Param('paymentId', new ParseUUIDPipe({ version: '4' })) paymentId: string,
    @Body() dto: RefundPaymentDto,
    @IdempotencyKey() idempotencyKey: string | null
  ) {
    if (!idempotencyKey || idempotencyKey.trim() === '') {
      throw new BadRequestException('Missing Idempotency-Key header');
    }
    return this.paymentRefundService.initiateRefund(
      paymentId,
      dto.amount,
      dto.reason,
      'ADMIN',
      req.user.id,
      idempotencyKey
    );
  }
}
