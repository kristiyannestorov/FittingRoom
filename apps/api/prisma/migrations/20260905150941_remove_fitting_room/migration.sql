-- DropForeignKey
ALTER TABLE "fitted_assets" DROP CONSTRAINT "fitted_assets_productId_fkey";

-- DropForeignKey
ALTER TABLE "fitted_assets" DROP CONSTRAINT "fitted_assets_variantId_fkey";

-- AlterTable
ALTER TABLE "product_variants" DROP COLUMN "modelKey",
DROP COLUMN "status";

-- AlterTable
ALTER TABLE "products" DROP COLUMN "baseModelKey",
DROP COLUMN "modelStatus";

-- AlterTable
ALTER TABLE "users" DROP COLUMN "bodyMeasurements",
DROP COLUMN "gender";

-- DropTable
DROP TABLE "fitted_assets";

-- DropEnum
DROP TYPE "AssetJobStatus";

