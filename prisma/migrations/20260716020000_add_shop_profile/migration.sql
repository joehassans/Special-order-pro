-- CreateTable
CREATE TABLE "ShopProfile" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "storeName" TEXT,
    "address" TEXT,
    "hours" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "instagram" TEXT,
    "logoUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopProfile_shop_key" ON "ShopProfile"("shop");
