-- Gallery of real product photos, in display order.
ALTER TABLE "products" ADD COLUMN "imageKeys" TEXT[] DEFAULT ARRAY[]::TEXT[];
