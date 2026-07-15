import { normalizeAttributesArrayForSave } from "./special-order-line-item-attributes";
import {
  dbUpdateContactStatus,
  dbUpdateOverallStatus,
  dbUpdateNote,
  dbUpdateItemStatus,
  dbUpdateItemAttributes,
} from "./special-order-db-write.server";

/**
 * Phase 2: shared write path for special-order state, used by the POS API
 * routes. Each action:
 *   1. resolves the line item's CURRENT position from Shopify by its stable
 *      GID (so a stale client index can't hit the wrong metafield slot),
 *   2. writes the position-keyed metafield (kept as a mirror for POS
 *      receipts and older readers),
 *   3. updates the app database keyed by the line-item GID.
 *
 * All functions throw an Error with a user-facing message on failure.
 */

const METAFIELDS_SET = `#graphql
  mutation SetSpecialOrderMetafield($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors {
        field
        message
      }
    }
  }
`;

const ORDER_LINE_ITEM_IDS = `#graphql
  query OrderLineItemIds($id: ID!) {
    order(id: $id) {
      lineItems(first: 50) {
        edges { node { id } }
      }
    }
  }
`;

const DRAFT_LINE_ITEM_IDS = `#graphql
  query DraftLineItemIds($id: ID!) {
    draftOrder(id: $id) {
      lineItems(first: 50) {
        edges { node { id } }
      }
    }
  }
`;

function isDraftGid(gid) {
  return String(gid).includes("DraftOrder");
}

async function runMutation(graphql, query, variables, userErrorsPath) {
  const res = await graphql(query, { variables });
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join(", "));
  }
  const userErrors = userErrorsPath(json.data) ?? [];
  if (userErrors.length) {
    throw new Error(userErrors.map((e) => e.message).join(", "));
  }
  return json.data;
}

async function setMetafield(graphql, ownerId, key, value, type) {
  await runMutation(
    graphql,
    METAFIELDS_SET,
    { metafields: [{ ownerId, namespace: "custom", key, value, type }] },
    (data) => data?.metafieldsSet?.userErrors
  );
}

/**
 * Find the line item's current 1-based position on the order in Shopify.
 * Throws if the item is no longer on the order (e.g. removed by an edit).
 */
async function resolveLineItemPosition(graphql, orderGid, lineItemId) {
  const query = isDraftGid(orderGid) ? DRAFT_LINE_ITEM_IDS : ORDER_LINE_ITEM_IDS;
  const res = await graphql(query, { variables: { id: orderGid } });
  const json = await res.json();
  const node = isDraftGid(orderGid) ? json.data?.draftOrder : json.data?.order;
  if (!node) {
    throw new Error("Order not found.");
  }
  const ids = (node.lineItems?.edges || []).map((e) => e.node.id);
  const index = ids.indexOf(lineItemId);
  if (index < 0) {
    throw new Error(
      "This item is no longer on the order. Close and reopen the order to refresh."
    );
  }
  return index + 1;
}

export async function setContactStatus(graphql, shop, orderGid, value) {
  await setMetafield(
    graphql,
    orderGid,
    "contact_status",
    String(value),
    "single_line_text_field"
  );
  await dbUpdateContactStatus(shop, orderGid, String(value));
}

export async function setOverallStatus(graphql, shop, orderGid, value) {
  await setMetafield(
    graphql,
    orderGid,
    "overall_order_status",
    String(value),
    "single_line_text_field"
  );
  await dbUpdateOverallStatus(shop, orderGid, String(value));
}

export async function setItemStatus(graphql, shop, orderGid, lineItemId, value) {
  const position = await resolveLineItemPosition(graphql, orderGid, lineItemId);
  await setMetafield(
    graphql,
    orderGid,
    `product_${position}_order_status`,
    String(value),
    "single_line_text_field"
  );
  await dbUpdateItemStatus(
    shop,
    orderGid,
    { lineItemId, position },
    String(value)
  );
  return { position };
}

export async function setItemAttributes(
  graphql,
  shop,
  orderGid,
  lineItemId,
  attributes
) {
  const position = await resolveLineItemPosition(graphql, orderGid, lineItemId);
  const normalized = normalizeAttributesArrayForSave(attributes);
  await setMetafield(
    graphql,
    orderGid,
    `lineitem_${position}_attributes`,
    JSON.stringify(normalized),
    "json"
  );
  await dbUpdateItemAttributes(shop, orderGid, position, normalized);
  return { position, attributes: normalized };
}

const DRAFT_NOTE_UPDATE = `#graphql
  mutation UpdateDraftNote($id: ID!, $input: DraftOrderInput!) {
    draftOrderUpdate(id: $id, input: $input) {
      userErrors { message }
    }
  }
`;

const ORDER_NOTE_UPDATE = `#graphql
  mutation UpdateOrderNote($input: OrderInput!) {
    orderUpdate(input: $input) {
      userErrors { message }
    }
  }
`;

export async function setNote(graphql, shop, orderGid, note) {
  if (isDraftGid(orderGid)) {
    await runMutation(
      graphql,
      DRAFT_NOTE_UPDATE,
      { id: orderGid, input: { note: String(note) } },
      (data) => data?.draftOrderUpdate?.userErrors
    );
  } else {
    await runMutation(
      graphql,
      ORDER_NOTE_UPDATE,
      { input: { id: orderGid, note: String(note) } },
      (data) => data?.orderUpdate?.userErrors
    );
  }
  await dbUpdateNote(shop, orderGid, String(note));
}
