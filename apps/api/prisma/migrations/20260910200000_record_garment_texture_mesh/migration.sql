-- Records which garment shape a baked texture belongs to.
--
-- A UV atlas is specific to one mesh of one GLB. Without this, a texture baked
-- against a hoodie is indistinguishable from one baked against the default
-- avatar's t-shirt, and drawing it on the wrong mesh renders as noise with
-- nothing to explain why. Reported by garment3d-service's /bake rather than
-- recomputed here, so there is a single implementation of the lookup.
ALTER TABLE "garment_3d" ADD COLUMN "textureMeshSource" TEXT;
ALTER TABLE "garment_3d" ADD COLUMN "textureMeshName" TEXT;
