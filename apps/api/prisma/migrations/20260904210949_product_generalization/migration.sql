-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('DRESS', 'T_SHIRT', 'SHORTS', 'LONG_SLEEVE');

-- CreateEnum
CREATE TYPE "ProductCategory" AS ENUM ('BODYCON', 'A_LINE', 'WRAP', 'MAXI', 'SLIP', 'BALL_GOWN', 'SHIFT', 'CREW_NECK', 'V_NECK', 'GRAPHIC', 'HENLEY', 'WAFFLE_KNIT', 'BUTTON_UP', 'CHINO', 'DENIM', 'ATHLETIC');

-- CreateEnum
CREATE TYPE "ClothingSize" AS ENUM ('XS', 'S', 'M', 'L', 'XL', 'XXL');

-- DropForeignKey
ALTER TABLE "cart_items" DROP CONSTRAINT "cart_items_dressId_fkey";

-- DropForeignKey
ALTER TABLE "cart_items" DROP CONSTRAINT "cart_items_variantId_fkey";

-- DropForeignKey
ALTER TABLE "dress_variants" DROP CONSTRAINT "dress_variants_dressId_fkey";

-- DropForeignKey
ALTER TABLE "fitted_assets" DROP CONSTRAINT "fitted_assets_dressId_fkey";

-- DropForeignKey
ALTER TABLE "fitted_assets" DROP CONSTRAINT "fitted_assets_variantId_fkey";

-- DropForeignKey
ALTER TABLE "inventory" DROP CONSTRAINT "inventory_dressId_fkey";

-- DropForeignKey
ALTER TABLE "inventory" DROP CONSTRAINT "inventory_variantId_fkey";

-- DropForeignKey
ALTER TABLE "order_items" DROP CONSTRAINT "order_items_dressId_fkey";

-- DropForeignKey
ALTER TABLE "order_items" DROP CONSTRAINT "order_items_variantId_fkey";

-- DropIndex
DROP INDEX "cart_items_cartId_dressId_variantId_size_key";

-- DropIndex
DROP INDEX "fitted_assets_dressId_variantId_size_shapeFingerprint_key";

-- DropIndex
DROP INDEX "inventory_dressId_variantId_size_key";

-- AlterTable
ALTER TABLE "cart_items" DROP COLUMN "dressId",
ADD COLUMN     "productId" UUID NOT NULL,
DROP COLUMN "size",
ADD COLUMN     "size" "ClothingSize" NOT NULL;

-- AlterTable
ALTER TABLE "fitted_assets" DROP COLUMN "dressId",
ADD COLUMN     "productId" UUID NOT NULL,
DROP COLUMN "size",
ADD COLUMN     "size" "ClothingSize" NOT NULL;

-- AlterTable
ALTER TABLE "inventory" DROP COLUMN "dressId",
ADD COLUMN     "productId" UUID NOT NULL,
DROP COLUMN "size",
ADD COLUMN     "size" "ClothingSize" NOT NULL;

-- AlterTable
ALTER TABLE "order_items" DROP COLUMN "dressId",
DROP COLUMN "dressName",
DROP COLUMN "dressSlug",
ADD COLUMN     "productId" UUID NOT NULL,
ADD COLUMN     "productName" TEXT NOT NULL,
ADD COLUMN     "productSlug" TEXT NOT NULL,
DROP COLUMN "size",
ADD COLUMN     "size" "ClothingSize" NOT NULL;

-- DropTable
DROP TABLE "dress_variants";

-- DropTable
DROP TABLE "dresses";

-- DropEnum
DROP TYPE "DressCategory";

-- DropEnum
DROP TYPE "DressSize";

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "productType" "ProductType" NOT NULL,
    "category" "ProductCategory" NOT NULL,
    "gender" "Gender" NOT NULL,
    "basePriceMinor" INTEGER NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'BGN',
    "baseModelKey" TEXT,
    "thumbnailKey" TEXT,
    "availableSizes" "ClothingSize"[],
    "fulfillmentType" "FulfillmentType" NOT NULL DEFAULT 'STOCKED',
    "materials" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "careInstructions" TEXT,
    "easeOverride" JSONB,
    "weightGrams" INTEGER NOT NULL DEFAULT 500,
    "modelStatus" "AssetJobStatus" NOT NULL DEFAULT 'PENDING',
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variants" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "colorName" TEXT NOT NULL,
    "colorHex" TEXT NOT NULL,
    "patternName" TEXT,
    "textureKey" TEXT,
    "modelKey" TEXT,
    "thumbnailKey" TEXT,
    "priceDeltaMinor" INTEGER NOT NULL DEFAULT 0,
    "status" "AssetJobStatus" NOT NULL DEFAULT 'PENDING',
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "products_slug_key" ON "products"("slug");

-- CreateIndex
CREATE INDEX "products_productType_isPublished_idx" ON "products"("productType", "isPublished");

-- CreateIndex
CREATE INDEX "products_category_isPublished_idx" ON "products"("category", "isPublished");

-- CreateIndex
CREATE INDEX "products_gender_isPublished_idx" ON "products"("gender", "isPublished");

-- CreateIndex
CREATE INDEX "products_isPublished_createdAt_idx" ON "products"("isPublished", "createdAt");

-- CreateIndex
CREATE INDEX "product_variants_productId_idx" ON "product_variants"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "cart_items_cartId_productId_variantId_size_key" ON "cart_items"("cartId", "productId", "variantId", "size");

-- CreateIndex
CREATE UNIQUE INDEX "fitted_assets_productId_variantId_size_shapeFingerprint_key" ON "fitted_assets"("productId", "variantId", "size", "shapeFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_productId_variantId_size_key" ON "inventory"("productId", "variantId", "size");

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fitted_assets" ADD CONSTRAINT "fitted_assets_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fitted_assets" ADD CONSTRAINT "fitted_assets_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

