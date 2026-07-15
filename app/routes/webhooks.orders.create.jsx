import { authenticate } from "../shopify.server";
import { copySpecialOrderMetafieldsFromDraftToOrder } from "../lib/copy-special-order-from-draft.server";
import { fetchAndSyncSpecialOrderById } from "../lib/special-order-db-sync.server";

export const action = async ({ request }) => {
  const { admin, session, topic, payload } = await authenticate.webhook(request);

  if (!session || !admin) {
    return new Response();
  }

  if (topic !== "ORDERS_CREATE" && topic !== "orders/create") {
    return new Response();
  }

  const orderGid =
    payload?.admin_graphql_api_id ??
    (payload?.id != null ? `gid://shopify/Order/${payload.id}` : null);

  if (!orderGid) {
    return new Response();
  }

  let copyResult = null;
  try {
    copyResult = await copySpecialOrderMetafieldsFromDraftToOrder(
      admin.graphql,
      orderGid
    );
    if (copyResult.copied) {
      console.log(
        `[ORDERS_CREATE] Copied special-order state from draft to ${orderGid}`,
        copyResult
      );
    }
  } catch (e) {
    console.error(
      `[ORDERS_CREATE] copy-special-order-from-draft failed for ${orderGid}`,
      e
    );
  }

  // Phase 1 shadow sync: mirror the new order into the app DB right away
  // (only when it came from a special-order draft; other orders are synced
  // lazily when viewed in the app).
  if (copyResult?.copied) {
    try {
      await fetchAndSyncSpecialOrderById(admin.graphql, session.shop, orderGid, {
        convertedFromDraftId: copyResult.draftId ?? null,
      });
    } catch (e) {
      console.error(`[ORDERS_CREATE] db sync failed for ${orderGid}`, e);
    }
  }

  return new Response();
};
