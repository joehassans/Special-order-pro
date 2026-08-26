import { authenticate } from "../shopify.server";
import { deleteSpecialOrderByShopifyId } from "../lib/special-order-db-sync.server";

/**
 * Handles both orders/delete and draft_orders/delete. When an order is
 * deleted in Shopify, its mirror row (with items and notification log) is
 * removed from the app DB so it disappears from the admin and POS tables.
 */
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const numericId = payload?.id;
  if (!shop || numericId == null) {
    return new Response();
  }

  const normalizedTopic = String(topic).toLowerCase().replace("/", "_");
  const gid =
    normalizedTopic === "draft_orders_delete"
      ? `gid://shopify/DraftOrder/${numericId}`
      : `gid://shopify/Order/${numericId}`;

  try {
    const deleted = await deleteSpecialOrderByShopifyId(shop, gid);
    if (deleted) {
      console.log(`[${topic}] Removed deleted order ${gid} for ${shop}`);
    }
  } catch (e) {
    console.error(`[${topic}] DB cleanup failed for ${gid} (${shop})`, e);
  }

  return new Response();
};
