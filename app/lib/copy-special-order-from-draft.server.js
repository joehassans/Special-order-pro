/**
 * When a draft order is completed, Shopify creates a new Order but does not copy
 * merchant metafields from the draft. This module finds the originating DraftOrder
 * and copies `custom` namespace metafields (and the special-order tag / note when needed)
 * onto the new order so POS/admin status tracking stays consistent.
 */

const SPECIAL_ORDER_TAG = "special-order";
const METAFIELDS_NAMESPACE = "custom";
const DRAFT_SEARCH_PAGE = 50;
const DRAFT_SEARCH_MAX_PAGES = 8;

const METAFIELDS_SET = `#graphql
  mutation CopyOrderMetafieldsFromDraft($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors {
        field
        message
      }
    }
  }
`;

const ORDER_UPDATE = `#graphql
  mutation CopyOrderFieldsFromDraft($input: OrderInput!) {
    orderUpdate(input: $input) {
      order {
        id
        tags
        note
      }
      userErrors {
        field
        message
      }
    }
  }
`;

function tagsArray(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.map((t) => String(t).trim()).filter(Boolean);
}

function hasSpecialOrderTag(tags) {
  return tagsArray(tags).some(
    (t) => t.toLowerCase() === SPECIAL_ORDER_TAG
  );
}

/**
 * True if this draft looks like a special order we manage (tag or known metafield keys).
 */
export function isSpecialOrderDraft(draft) {
  if (!draft) return false;
  if (hasSpecialOrderTag(draft.tags)) return true;
  const keys = new Set(
    (draft.metafields?.edges || []).map((e) => e?.node?.key).filter(Boolean)
  );
  const direct = [
    "contact_status",
    "overall_order_status",
    "order_adjustments_additional_payment",
    "order_adjustments_refund_total",
  ];
  if (direct.some((k) => keys.has(k))) return true;
  for (const k of keys) {
    if (
      k.startsWith("product_") ||
      k.startsWith("lineitem_")
    ) {
      return true;
    }
  }
  return false;
}

function metafieldTypeForKey(key) {
  if (key.startsWith("lineitem_") && key.endsWith("_attributes")) {
    return "json";
  }
  if (
    key === "order_adjustments_additional_payment" ||
    key === "order_adjustments_refund_total"
  ) {
    return "number_decimal";
  }
  return "single_line_text_field";
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function loadDraftOrder(graphql, draftGid) {
  const res = await graphql(
    `#graphql
    query DraftOrderForCopy($id: ID!) {
      draftOrder(id: $id) {
        id
        tags
        note2
        order {
          id
        }
        metafields(first: 250, namespace: "${METAFIELDS_NAMESPACE}") {
          edges {
            node {
              key
              value
            }
          }
        }
      }
    }`,
    { variables: { id: draftGid } }
  );
  const json = await res.json();
  return json.data?.draftOrder ?? null;
}

async function findDraftOrderForShopifyOrder(graphql, orderGid) {
  const orderRes = await graphql(
    `#graphql
    query OrderDraftHints($id: ID!) {
      order(id: $id) {
        id
        sourceName
        sourceIdentifier
      }
    }`,
    { variables: { id: orderGid } }
  );
  const orderJson = await orderRes.json();
  const order = orderJson.data?.order;
  if (!order) return null;

  const sid = order.sourceIdentifier?.trim();
  if (sid && /^\d+$/.test(sid)) {
    const draftGid = `gid://shopify/DraftOrder/${sid}`;
    const draft = await loadDraftOrder(graphql, draftGid);
    if (draft?.order?.id === orderGid) {
      return draft;
    }
  }

  let cursor = null;
  for (let page = 0; page < DRAFT_SEARCH_MAX_PAGES; page += 1) {
    const searchRes = await graphql(
      `#graphql
      query CompletedDraftsForOrder(
        $first: Int!
        $after: String
      ) {
        draftOrders(
          first: $first
          after: $after
          reverse: true
          sortKey: UPDATED_AT
          query: "status:completed"
        ) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              tags
              note2
              order {
                id
              }
              metafields(first: 250, namespace: "${METAFIELDS_NAMESPACE}") {
                edges {
                  node {
                    key
                    value
                  }
                }
              }
            }
          }
        }
      }`,
      {
        variables: {
          first: DRAFT_SEARCH_PAGE,
          after: cursor,
        },
      }
    );
    const searchJson = await searchRes.json();
    const conn = searchJson.data?.draftOrders;
    const edges = conn?.edges || [];
    for (const edge of edges) {
      const node = edge?.node;
      if (node?.order?.id === orderGid) {
        return node;
      }
    }
    const pageInfo = conn?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo?.endCursor) {
      break;
    }
    cursor = pageInfo.endCursor;
  }

  return null;
}

/**
 * @param {(query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>} graphql
 * @param {string} orderGid
 */
export async function copySpecialOrderMetafieldsFromDraftToOrder(graphql, orderGid) {
  const draft = await findDraftOrderForShopifyOrder(graphql, orderGid);
  if (!draft || !isSpecialOrderDraft(draft)) {
    return { copied: false, reason: "no_matching_special_order_draft" };
  }

  const edges = draft.metafields?.edges || [];
  const inputs = edges
    .map((e) => e?.node)
    .filter((n) => n && n.key && n.value != null && String(n.value) !== "")
    .map((n) => ({
      ownerId: orderGid,
      namespace: METAFIELDS_NAMESPACE,
      key: n.key,
      value: String(n.value),
      type: metafieldTypeForKey(n.key),
    }));

  for (const batch of chunk(inputs, 25)) {
    if (batch.length === 0) continue;
    const res = await graphql(METAFIELDS_SET, {
      variables: { metafields: batch },
    });
    const json = await res.json();
    const errs = json.data?.metafieldsSet?.userErrors ?? [];
    if (errs.length > 0) {
      throw new Error(
        errs.map((e) => e.message).join(", ") || "metafieldsSet failed"
      );
    }
  }

  const orderFetch = await graphql(
    `#graphql
    query OrderForTagMerge($id: ID!) {
      order(id: $id) {
        id
        tags
        note
      }
    }`,
    { variables: { id: orderGid } }
  );
  const orderJson = await orderFetch.json();
  const order = orderJson.data?.order;
  if (!order) {
    return { copied: true, reason: "metafields_only_order_missing" };
  }

  const orderTags = tagsArray(order.tags);
  const draftTags = tagsArray(draft.tags);
  let mergedTags = [...orderTags];
  for (const t of draftTags) {
    if (!mergedTags.some((x) => x.toLowerCase() === t.toLowerCase())) {
      mergedTags.push(t);
    }
  }

  const draftNote = String(draft.note2 ?? "").trim();
  const orderNote = String(order.note ?? "").trim();
  const noteToSet =
    draftNote && !orderNote ? draftNote : null;

  if (
    mergedTags.length !== orderTags.length ||
    noteToSet != null
  ) {
    const input = { id: orderGid };
    if (mergedTags.length !== orderTags.length) {
      input.tags = mergedTags;
    }
    if (noteToSet != null) {
      input.note = noteToSet;
    }
    const upd = await graphql(ORDER_UPDATE, { variables: { input } });
    const updJson = await upd.json();
    const uErrs = updJson.data?.orderUpdate?.userErrors ?? [];
    if (uErrs.length > 0) {
      throw new Error(
        uErrs.map((e) => e.message).join(", ") || "orderUpdate failed"
      );
    }
  }

  return {
    copied: true,
    metafieldsCopied: inputs.length,
    draftId: draft.id,
  };
}
