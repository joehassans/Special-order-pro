/**
 * Same fulfillment behavior as app/lib/line-item-fulfillment.server.js (Admin API).
 */

export const ORDER_FOR_FULFILLMENT_QUERY = `#graphql
  query OrderForLineItemFulfillment($id: ID!) {
    order(id: $id) {
      id
      fulfillmentOrders(first: 50) {
        edges {
          node {
            id
            status
            lineItems(first: 50) {
              edges {
                node {
                  id
                  remainingQuantity
                  totalQuantity
                  lineItem {
                    id
                  }
                }
              }
            }
          }
        }
      }
      fulfillments(first: 50) {
        id
        status
        fulfillmentLineItems(first: 50) {
          edges {
            node {
              quantity
              lineItem {
                id
              }
            }
          }
        }
      }
    }
  }
`;

export const ORDER_REFRESH_QUERY = `#graphql
  query OrderRefreshForPos($id: ID!) {
    order(id: $id) {
      id
      fulfillmentOrders(first: 50) {
        edges {
          node {
            id
            status
            lineItems(first: 50) {
              edges {
                node {
                  id
                  remainingQuantity
                  totalQuantity
                  lineItem {
                    id
                  }
                }
              }
            }
          }
        }
      }
      fulfillments(first: 50) {
        id
        status
        fulfillmentLineItems(first: 50) {
          edges {
            node {
              quantity
              lineItem {
                id
              }
            }
          }
        }
      }
      lineItems(first: 50) {
        edges {
          node {
            id
            title
            variantTitle
            quantity
            currentQuantity
            originalUnitPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            customAttributes {
              key
              value
            }
          }
        }
      }
    }
  }
`;

const FULFILLMENT_CREATE = `#graphql
  mutation FulfillmentCreate($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const FULFILLMENT_CANCEL = `#graphql
  mutation FulfillmentCancel($id: ID!) {
    fulfillmentCancel(id: $id) {
      fulfillment {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const BLOCKED_FO_STATUSES = new Set(["CLOSED", "CANCELLED", "ON_HOLD"]);

function graphqlUserMessage(json) {
  const parts = (json.errors || []).map((e) => e.message);
  return parts.length ? parts.join("; ") : "";
}

export function computeLineItemFulfillmentUi(
  orderLineItemId,
  fulfillmentOrderEdges,
  fulfillmentEdges
) {
  let totalRemainingAll = 0;
  let totalFoQtyAll = 0;
  let totalRemainingOnOpenFo = 0;

  for (const e of fulfillmentOrderEdges || []) {
    const node = e?.node;
    if (!node) continue;
    const foStatus = String(node.status || "").toUpperCase();
    const blocked = BLOCKED_FO_STATUSES.has(foStatus);
    for (const li of node.lineItems?.edges || []) {
      const foli = li.node;
      if (foli.lineItem?.id !== orderLineItemId) continue;
      const rem = Number(foli.remainingQuantity ?? 0);
      totalRemainingAll += rem;
      totalFoQtyAll += Number(foli.totalQuantity ?? 0);
      if (!blocked) {
        totalRemainingOnOpenFo += rem;
      }
    }
  }

  const canFulfill = totalFoQtyAll > 0 && totalRemainingOnOpenFo > 0;
  const isFullyFulfilled = totalFoQtyAll > 0 && totalRemainingAll === 0;

  const cancelFulfillmentIds = [];
  for (const e of fulfillmentEdges || []) {
    const f = e?.node;
    if (!f?.id) continue;
    const st = String(f.status || "").toUpperCase();
    if (st.includes("CANCEL")) continue;
    const edges = f.fulfillmentLineItems?.edges || [];
    if (edges.length === 0) continue;
    const orderLineIds = new Set(
      edges.map((x) => x.node?.lineItem?.id).filter(Boolean)
    );
    if (orderLineIds.size === 1 && orderLineIds.has(orderLineItemId)) {
      cancelFulfillmentIds.push(f.id);
    }
  }

  const canUnfulfill = isFullyFulfilled && cancelFulfillmentIds.length > 0;
  const unfulfillBlockedMixed =
    isFullyFulfilled && cancelFulfillmentIds.length === 0;

  return {
    canFulfill,
    canUnfulfill,
    unfulfillBlockedMixed,
    cancelFulfillmentIds,
  };
}

export async function fulfillOrderLineItem(graphql, orderId, orderLineItemId) {
  const json = await graphql(ORDER_FOR_FULFILLMENT_QUERY, { id: orderId });
  const gqlErr = graphqlUserMessage(json);
  if (gqlErr) {
    throw new Error(gqlErr);
  }
  const order = json.data?.order;
  if (!order) {
    throw new Error("Order not found.");
  }

  const payloads = [];
  for (const e of order.fulfillmentOrders?.edges || []) {
    const fo = e.node;
    const foStatus = String(fo.status || "").toUpperCase();
    if (BLOCKED_FO_STATUSES.has(foStatus)) {
      continue;
    }
    for (const li of fo.lineItems?.edges || []) {
      const foli = li.node;
      if (foli.lineItem?.id !== orderLineItemId) continue;
      const rem = Number(foli.remainingQuantity ?? 0);
      if (rem <= 0) continue;
      payloads.push({
        fulfillmentOrderId: fo.id,
        fulfillmentOrderLineItems: [{ id: foli.id, quantity: rem }],
      });
    }
  }

  if (payloads.length === 0) {
    const hadBlockedFo = (order.fulfillmentOrders?.edges || []).some((e) => {
      const fo = e?.node;
      if (!fo) return false;
      const st = String(fo.status || "").toUpperCase();
      if (!BLOCKED_FO_STATUSES.has(st)) return false;
      return (fo.lineItems?.edges || []).some((li) => {
        const foli = li.node;
        return (
          foli?.lineItem?.id === orderLineItemId &&
          Number(foli.remainingQuantity ?? 0) > 0
        );
      });
    });
    if (hadBlockedFo) {
      throw new Error(
        "This line item is on hold or not open for fulfillment. Check the order in Shopify admin (fulfillment order status)."
      );
    }
    throw new Error("Nothing to fulfill for this line item.");
  }

  for (const foPayload of payloads) {
    const createJson = await graphql(FULFILLMENT_CREATE, {
      fulfillment: {
        lineItemsByFulfillmentOrder: [foPayload],
        notifyCustomer: false,
      },
    });
    const fc = createJson.data?.fulfillmentCreate;
    const userErrors = fc?.userErrors ?? [];
    if (userErrors.length > 0) {
      throw new Error(
        userErrors.map((e) => e.message).join(", ") || "Fulfillment failed."
      );
    }
    const createGqlErr = graphqlUserMessage(createJson);
    if (createGqlErr) {
      throw new Error(createGqlErr);
    }
    if (!fc?.fulfillment?.id) {
      throw new Error(
        "Shopify did not create a fulfillment. Approve app scopes (assigned / third-party fulfillment orders) or fulfill from Shopify admin."
      );
    }
  }

  return { ok: true };
}

export async function unfulfillOrderLineItem(graphql, orderId, orderLineItemId) {
  const json = await graphql(ORDER_FOR_FULFILLMENT_QUERY, { id: orderId });
  const gqlErr = graphqlUserMessage(json);
  if (gqlErr) {
    throw new Error(gqlErr);
  }
  const order = json.data?.order;
  if (!order) {
    throw new Error("Order not found.");
  }

  const rawFulfillments = order.fulfillments;
  const fulfillmentEdges = Array.isArray(rawFulfillments)
    ? rawFulfillments.map((node) => ({ node }))
    : [];
  const ui = computeLineItemFulfillmentUi(
    orderLineItemId,
    order.fulfillmentOrders?.edges || [],
    fulfillmentEdges
  );

  if (!ui.canUnfulfill) {
    if (ui.unfulfillBlockedMixed) {
      throw new Error(
        "This item was fulfilled with other products. Unfulfill it from Shopify admin."
      );
    }
    throw new Error(
      "This line item is not fully fulfilled or cannot be unfulfilled."
    );
  }

  for (const fid of ui.cancelFulfillmentIds) {
    const cancelJson = await graphql(FULFILLMENT_CANCEL, { id: fid });
    const userErrors = cancelJson.data?.fulfillmentCancel?.userErrors ?? [];
    if (userErrors.length > 0) {
      throw new Error(
        userErrors.map((e) => e.message).join(", ") || "Could not unfulfill."
      );
    }
    const cancelGqlErr = graphqlUserMessage(cancelJson);
    if (cancelGqlErr) {
      throw new Error(cancelGqlErr);
    }
  }

  return { ok: true };
}
