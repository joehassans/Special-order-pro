import prisma from "../db.server";

/**
 * Phase 1 final step: the app database is the primary read source for
 * app-managed special-order state (contact status, overall status, item
 * statuses, item attributes, notification log). Shopify remains the live
 * source for everything it owns (prices, payments, fulfillment, customer).
 *
 * Line items are matched by their stable Shopify GID first, falling back
 * to position, so the read side no longer depends on position-keyed
 * metafields when a DB record exists.
 */

/**
 * Load the mirrored DB state for one order/draft. Returns null when the
 * order was never synced (caller falls back to metafields) or on any DB
 * error — reads must never break the page.
 *
 * @param {string} shop myshopify domain
 * @param {string} shopifyId Order or DraftOrder GID
 */
export async function loadSpecialOrderDbState(shop, shopifyId) {
  let record;
  try {
    record = await prisma.specialOrder.findUnique({
      where: { shop_shopifyId: { shop, shopifyId } },
      include: {
        items: true,
        notifications: { orderBy: { sentAt: "asc" } },
      },
    });
  } catch (e) {
    console.error(
      `[special-order-db-read] load failed for ${shopifyId}:`,
      e instanceof Error ? e.message : e
    );
    return null;
  }
  if (!record) return null;

  const byGid = new Map();
  const byPosition = new Map();
  for (const item of record.items) {
    if (item.shopifyLineItemId) byGid.set(item.shopifyLineItemId, item);
    byPosition.set(item.position, item);
  }

  return {
    record,
    /**
     * @param {string | null | undefined} lineItemGid
     * @param {number} position 1-based
     */
    itemFor(lineItemGid, position) {
      return (
        (lineItemGid ? byGid.get(lineItemGid) : null) ??
        byPosition.get(position) ??
        null
      );
    },
    notificationLog: record.notifications.map((n) => ({
      type: n.type,
      recipientEmail: n.recipientEmail,
      employeeNote: n.employeeNote || "",
      sentAt: n.sentAt.toISOString(),
    })),
  };
}

/**
 * DB attributes column is Json; only a non-empty array is usable as the
 * line item's attribute list.
 */
export function dbItemAttributesArray(dbItem) {
  const attrs = dbItem?.attributes;
  return Array.isArray(attrs) && attrs.length > 0 ? attrs : null;
}
