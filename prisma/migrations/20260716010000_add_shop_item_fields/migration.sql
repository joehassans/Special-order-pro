-- CreateTable
CREATE TABLE "ShopItemField" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "ShopItemField_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShopItemField_shop_position_idx" ON "ShopItemField"("shop", "position");
CREATE UNIQUE INDEX "ShopItemField_shop_label_key" ON "ShopItemField"("shop", "label");
