-- AlterEnum
-- Full-length bottoms, distinct from SHORTS: the 3D fitting room scales a
-- garment by product type, and trousers reach the ankle where shorts stop at
-- mid-thigh.
--
-- BEFORE 'LONG_SLEEVE' keeps the Postgres enum's own value order matching the
-- order declared in schema.prisma; a bare ADD VALUE would append instead.
-- Safe inside Prisma's migration transaction on Postgres 12+ (this project
-- runs 16) because the new value isn't referenced by any statement here.
ALTER TYPE "ProductType" ADD VALUE 'PANTS' BEFORE 'LONG_SLEEVE';
