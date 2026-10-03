import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type ClothingSize } from '@prisma/client';
import type { AddToCartInput, CartView, Currency } from '@zed/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { InventoryService } from '../inventory/inventory.service';
import type { CreateOrderLine } from '../orders/orders.service';

@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly inventory: InventoryService,
  ) {}

  async getOrCreate(userId: string) {
    const existing = await this.prisma.cart.findFirst({ where: { userId } });
    if (existing) return existing;
    return this.prisma.cart.create({ data: { userId } });
  }

  async add(userId: string, input: AddToCartInput): Promise<CartView> {
    const cart = await this.getOrCreate(userId);

    const product = await this.prisma.product.findUnique({
      where: { id: input.productId },
      include: { variants: true },
    });
    if (!product || !product.isPublished) throw new NotFoundException('Product not found');

    if (!product.availableSizes.includes(input.size as ClothingSize)) {
      throw new BadRequestException(`${product.name} is not made in size ${input.size}`);
    }

    const variant = input.variantId
      ? product.variants.find((v) => v.id === input.variantId)
      : product.variants.find((v) => v.isPublished);
    if (!variant) throw new BadRequestException('Unknown variant');

    const inStock = await this.inventory.availableSizes(product.id, variant.id);
    if (!inStock.includes(input.size as ClothingSize)) {
      throw new BadRequestException(`${product.name} is out of stock in size ${input.size}`);
    }

    const unitPriceMinor = product.basePriceMinor + variant.priceDeltaMinor;

    await this.prisma.cartItem.upsert({
      where: {
        cartId_productId_variantId_size: {
          cartId: cart.id,
          productId: product.id,
          variantId: variant.id,
          size: input.size as ClothingSize,
        },
      },
      create: {
        cartId: cart.id,
        productId: product.id,
        variantId: variant.id,
        size: input.size as ClothingSize,
        quantity: input.quantity,
        unitPriceMinor,
      },
      update: { quantity: { increment: input.quantity } },
    });

    return this.getView(userId);
  }

  async updateQuantity(userId: string, itemId: string, quantity: number): Promise<CartView> {
    const item = await this.prisma.cartItem.findFirst({
      where: { id: itemId, cart: { userId } },
    });
    if (!item) throw new NotFoundException('Cart item not found');

    if (quantity === 0) {
      await this.prisma.cartItem.delete({ where: { id: itemId } });
    } else {
      await this.prisma.cartItem.update({ where: { id: itemId }, data: { quantity } });
    }

    return this.getView(userId);
  }

  async remove(userId: string, itemId: string): Promise<CartView> {
    await this.prisma.cartItem.deleteMany({ where: { id: itemId, cart: { userId } } });
    return this.getView(userId);
  }

  async clear(userId: string): Promise<void> {
    const cart = await this.prisma.cart.findFirst({ where: { userId } });
    if (cart) await this.prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
  }

  async getView(userId: string): Promise<CartView> {
    const cart = await this.prisma.cart.findFirst({
      where: { userId },
      include: CART_INCLUDE,
    });

    if (!cart) {
      const created = await this.getOrCreate(userId);
      return {
        id: created.id,
        items: [],
        subtotalMinor: 0,
        currency: created.currency,
        itemCount: 0,
      };
    }

    const thumbnails = await this.storage.resolveUrls(
      cart.items.map((item) => cartItemImageKey(item)),
    );

    const availability = await Promise.all(
      cart.items.map((item) => this.inventory.availableSizes(item.productId, item.variantId)),
    );

    const items = cart.items.map((item, index) => ({
      id: item.id,
      productId: item.productId,
      productName: item.product.name,
      productSlug: item.product.slug,
      variantId: item.variantId,
      variantName: item.variant.name,
      size: item.size,
      quantity: item.quantity,
      unitPriceMinor: item.unitPriceMinor,
      lineTotalMinor: item.unitPriceMinor * item.quantity,
      thumbnailUrl: thumbnails[index],
      available: availability[index].includes(item.size),
    }));

    return {
      id: cart.id,
      items,
      subtotalMinor: items.reduce((sum, item) => sum + item.lineTotalMinor, 0),
      currency: cart.currency,
      itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    };
  }

  async getShippingSummary(userId: string): Promise<{
    weightGrams: number;
    subtotalMinor: number;
    currency: Currency;
    itemCount: number;
  }> {
    const cart = await this.prisma.cart.findFirst({
      where: { userId },
      include: CART_INCLUDE,
    });

    if (!cart || cart.items.length === 0) {
      return { weightGrams: 0, subtotalMinor: 0, currency: 'EUR', itemCount: 0 };
    }

    return {
      weightGrams: cart.items.reduce(
        (sum, item) => sum + item.product.weightGrams * item.quantity,
        0,
      ),
      subtotalMinor: cart.items.reduce(
        (sum, item) => sum + item.unitPriceMinor * item.quantity,
        0,
      ),
      currency: cart.currency,
      itemCount: cart.items.reduce((sum, item) => sum + item.quantity, 0),
    };
  }

  async toOrderLines(userId: string): Promise<{
    lines: CreateOrderLine[];
    subtotalMinor: number;
    currency: Currency;
  }> {
    const cart = await this.prisma.cart.findFirst({
      where: { userId },
      include: CART_INCLUDE,
    });

    if (!cart || cart.items.length === 0) {
      throw new BadRequestException('Cart is empty');
    }

    const lines: CreateOrderLine[] = [];

    for (const item of cart.items) {
      if (!item.product.isPublished || !item.variant.isPublished) {
        throw new BadRequestException(`${item.product.name} is no longer available`);
      }

      const currentPrice = item.product.basePriceMinor + item.variant.priceDeltaMinor;
      if (currentPrice !== item.unitPriceMinor) {
        throw new BadRequestException(
          `The price of ${item.product.name} has changed. Please review your cart.`,
        );
      }

      const inStock = await this.inventory.availableSizes(item.productId, item.variantId);
      if (!inStock.includes(item.size)) {
        throw new BadRequestException(`${item.product.name} (${item.size}) is out of stock`);
      }

      lines.push({
        productId: item.productId,
        variantId: item.variantId,
        productType: item.product.productType,
        size: item.size,
        quantity: item.quantity,
        unitPriceMinor: item.unitPriceMinor,
        productName: item.product.name,
        productSlug: item.product.slug,
        variantName: item.variant.name,
        sku: InventoryService.buildSku(item.product.slug, item.variantId, item.size),
        thumbnailKey: cartItemImageKey(item),
      });
    }

    return {
      lines,
      subtotalMinor: lines.reduce(
        (sum, line) => sum + line.unitPriceMinor * line.quantity,
        0,
      ),
      currency: cart.currency,
    };
  }
}

const CART_INCLUDE = {
  items: {
    include: { product: true, variant: true },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.CartInclude;

function cartItemImageKey(item: {
  variant: { thumbnailKey: string | null };
  product: { thumbnailKey: string | null; imageKeys: string[] };
}): string | null {
  return item.variant.thumbnailKey ?? item.product.thumbnailKey ?? item.product.imageKeys[0] ?? null;
}
