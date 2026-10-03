import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type Product } from '@prisma/client';
import {
  type AdminProductDetailView,
  type AdminProductListItemView,
  type AdminProductQuery,
  type CreateProductInput,
  type Garment3DView,
  GENDERS,
  type Gender,
  type Paginated,
  type ProductDetailView,
  type ProductListItemView,
  type ProductQuery,
  type ProductType,
  type ProductVariantView,
  type UpdateProductInput,
} from '@zed/contracts';
import { PrismaService } from '../prisma/prisma.service';
import sharp from 'sharp';
import { contentHash, StorageKeys, StorageService } from '../storage/storage.service';
import { InventoryService } from '../inventory/inventory.service';
import { TRY_ON_PRODUCT_TYPES, tryOnGarmentKey } from './try-on.service';

export const AVATAR_IDS: Record<Gender, string> = { MALE: 'default', FEMALE: 'female' };

export const DEFAULT_AVATAR_ID = AVATAR_IDS.MALE;

const RPM_AVATAR_FILENAME = 'avatar-default.glb';

const GARMENT_LIBRARY_BODY_DIR = { FEMALE: 'female' } as const;

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async list(query: ProductQuery): Promise<Paginated<ProductListItemView>> {
    const where: Prisma.ProductWhereInput = {
      isPublished: true,
      ...(query.productType ? { productType: query.productType } : {}),
      ...(query.gender ? { gender: query.gender } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.size ? { availableSizes: { has: query.size } } : {}),
      ...(query.minPriceMinor !== undefined || query.maxPriceMinor !== undefined
        ? {
            basePriceMinor: {
              ...(query.minPriceMinor !== undefined ? { gte: query.minPriceMinor } : {}),
              ...(query.maxPriceMinor !== undefined ? { lte: query.maxPriceMinor } : {}),
            },
          }
        : {}),
      ...(query.search
        ? { name: { contains: query.search, mode: 'insensitive' as const } }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        include: { variants: { where: { isPublished: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
      }),
      this.prisma.product.count({ where }),
    ]);

    const items = await Promise.all(rows.map((product) => this.toListItem(product)));

    return {
      items,
      page: query.page,
      perPage: query.perPage,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.perPage)),
    };
  }

  async getBySlug(slug: string): Promise<ProductDetailView> {
    const product = await this.prisma.product.findUnique({
      where: { slug },
      include: {
        variants: { where: { isPublished: true } },
        garment3D: { select: { sourceKeys: true } },
      },
    });
    if (!product || !product.isPublished) throw new NotFoundException('Product not found');

    const [inStockSizes, listItem, garment3D, imageUrls, avatarModelUrls] = await Promise.all([
      product.fulfillmentType === 'MADE_TO_ORDER'
        ? product.availableSizes
        : this.aggregateInStockSizes(product.id),
      this.toListItem(product),
      this.getGarment3D(product.id),
      this.resolveImageUrls(product.imageKeys),
      product.garment3D ? this.resolveAvatarUrls() : null,
    ]);

    return {
      ...listItem,
      description: product.description,
      careInstructions: product.careInstructions,
      materials: product.materials,
      inStockSizes,
      imageUrls,
      garment3D,
      avatarModelUrls: garment3D ? avatarModelUrls : null,
      tryOnAvailable:
        TRY_ON_PRODUCT_TYPES.has(product.productType) && tryOnGarmentKey(product) !== null,
    };
  }

  private async resolveAvatarUrls(): Promise<Record<Gender, string>> {
    const entries = await Promise.all(
      GENDERS.map(
        async (gender) =>
          [gender, await this.storage.resolveUrl(StorageKeys.avatarModel(AVATAR_IDS[gender]))] as const,
      ),
    );
    return Object.fromEntries(entries) as Record<Gender, string>;
  }

  private async getGarment3D(productId: string): Promise<Garment3DView | null> {
    const garment = await this.prisma.garment3D.findUnique({
      where: { productId },
      include: { measurements: true },
    });
    if (!garment) return null;

    const [modelUrl, textureUrl, previewUrl] = await this.storage.resolveUrls([
      garment.modelKey,
      garment.textureKey,
      garment.previewKey,
    ]);

    const fromLibrary = Boolean(
      garment.textureMeshSource && garment.textureMeshSource !== RPM_AVATAR_FILENAME,
    );
    const textureMeshUrl = fromLibrary
      ? await this.storage.resolveUrl(
          StorageKeys.garmentLibraryMesh(garment.textureMeshSource!),
        )
      : null;
    const textureMeshUrls = fromLibrary
      ? await this.resolveBodyMeshUrls(garment.textureMeshSource!)
      : null;

    return {
      id: garment.id,
      modelUrl,
      textureUrl,
      textureMeshUrl,
      textureMeshUrls,
      textureMeshName: fromLibrary ? garment.textureMeshName : null,
      previewUrl,
      generationStatus: garment.generationStatus,
      generationProvider: garment.generationProvider,
      confidenceScore: garment.confidenceScore,
      failureReason: garment.failureReason,
      measurements: garment.measurements.map((m) => ({
        size: m.size,
        chestCm: m.chestCm,
        waistCm: m.waistCm,
        shoulderCm: m.shoulderCm,
        lengthCm: m.lengthCm,
        sleeveLengthCm: m.sleeveLengthCm,
      })),
    };
  }

  private async resolveBodyMeshUrls(source: string): Promise<Record<Gender, string>> {
    const cut = source.replace(/^female\//, '');
    const [male, female] = await Promise.all([
      this.storage.resolveUrl(StorageKeys.garmentLibraryMesh(cut)),
      this.storage.resolveUrl(StorageKeys.garmentLibraryMesh(`${GARMENT_LIBRARY_BODY_DIR.FEMALE}/${cut}`)),
    ]);
    return { MALE: male!, FEMALE: female! };
  }

  private async aggregateInStockSizes(productId: string): Promise<string[]> {
    const rows = await this.prisma.inventoryItem.findMany({
      where: { productId, quantityAvailable: { gt: 0 } },
      select: { size: true },
      distinct: ['size'],
    });
    return rows.map((r) => r.size);
  }

  private async toListItem(
    product: Prisma.ProductGetPayload<{ include: { variants: true } }>,
  ): Promise<ProductListItemView> {
    const thumbnailUrl = await this.storage.resolveUrl(product.thumbnailKey);
    const variants = await Promise.all(product.variants.map((v) => this.toVariantView(v)));

    return {
      id: product.id,
      slug: product.slug,
      name: product.name,
      productType: product.productType as ProductType,
      category: product.category,
      gender: product.gender as Gender,
      basePriceMinor: product.basePriceMinor,
      currency: product.currency,
      thumbnailUrl,
      availableSizes: product.availableSizes,
      fulfillmentType: product.fulfillmentType,
      variants,
    };
  }

  private async toVariantView(variant: {
    id: string;
    name: string;
    colorName: string;
    colorHex: string;
    patternName: string | null;
    thumbnailKey: string | null;
    priceDeltaMinor: number;
  }): Promise<ProductVariantView> {
    const thumbnailUrl = await this.storage.resolveUrl(variant.thumbnailKey);
    return {
      id: variant.id,
      name: variant.name,
      colorName: variant.colorName,
      colorHex: variant.colorHex,
      patternName: variant.patternName,
      thumbnailUrl,
      priceDeltaMinor: variant.priceDeltaMinor,
    };
  }

  async getForAdmin(productId: string): Promise<AdminProductDetailView> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      include: { variants: true },
    });
    if (!product) throw new NotFoundException('Product not found');
    return this.toAdminDetailView(product);
  }

  async listForAdmin(query: AdminProductQuery): Promise<Paginated<AdminProductListItemView>> {
    const where: Prisma.ProductWhereInput = query.search
      ? { name: { contains: query.search, mode: 'insensitive' as const } }
      : {};

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
      }),
      this.prisma.product.count({ where }),
    ]);

    const items = await Promise.all(rows.map((product) => this.toAdminListItem(product)));

    return {
      items,
      page: query.page,
      perPage: query.perPage,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.perPage)),
    };
  }

  async updateProduct(productId: string, input: UpdateProductInput): Promise<AdminProductDetailView> {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Product not found');

    if (input.slug && input.slug !== product.slug) {
      const existing = await this.prisma.product.findUnique({ where: { slug: input.slug } });
      if (existing) throw new BadRequestException(`Slug "${input.slug}" is already in use`);
    }

    const updated = await this.prisma.product.update({
      where: { id: productId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.productType !== undefined ? { productType: input.productType } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.gender !== undefined ? { gender: input.gender } : {}),
        ...(input.basePriceMinor !== undefined ? { basePriceMinor: input.basePriceMinor } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.availableSizes !== undefined ? { availableSizes: input.availableSizes } : {}),
        ...(input.fulfillmentType !== undefined ? { fulfillmentType: input.fulfillmentType } : {}),
        ...(input.materials !== undefined ? { materials: input.materials } : {}),
        ...(input.careInstructions !== undefined ? { careInstructions: input.careInstructions } : {}),
        ...(input.easeOverride !== undefined ? { easeOverride: input.easeOverride as never } : {}),
        ...(input.weightGrams !== undefined ? { weightGrams: input.weightGrams } : {}),
        ...(input.isPublished !== undefined ? { isPublished: input.isPublished } : {}),
      },
      include: { variants: true },
    });

    this.logger.log(`Updated product ${updated.id} (${updated.slug})`);
    return this.toAdminDetailView(updated);
  }

  private async toAdminListItem(product: Product): Promise<AdminProductListItemView> {
    const thumbnailUrl = await this.storage.resolveUrl(product.thumbnailKey);
    return {
      id: product.id,
      slug: product.slug,
      name: product.name,
      productType: product.productType as ProductType,
      category: product.category,
      gender: product.gender as Gender,
      basePriceMinor: product.basePriceMinor,
      currency: product.currency,
      thumbnailUrl,
      isPublished: product.isPublished,
      fulfillmentType: product.fulfillmentType,
      updatedAt: product.updatedAt.toISOString(),
    };
  }

  private async toAdminDetailView(
    product: Prisma.ProductGetPayload<{ include: { variants: true } }>,
  ): Promise<AdminProductDetailView> {
    const listItem = await this.toAdminListItem(product);
    const garment3D = await this.getGarment3D(product.id);
    const avatarModelUrls = garment3D ? await this.resolveAvatarUrls() : null;

    return {
      ...listItem,
      description: product.description,
      availableSizes: product.availableSizes,
      materials: product.materials,
      careInstructions: product.careInstructions,
      weightGrams: product.weightGrams,
      images: await this.resolveImages(product.imageKeys),
      variants: product.variants.map((v) => ({
        id: v.id,
        name: v.name,
        colorName: v.colorName,
        colorHex: v.colorHex,
        patternName: v.patternName,
        priceDeltaMinor: v.priceDeltaMinor,
        isPublished: v.isPublished,
      })),
      garment3D,
      avatarModelUrls,
    };
  }

  async createProduct(input: CreateProductInput) {
    const existing = await this.prisma.product.findUnique({ where: { slug: input.slug } });
    if (existing) throw new BadRequestException(`Slug "${input.slug}" is already in use`);

    const product = await this.prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          name: input.name,
          slug: input.slug,
          description: input.description,
          productType: input.productType,
          category: input.category,
          gender: input.gender,
          basePriceMinor: input.basePriceMinor,
          currency: input.currency,
          availableSizes: input.availableSizes,
          fulfillmentType: input.fulfillmentType,
          materials: input.materials,
          careInstructions: input.careInstructions,
          easeOverride: input.easeOverride as never,
          weightGrams: input.weightGrams,
          isPublished: false,
        },
      });

      const variant = await tx.productVariant.create({
        data: {
          productId: created.id,
          name: 'Default',
          colorName: 'Default',
          colorHex: '#111111',
          isPublished: true,
        },
      });

      if (input.fulfillmentType === 'STOCKED') {
        for (const size of input.availableSizes) {
          await tx.inventoryItem.create({
            data: {
              sku: InventoryService.buildSku(created.slug, variant.id, size),
              productId: created.id,
              variantId: variant.id,
              size,
              quantityAvailable: 0,
              reorderThreshold: 3,
            },
          });
        }
      }

      return created;
    });

    this.logger.log(`Created product ${product.id} (${product.slug})`);
    return product;
  }

  async createVariant(
    productId: string,
    input: { name: string; colorName: string; colorHex: string; patternName?: string; priceDeltaMinor?: number },
  ) {
    const product = await this.prisma.product.findUniqueOrThrow({ where: { id: productId } });

    const variant = await this.prisma.$transaction(async (tx) => {
      const created = await tx.productVariant.create({
        data: {
          productId,
          name: input.name,
          colorName: input.colorName,
          colorHex: input.colorHex,
          patternName: input.patternName,
          priceDeltaMinor: input.priceDeltaMinor ?? 0,
          isPublished: false,
        },
      });

      if (product.fulfillmentType === 'STOCKED') {
        for (const size of product.availableSizes) {
          await tx.inventoryItem.create({
            data: {
              sku: InventoryService.buildSku(product.slug, created.id, size),
              productId,
              variantId: created.id,
              size,
              quantityAvailable: 0,
              reorderThreshold: 3,
            },
          });
        }
      }

      return created;
    });

    return variant;
  }

  async deleteProduct(productId: string): Promise<{ id: string }> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      include: { variants: true, garment3D: true },
    });
    if (!product) throw new NotFoundException('Product not found');

    const orderedCount = await this.prisma.orderItem.count({ where: { productId } });
    if (orderedCount > 0) {
      throw new BadRequestException(
        `Product appears on ${orderedCount} order item(s) and cannot be deleted. Hide it instead.`,
      );
    }

    const storageKeys = [
      product.thumbnailKey,
      ...product.imageKeys,
      ...product.variants.map((v) => v.thumbnailKey),
      product.garment3D?.modelKey,
      product.garment3D?.textureKey,
      product.garment3D?.previewKey,
      ...(product.garment3D?.sourceKeys ?? []),
    ].filter((key): key is string => Boolean(key));

    await this.prisma.product.delete({ where: { id: productId } });
    this.logger.log(
      `Deleted product ${product.id} (${product.slug})` +
        (product.garment3D ? ` and its 3D garment ${product.garment3D.id}` : ''),
    );

    for (const key of storageKeys) {
      try {
        await this.storage.delete(key);
      } catch (err) {
        this.logger.warn(`Failed to delete storage object ${key}: ${(err as Error).message}`);
      }
    }

    return { id: product.id };
  }

  private async resolveImages(keys: string[]): Promise<{ key: string; url: string }[]> {
    const urls = await this.storage.resolveUrls(keys);
    return keys.map((key, i) => ({ key, url: urls[i] ?? '' }));
  }

  private async resolveImageUrls(keys: string[]): Promise<string[]> {
    return (await this.resolveImages(keys)).map((image) => image.url).filter(Boolean);
  }

  async addImages(productId: string, files: { buffer: Buffer }[]): Promise<AdminProductDetailView> {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Product not found');

    const newKeys: string[] = [];
    for (const file of files) {
      let webp: Buffer;
      try {
        webp = await sharp(file.buffer)
          .rotate()
          .resize(1200, 1600, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 85 })
          .toBuffer();
      } catch {
        throw new BadRequestException('Uploaded file is not a valid image');
      }
      const key = StorageKeys.productImage(productId, contentHash(webp));
      await this.storage.put({ key, body: webp, contentType: 'image/webp' });
      if (!product.imageKeys.includes(key) && !newKeys.includes(key)) newKeys.push(key);
    }

    return this.saveImageKeys(product, [...product.imageKeys, ...newKeys]);
  }

  async removeImage(productId: string, key: string): Promise<AdminProductDetailView> {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Product not found');
    if (!product.imageKeys.includes(key)) throw new NotFoundException('Image not found');

    const result = await this.saveImageKeys(
      product,
      product.imageKeys.filter((k) => k !== key),
    );
    try {
      await this.storage.delete(key);
    } catch (err) {
      this.logger.warn(`Failed to delete storage object ${key}: ${(err as Error).message}`);
    }
    return result;
  }

  private async saveImageKeys(product: Product, imageKeys: string[]): Promise<AdminProductDetailView> {
    const updated = await this.prisma.product.update({
      where: { id: product.id },
      data: { imageKeys, thumbnailKey: imageKeys[0] ?? null },
      include: { variants: true },
    });
    return this.toAdminDetailView(updated);
  }

  async publishProduct(productId: string, published: boolean) {
    return this.prisma.product.update({
      where: { id: productId },
      data: { isPublished: published },
    });
  }

  async publishVariant(variantId: string, published: boolean) {
    return this.prisma.productVariant.update({
      where: { id: variantId },
      data: { isPublished: published },
    });
  }
}
