import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * Mandatory privacy compliance webhooks (required for public apps).
 * Shopify sends these even after uninstall, so no admin session is
 * assumed — everything works directly against the app database.
 */
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST": {
      // The merchant must provide the customer's data. Log enough detail
      // for support to look the records up; the app stores only order
      // header info (name/email/phone) mirrored from Shopify.
      console.log(
        `[compliance] customers/data_request for ${shop}:`,
        JSON.stringify({
          customerId: payload?.customer?.id ?? null,
          ordersRequested: payload?.orders_requested ?? [],
        })
      );
      break;
    }

    case "CUSTOMERS_REDACT": {
      const customerId = payload?.customer?.id;
      if (customerId) {
        const customerGid = `gid://shopify/Customer/${customerId}`;
        const orders = await prisma.specialOrder.findMany({
          where: { shop, customerShopifyId: customerGid },
          select: { id: true },
        });
        const orderIds = orders.map((o) => o.id);
        await prisma.$transaction([
          prisma.notificationLog.updateMany({
            where: { specialOrderId: { in: orderIds } },
            data: { recipientEmail: "[redacted]" },
          }),
          prisma.specialOrder.updateMany({
            where: { shop, customerShopifyId: customerGid },
            data: {
              customerName: null,
              customerEmail: null,
              customerPhone: null,
            },
          }),
        ]);
        console.log(
          `[compliance] customers/redact for ${shop}: anonymized ${orderIds.length} order(s) for customer ${customerId}`
        );
      }
      break;
    }

    case "SHOP_REDACT": {
      // Sent 48h after uninstall: remove everything we hold for the shop.
      // Items and notification logs cascade from SpecialOrder.
      const [orders, fields, profiles, sessions] = await prisma.$transaction([
        prisma.specialOrder.deleteMany({ where: { shop } }),
        prisma.shopItemField.deleteMany({ where: { shop } }),
        prisma.shopProfile.deleteMany({ where: { shop } }),
        prisma.session.deleteMany({ where: { shop } }),
      ]);
      console.log(
        `[compliance] shop/redact for ${shop}: deleted ${orders.count} orders, ${fields.count} item fields, ${profiles.count} profiles, ${sessions.count} sessions`
      );
      break;
    }

    default:
      break;
  }

  return new Response();
};
