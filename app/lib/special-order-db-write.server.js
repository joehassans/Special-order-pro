import prisma from "../db.server";

/**
 * Phase 1 step 3: write-through helpers. Admin actions call these right
 * after a successful metafield write so the app DB is current in the
 * same request (no staleness window for admin-side changes).
 *
 * All helpers are non-fatal: the metafield write already succeeded, and
 * the loader re-sync self-heals the mirror, so a DB hiccup must never
 * fail the user's action. Rows that don't exist yet are skipped for the
 * same reason.
 */

async function findOrder(shop, shopifyId) {
  return prisma.specialOrder.findUnique({
    where: { shop_shopifyId: { shop, shopifyId } },
    select: { id: true },
  });
}

function logSkip(fn, e) {
  console.error(
    `[special-order-db-write] ${fn} failed (loader re-sync will heal):`,
    e instanceof Error ? e.message : e
  );
}

export async function dbUpdateContactStatus(shop, shopifyId, contactStatus) {
  try {
    const rec = await findOrder(shop, shopifyId);
    if (!rec) return;
    await prisma.specialOrder.update({
      where: { id: rec.id },
      data: { contactStatus, syncedAt: new Date() },
    });
  } catch (e) {
    logSkip("dbUpdateContactStatus", e);
  }
}

export async function dbUpdateOverallStatus(shop, shopifyId, overallStatus) {
  try {
    const rec = await findOrder(shop, shopifyId);
    if (!rec) return;
    await prisma.specialOrder.update({
      where: { id: rec.id },
      data: { overallStatus, syncedAt: new Date() },
    });
  } catch (e) {
    logSkip("dbUpdateOverallStatus", e);
  }
}

export async function dbUpdateNote(shop, shopifyId, note) {
  try {
    const rec = await findOrder(shop, shopifyId);
    if (!rec) return;
    await prisma.specialOrder.update({
      where: { id: rec.id },
      data: { note, syncedAt: new Date() },
    });
  } catch (e) {
    logSkip("dbUpdateNote", e);
  }
}

export async function dbUpdateCustomer(shop, customerShopifyId, fields) {
  try {
    await prisma.specialOrder.updateMany({
      where: { shop, customerShopifyId },
      data: { ...fields, syncedAt: new Date() },
    });
  } catch (e) {
    logSkip("dbUpdateCustomer", e);
  }
}

/**
 * Update a line item's status. Prefers the stable Shopify line-item GID;
 * falls back to the legacy 1-based position.
 */
export async function dbUpdateItemStatus(
  shop,
  shopifyId,
  { lineItemId, position },
  status
) {
  try {
    const rec = await findOrder(shop, shopifyId);
    if (!rec) return;
    const where = lineItemId
      ? { specialOrderId: rec.id, shopifyLineItemId: lineItemId }
      : { specialOrderId: rec.id, position };
    await prisma.specialOrderItem.updateMany({
      where,
      data: { status },
    });
  } catch (e) {
    logSkip("dbUpdateItemStatus", e);
  }
}

export async function dbUpdateItemAttributes(
  shop,
  shopifyId,
  position,
  attributes
) {
  try {
    const rec = await findOrder(shop, shopifyId);
    if (!rec) return;
    await prisma.specialOrderItem.updateMany({
      where: { specialOrderId: rec.id, position },
      data: { attributes },
    });
  } catch (e) {
    logSkip("dbUpdateItemAttributes", e);
  }
}

export async function dbAppendNotification(
  shop,
  shopifyId,
  { type, recipientEmail, employeeNote, sentAt, contactStatus }
) {
  try {
    const rec = await findOrder(shop, shopifyId);
    if (!rec) return;
    await prisma.$transaction([
      prisma.notificationLog.create({
        data: {
          specialOrderId: rec.id,
          type,
          recipientEmail,
          employeeNote: employeeNote || null,
          sentAt: new Date(sentAt),
        },
      }),
      prisma.specialOrder.update({
        where: { id: rec.id },
        data: {
          ...(contactStatus ? { contactStatus } : {}),
          syncedAt: new Date(),
        },
      }),
    ]);
  } catch (e) {
    logSkip("dbAppendNotification", e);
  }
}
