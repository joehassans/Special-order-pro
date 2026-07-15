-- CreateTable
CREATE TABLE "SpecialOrder" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactStatus" TEXT,
    "overallStatus" TEXT,
    "note" TEXT,
    "customerShopifyId" TEXT,
    "customerName" TEXT,
    "customerEmail" TEXT,
    "customerPhone" TEXT,
    "convertedFromDraftId" TEXT,
    "shopifyCreatedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SpecialOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpecialOrderItem" (
    "id" TEXT NOT NULL,
    "specialOrderId" TEXT NOT NULL,
    "shopifyLineItemId" TEXT,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "variantTitle" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT,
    "attributes" JSONB,
    "adjustmentType" TEXT,
    "exchangedForTitle" TEXT,

    CONSTRAINT "SpecialOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationLog" (
    "id" TEXT NOT NULL,
    "specialOrderId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "employeeNote" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SpecialOrder_shop_overallStatus_idx" ON "SpecialOrder"("shop", "overallStatus");

-- CreateIndex
CREATE INDEX "SpecialOrder_shop_createdAt_idx" ON "SpecialOrder"("shop", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SpecialOrder_shop_shopifyId_key" ON "SpecialOrder"("shop", "shopifyId");

-- CreateIndex
CREATE INDEX "SpecialOrderItem_shopifyLineItemId_idx" ON "SpecialOrderItem"("shopifyLineItemId");

-- CreateIndex
CREATE UNIQUE INDEX "SpecialOrderItem_specialOrderId_position_key" ON "SpecialOrderItem"("specialOrderId", "position");

-- CreateIndex
CREATE INDEX "NotificationLog_specialOrderId_sentAt_idx" ON "NotificationLog"("specialOrderId", "sentAt");

-- AddForeignKey
ALTER TABLE "SpecialOrderItem" ADD CONSTRAINT "SpecialOrderItem_specialOrderId_fkey" FOREIGN KEY ("specialOrderId") REFERENCES "SpecialOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_specialOrderId_fkey" FOREIGN KEY ("specialOrderId") REFERENCES "SpecialOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

