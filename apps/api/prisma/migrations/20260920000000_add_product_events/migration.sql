-- Per-product interaction events, used for the admin analytics view.
CREATE TYPE "ProductEventKind" AS ENUM ('CARD_CLICK', 'PAGE_VIEW');

CREATE TABLE "product_events" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "kind" "ProductEventKind" NOT NULL,
    "anonId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "product_events_productId_kind_idx" ON "product_events"("productId", "kind");
CREATE INDEX "product_events_createdAt_idx" ON "product_events"("createdAt");

ALTER TABLE "product_events" ADD CONSTRAINT "product_events_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
