-- POLO joins the ProductCategory enum for T_SHIRT and LONG_SLEEVE. A polo's collar and
-- button placket fill the neck opening of its front photo, so the garment bake has to
-- leave that area alone rather than paint it out as a care label (see
-- apps/garment3d-service/garment_profiles.py).
--
-- Plain ADD VALUE: nothing is renamed, so no existing rows need remapping.
ALTER TYPE "ProductCategory" ADD VALUE 'POLO';
