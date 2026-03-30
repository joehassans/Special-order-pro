import { authenticate } from "../shopify.server";
import { copySpecialOrderMetafieldsFromDraftToOrder } from "../lib/copy-special-order-from-draft.server";

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

  try {
    const result = await copySpecialOrderMetafieldsFromDraftToOrder(
      admin.graphql,
      orderGid
    );
    if (result.copied) {
      console.log(
        `[ORDERS_CREATE] Copied special-order state from draft to ${orderGid}`,
        result
      );
    }
  } catch (e) {
    console.error(
      `[ORDERS_CREATE] copy-special-order-from-draft failed for ${orderGid}`,
      e
    );
  }

  return new Response();
};
