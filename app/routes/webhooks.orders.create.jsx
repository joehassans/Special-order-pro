import { authenticate } from "../shopify.server";
import { copySpecialOrderMetafieldsFromDraftToOrder } from "../lib/copy-special-order-from-draft.server";
import { fetchAndSyncSpecialOrderById } from "../lib/special-order-db-sync.server";

const SPECIAL_ORDER_TAG = "special-order";

const TAGS_ADD = `#graphql
  mutation AddSpecialOrderTag($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors { message }
    }
  }
`;

/**
 * True when any line item carries the "Special Order: Yes" property that the
 * POS cart extension writes. This is how register-created special orders
 * (including "Add Custom Sale" items, which have no product behind them)
 * are detected — they never pass through a tagged draft.
 */
function hasSpecialOrderLineProperty(payload) {
  return (payload?.line_items ?? []).some((li) =>
    (li?.properties ?? []).some(
      (p) =>
        String(p?.name ?? "").trim().toLowerCase() === "special order" &&
        String(p?.value ?? "").trim().toLowerCase() === "yes"
    )
  );
}

function payloadHasSpecialOrderTag(payload) {
  return String(payload?.tags ?? "")
    .split(",")
    .some((t) => t.trim().toLowerCase() === SPECIAL_ORDER_TAG);
}

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

  const alreadyTagged = payloadHasSpecialOrderTag(payload);
  const soldAsSpecialOrder = hasSpecialOrderLineProperty(payload);

  // Register-created special orders (e.g. custom sale items marked
  // "Special Order: Yes" in the POS cart) don't come from a tagged draft,
  // so the tag — the app's entry point — must be added here or the order
  // would never appear in the app.
  if (!copyResult?.copied && !alreadyTagged && soldAsSpecialOrder) {
    try {
      const res = await admin.graphql(TAGS_ADD, {
        variables: { id: orderGid, tags: [SPECIAL_ORDER_TAG] },
      });
      const json = await res.json();
      const errs = json.data?.tagsAdd?.userErrors ?? [];
      if (errs.length) {
        throw new Error(errs.map((e) => e.message).join(", "));
      }
      console.log(
        `[ORDERS_CREATE] Tagged register-created special order ${orderGid}`
      );
    } catch (e) {
      console.error(`[ORDERS_CREATE] tagsAdd failed for ${orderGid}`, e);
    }
  }

  // Mirror the new special order into the app DB right away; other orders
  // are synced lazily when viewed in the app.
  if (copyResult?.copied || alreadyTagged || soldAsSpecialOrder) {
    try {
      await fetchAndSyncSpecialOrderById(admin.graphql, session.shop, orderGid, {
        convertedFromDraftId: copyResult?.draftId ?? null,
      });
    } catch (e) {
      console.error(`[ORDERS_CREATE] db sync failed for ${orderGid}`, e);
    }
  }

  return new Response();
};
