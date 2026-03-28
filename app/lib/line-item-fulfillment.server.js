/**
 * Per–order line item fulfillment using FulfillmentOrder + Fulfillment APIs.
 * Fulfill: fulfillmentCreate with remaining FO line items (grouped by location).
 * Unfulfill: fulfillmentCancel only for fulfillments that contain this order line item alone.
 */

const ORDER_FOR_FULFILLMENT_QUERY = `#graphql
  query OrderForLineItemFulfillment($id: ID!) {
    order(id: $id) {
      id
      fulfillmentOrders(first: 50) {
        edges {
          node {
            id
            assignedLocation {
              id
            }
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

/**
 * @param {string} orderLineItemId
 * @param {Array<{ node: Record<string, unknown> }>} fulfillmentOrderEdges
 * @param {Array<{ node: Record<string, unknown> }>} fulfillmentEdges
 */
export function computeLineItemFulfillmentUi(
  orderLineItemId,
  fulfillmentOrderEdges,
  fulfillmentEdges
) {
  let totalRemaining = 0;
  let totalFoQty = 0;

  for (const e of fulfillmentOrderEdges || []) {
    const node = e.node;
    for (const li of node.lineItems?.edges || []) {
      const foli = li.node;
      if (foli.lineItem?.id !== orderLineItemId) continue;
      totalRemaining += Number(foli.remainingQuantity ?? 0);
      totalFoQty += Number(foli.totalQuantity ?? 0);
    }
  }

  const canFulfill = totalFoQty > 0 && totalRemaining > 0;
  const isFullyFulfilled = totalFoQty > 0 && totalRemaining === 0;

  const cancelFulfillmentIds = [];
  for (const e of fulfillmentEdges || []) {
    const f = e.node;
    if (String(f.status || "").toUpperCase() === "CANCELLED") continue;
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
  const res = await graphql(ORDER_FOR_FULFILLMENT_QUERY, {
    variables: { id: orderId },
  });
  const json = await res.json();
  const order = json.data?.order;
  if (!order) {
    throw new Error("Order not found.");
  }

  /** @type {Map<string, Array<{ fulfillmentOrderId: string, id: string, quantity: number }>>} */
  const byLocation = new Map();

  for (const e of order.fulfillmentOrders?.edges || []) {
    const fo = e.node;
    const locId = fo.assignedLocation?.id || "_default";
    for (const li of fo.lineItems?.edges || []) {
      const foli = li.node;
      if (foli.lineItem?.id !== orderLineItemId) continue;
      const rem = Number(foli.remainingQuantity ?? 0);
      if (rem <= 0) continue;
      if (!byLocation.has(locId)) byLocation.set(locId, []);
      byLocation.get(locId).push({
        fulfillmentOrderId: fo.id,
        id: foli.id,
        quantity: rem,
      });
    }
  }

  if (byLocation.size === 0) {
    throw new Error("Nothing to fulfill for this line item.");
  }

  for (const [, rows] of byLocation) {
    /** @type {Map<string, Array<{ id: string, quantity: number }>>} */
    const byFo = new Map();
    for (const row of rows) {
      if (!byFo.has(row.fulfillmentOrderId)) {
        byFo.set(row.fulfillmentOrderId, []);
      }
      byFo.get(row.fulfillmentOrderId).push({
        id: row.id,
        quantity: row.quantity,
      });
    }

    const lineItemsByFulfillmentOrder = [...byFo.entries()].map(
      ([fulfillmentOrderId, fulfillmentOrderLineItems]) => ({
        fulfillmentOrderId,
        fulfillmentOrderLineItems,
      })
    );

    const createRes = await graphql(FULFILLMENT_CREATE, {
      variables: {
        fulfillment: {
          lineItemsByFulfillmentOrder,
          notifyCustomer: false,
        },
      },
    });
    const createJson = await createRes.json();
    const userErrors = createJson.data?.fulfillmentCreate?.userErrors ?? [];
    if (userErrors.length > 0) {
      throw new Error(
        userErrors.map((e) => e.message).join(", ") || "Fulfillment failed."
      );
    }
    if (createJson.errors?.length) {
      throw new Error(
        createJson.errors.map((e) => e.message).join(", ") ||
          "Fulfillment failed."
      );
    }
  }

  return { ok: true };
}

export async function unfulfillOrderLineItem(graphql, orderId, orderLineItemId) {
  const res = await graphql(ORDER_FOR_FULFILLMENT_QUERY, {
    variables: { id: orderId },
  });
  const json = await res.json();
  const order = json.data?.order;
  if (!order) {
    throw new Error("Order not found.");
  }

  const fulfillmentEdges = (order.fulfillments || []).map((node) => ({
    node,
  }));
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
    throw new Error("This line item is not fully fulfilled or cannot be unfulfilled.");
  }

  for (const fid of ui.cancelFulfillmentIds) {
    const cancelRes = await graphql(FULFILLMENT_CANCEL, { variables: { id: fid } });
    const cancelJson = await cancelRes.json();
    const userErrors = cancelJson.data?.fulfillmentCancel?.userErrors ?? [];
    if (userErrors.length > 0) {
      throw new Error(
        userErrors.map((e) => e.message).join(", ") || "Could not unfulfill."
      );
    }
    if (cancelJson.errors?.length) {
      throw new Error(
        cancelJson.errors.map((e) => e.message).join(", ") ||
          "Could not unfulfill."
      );
    }
  }

  return { ok: true };
}
