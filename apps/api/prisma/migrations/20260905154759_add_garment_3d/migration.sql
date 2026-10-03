-- CreateEnum
CREATE TYPE "GenerationStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "GarmentGenerationProviderKey" AS ENUM ('MANUAL');

-- CreateTable
CREATE TABLE "garment_3d" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "modelKey" TEXT,
    "previewKey" TEXT,
    "generationStatus" "GenerationStatus" NOT NULL DEFAULT 'PENDING',
    "generationProvider" "GarmentGenerationProviderKey" NOT NULL DEFAULT 'MANUAL',
    "generationVersion" INTEGER NOT NULL DEFAULT 1,
    "confidenceScore" DOUBLE PRECISION,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "garment_3d_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "garment_measurements" (
    "id" UUID NOT NULL,
    "garmentId" UUID NOT NULL,
    "size" "ClothingSize" NOT NULL,
    "chestCm" DOUBLE PRECISION,
    "waistCm" DOUBLE PRECISION,
    "shoulderCm" DOUBLE PRECISION,
    "lengthCm" DOUBLE PRECISION,
    "sleeveLengthCm" DOUBLE PRECISION,

    CONSTRAINT "garment_measurements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "garment_physics" (
    "garmentId" UUID NOT NULL,
    "stiffness" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "stretch" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    "bending" DOUBLE PRECISION NOT NULL DEFAULT 0.4,
    "friction" DOUBLE PRECISION NOT NULL DEFAULT 0.4,
    "thickness" DOUBLE PRECISION NOT NULL DEFAULT 0.002,
    "density" DOUBLE PRECISION NOT NULL DEFAULT 150,
    "damping" DOUBLE PRECISION NOT NULL DEFAULT 0.1,

    CONSTRAINT "garment_physics_pkey" PRIMARY KEY ("garmentId")
);

-- CreateIndex
CREATE UNIQUE INDEX "garment_3d_productId_key" ON "garment_3d"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "garment_measurements_garmentId_size_key" ON "garment_measurements"("garmentId", "size");

-- AddForeignKey
ALTER TABLE "garment_3d" ADD CONSTRAINT "garment_3d_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "garment_measurements" ADD CONSTRAINT "garment_measurements_garmentId_fkey" FOREIGN KEY ("garmentId") REFERENCES "garment_3d"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "garment_physics" ADD CONSTRAINT "garment_physics_garmentId_fkey" FOREIGN KEY ("garmentId") REFERENCES "garment_3d"("id") ON DELETE CASCADE ON UPDATE CASCADE;
