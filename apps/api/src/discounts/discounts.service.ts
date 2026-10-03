import { BadRequestException, Injectable } from '@nestjs/common';
import { customAlphabet } from 'nanoid';
import type { Prisma } from '@prisma/client';
import type { ProductType } from '@zed/contracts';
import { PrismaService } from '../prisma/prisma.service';

const CODE_SUFFIX = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

const PERCENT_OFF = 10;
const VALID_DAYS = 7;

export interface DiscountableLine {
  productType: ProductType;
  quantity: number;
  unitPriceMinor: number;
}

@Injectable()
export class DiscountsService {
  constructor(private readonly prisma: PrismaService) {}

  async claim(productType: ProductType) {
    const code = `${productType.slice(0, 4)}-${CODE_SUFFIX()}`;
    const expiresAt = new Date(Date.now() + VALID_DAYS * 86_400_000);

    const discount = await this.prisma.discount.create({
      data: { code, productType, percentOff: PERCENT_OFF, expiresAt },
    });

    return {
      code: discount.code,
      productType: discount.productType,
      percentOff: discount.percentOff,
      expiresAt: discount.expiresAt.toISOString(),
    };
  }

  async priceDiscount(
    code: string,
    lines: DiscountableLine[],
  ): Promise<{ discountId: string; discountMinor: number }> {
    const discount = await this.prisma.discount.findUnique({ where: { code } });

    if (!discount || !discount.isActive || discount.usedAt) {
      throw new BadRequestException('That discount code is not valid');
    }
    if (discount.expiresAt < new Date()) {
      throw new BadRequestException('That discount code has expired');
    }

    const eligibleMinor = lines
      .filter((line) => !discount.productType || line.productType === discount.productType)
      .reduce((sum, line) => sum + line.unitPriceMinor * line.quantity, 0);

    if (eligibleMinor === 0) {
      throw new BadRequestException(
        `${code} only applies to ${discount.productType?.toLowerCase().replace('_', ' ')} items`,
      );
    }

    return {
      discountId: discount.id,
      discountMinor: Math.floor((eligibleMinor * discount.percentOff) / 100),
    };
  }

  async markUsed(
    discountId: string,
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.prisma;
    await client.discount.update({
      where: { id: discountId },
      data: { usedAt: new Date(), usedByUserId: userId, isActive: false },
    });
  }
}
