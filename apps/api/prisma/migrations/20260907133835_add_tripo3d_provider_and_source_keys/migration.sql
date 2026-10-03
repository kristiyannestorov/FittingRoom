-- AlterEnum
ALTER TYPE "GarmentGenerationProviderKey" ADD VALUE 'TRIPO3D';

-- AlterTable
ALTER TABLE "garment_3d" ADD COLUMN     "sourceKeys" TEXT[] DEFAULT ARRAY[]::TEXT[];
