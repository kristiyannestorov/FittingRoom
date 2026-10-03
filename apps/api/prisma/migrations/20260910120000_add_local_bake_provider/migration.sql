-- The fitting room's photo-to-texture path: instead of reconstructing garment
-- geometry, it bakes the uploaded photos into a texture for the avatar's own
-- garment mesh (see apps/garment3d-service/bake_texture.py). That produces a
-- texture rather than a model, hence a separate column alongside modelKey.
--
-- Plain ADD VALUE here, unlike the LOCAL_TRIPOSR -> LOCAL_MULTIVIEW migration:
-- nothing is being renamed, so no existing rows need remapping and the enum
-- does not have to be recreated.
ALTER TYPE "GarmentGenerationProviderKey" ADD VALUE 'LOCAL_BAKE';

ALTER TABLE "garment_3d" ADD COLUMN "textureKey" TEXT;
