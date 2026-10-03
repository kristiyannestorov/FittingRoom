-- Backfill any remaining BGN rows to EUR before narrowing the enum.
UPDATE "products" SET "currency" = 'EUR' WHERE "currency" = 'BGN';
UPDATE "carts" SET "currency" = 'EUR' WHERE "currency" = 'BGN';
UPDATE "orders" SET "currency" = 'EUR' WHERE "currency" = 'BGN';
UPDATE "shipments" SET "currency" = 'EUR' WHERE "currency" = 'BGN';

-- Recreate the Currency enum without BGN.
ALTER TYPE "Currency" RENAME TO "Currency_old";
CREATE TYPE "Currency" AS ENUM ('EUR');

ALTER TABLE "products" ALTER COLUMN "currency" DROP DEFAULT;
ALTER TABLE "products" ALTER COLUMN "currency" TYPE "Currency" USING ("currency"::text::"Currency");
ALTER TABLE "products" ALTER COLUMN "currency" SET DEFAULT 'EUR';

ALTER TABLE "carts" ALTER COLUMN "currency" DROP DEFAULT;
ALTER TABLE "carts" ALTER COLUMN "currency" TYPE "Currency" USING ("currency"::text::"Currency");
ALTER TABLE "carts" ALTER COLUMN "currency" SET DEFAULT 'EUR';

ALTER TABLE "orders" ALTER COLUMN "currency" DROP DEFAULT;
ALTER TABLE "orders" ALTER COLUMN "currency" TYPE "Currency" USING ("currency"::text::"Currency");
ALTER TABLE "orders" ALTER COLUMN "currency" SET DEFAULT 'EUR';

ALTER TABLE "shipments" ALTER COLUMN "currency" DROP DEFAULT;
ALTER TABLE "shipments" ALTER COLUMN "currency" TYPE "Currency" USING ("currency"::text::"Currency");
ALTER TABLE "shipments" ALTER COLUMN "currency" SET DEFAULT 'EUR';

DROP TYPE "Currency_old";
