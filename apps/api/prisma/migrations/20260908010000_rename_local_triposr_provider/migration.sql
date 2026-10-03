-- Recreate the GarmentGenerationProviderKey enum with LOCAL_MULTIVIEW instead of
-- LOCAL_TRIPOSR. Since the new value doesn't already exist on the old enum (unlike
-- a simple ADD VALUE case), go via a temporary column so the text->enum cast can
-- remap old values to new ones in a single statement.
CREATE TYPE "GarmentGenerationProviderKey_new" AS ENUM ('MANUAL', 'TRIPO3D', 'LOCAL_MULTIVIEW');

ALTER TABLE "garment_3d" ADD COLUMN "generationProvider_new" "GarmentGenerationProviderKey_new";

UPDATE "garment_3d" SET "generationProvider_new" = (
  CASE "generationProvider"::text
    WHEN 'LOCAL_TRIPOSR' THEN 'LOCAL_MULTIVIEW'
    ELSE "generationProvider"::text
  END
)::"GarmentGenerationProviderKey_new";

ALTER TABLE "garment_3d" ALTER COLUMN "generationProvider_new" SET NOT NULL;
ALTER TABLE "garment_3d" ALTER COLUMN "generationProvider_new" SET DEFAULT 'MANUAL';

ALTER TABLE "garment_3d" DROP COLUMN "generationProvider";
ALTER TABLE "garment_3d" RENAME COLUMN "generationProvider_new" TO "generationProvider";

DROP TYPE "GarmentGenerationProviderKey";
ALTER TYPE "GarmentGenerationProviderKey_new" RENAME TO "GarmentGenerationProviderKey";
