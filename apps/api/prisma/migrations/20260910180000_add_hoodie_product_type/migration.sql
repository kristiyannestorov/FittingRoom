-- HOODIE joins the ProductType enum, with PULLOVER/ZIP_UP as its own cuts.
-- (HOODIE also reuses GRAPHIC, which T_SHIRT already offers -- categories
-- describe the cut and are reachable from more than one product type; see
-- PRODUCT_TYPE_CATEGORIES in packages/contracts/src/sizing.ts.)
--
-- Plain ADD VALUE: nothing is renamed, so no existing rows need remapping and
-- neither enum has to be recreated.
ALTER TYPE "ProductType" ADD VALUE 'HOODIE';

ALTER TYPE "ProductCategory" ADD VALUE 'PULLOVER';
ALTER TYPE "ProductCategory" ADD VALUE 'ZIP_UP';
