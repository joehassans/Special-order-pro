import prisma from "../db.server";
import { calculatePaymentStatus } from "./order-status-helpers";

/**
 * Phase 1 of the v2 data model: mirror special-order state from Shopify
 * metafields (namespace "custom", position-keyed) into the app database.
 *
 * Metafields remain the source of truth for now. Sync is one-way
 * (Shopify -> DB), deterministic (items/notifications are replaced, not
 * merged), and must never break a page load — callers use syncInBackground.
 */

function metafieldMap(metafields) {
  const map = new Map();
  for (const edge of metafields?.edges || []) {
    if (edge?.node?.key != null) {
      map.set(edge.node.key, edge.node.value);
    }
  }
  return map;
}

function parseJsonArray(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Build DB rows from a GraphQL Order/DraftOrder node as fetched by the
 * admin loaders (metafields + lineItems connections).
 *
 * @param {object} node GraphQL node with at least id, name; optionally
 *   metafields, lineItems, customer, createdAt, note/note2.
 * @param {"ORDER" | "DRAFT_ORDER"} kind
 */
export function buildSpecialOrderRecord(node, kind) {
  const mf = metafieldMap(node.metafields);

  const lineItemNodes = (node.lineItems?.edges || []).map((e) => e.node);
  const items = lineItemNodes.map((li, index) => {
    const position = index + 1;
    const attributes =
      parseJsonArray(mf.get(`lineitem_${position}_attributes`)) ??
      (Array.isArray(li.customAttributes) && li.customAttributes.length
        ? li.customAttributes.map(({ key, value }) => ({ key, value }))
        : null);

    return {
      shopifyLineItemId: li.id ?? null,
      position,
      title: li.title ?? "Item",
      variantTitle: li.variantTitle ?? li.variant?.title ?? null,
      quantity: li.quantity ?? 1,
      status: mf.get(`product_${position}_order_status`) ?? null,
      attributes,
      adjustmentType: mf.get(`product_${position}_adjustment_type`) ?? null,
      exchangedForTitle:
        mf.get(`product_${position}_exchanged_for_title`) ?? null,
    };
  });

  const notifications = (parseJsonArray(mf.get("pickup_notification_log")) || [])
    .filter((entry) => entry && entry.sentAt && entry.recipientEmail)
    .map((entry) => ({
      type: entry.type || "email_ready_pickup",
      recipientEmail: entry.recipientEmail,
      employeeNote: entry.employeeNote || null,
      sentAt: new Date(entry.sentAt),
    }))
    .filter((entry) => !Number.isNaN(entry.sentAt.getTime()));

  return {
    order: {
      shopifyId: node.id,
      kind,
      name: node.name ?? "",
      contactStatus: mf.get("contact_status") ?? null,
      overallStatus: mf.get("overall_order_status") ?? null,
      paymentStatus: calculatePaymentStatus(node),
      shopifyStatus: kind === "DRAFT_ORDER" ? (node.status ?? null) : null,
      note: node.note ?? node.note2 ?? null,
      customerShopifyId: node.customer?.id ?? null,
      customerName: node.customer?.displayName ?? null,
      customerEmail: node.customer?.email ?? null,
      customerPhone: node.customer?.phone ?? null,
      shopifyCreatedAt: node.createdAt ? new Date(node.createdAt) : null,
    },
    items,
    notifications,
  };
}

/**
 * Upsert one special order (header + items + notifications) into the DB.
 *
 * @param {string} shop myshopify domain
 * @param {object} node GraphQL Order/DraftOrder node
 * @param {"ORDER" | "DRAFT_ORDER"} kind
 * @param {{ convertedFromDraftId?: string }} [extra]
 */
export async function syncSpecialOrder(shop, node, kind, extra = {}) {
  if (!node?.id) return null;
  const { order, items, notifications } = buildSpecialOrderRecord(node, kind);

  return prisma.$transaction(async (tx) => {
    const record = await tx.specialOrder.upsert({
      where: { shop_shopifyId: { shop, shopifyId: order.shopifyId } },
      create: {
        shop,
        ...order,
        convertedFromDraftId: extra.convertedFromDraftId ?? null,
      },
      update: {
        ...order,
        ...(extra.convertedFromDraftId
          ? { convertedFromDraftId: extra.convertedFromDraftId }
          : {}),
        syncedAt: new Date(),
      },
    });

    // Metafields are the source of truth, so a full replace keeps the
    // mirror exact without merge logic.
    await tx.specialOrderItem.deleteMany({
      where: { specialOrderId: record.id },
    });
    if (items.length) {
      await tx.specialOrderItem.createMany({
        data: items.map((item) => ({ ...item, specialOrderId: record.id })),
      });
    }

    await tx.notificationLog.deleteMany({
      where: { specialOrderId: record.id },
    });
    if (notifications.length) {
      await tx.notificationLog.createMany({
        data: notifications.map((n) => ({
          ...n,
          specialOrderId: record.id,
        })),
      });
    }

    return record;
  });
}

/**
 * Fire-and-forget wrapper: page loads must never fail or slow down
 * because the shadow sync had a problem.
 */
export function syncInBackground(shop, node, kind, extra) {
  syncSpecialOrder(shop, node, kind, extra).catch((e) => {
    console.error(
      `[special-order-sync] failed for ${node?.id ?? "unknown"}:`,
      e instanceof Error ? e.message : e
    );
  });
}
