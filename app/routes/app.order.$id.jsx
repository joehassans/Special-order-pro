import { useEffect, useState } from "react";
import { redirect, useLoaderData, useSubmit } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

function formatMoneySet(moneySet) {
  if (!moneySet || !moneySet.shopMoney) return null;
  const { amount, currencyCode } = moneySet.shopMoney;
  return `${amount} ${currencyCode}`;
}

function formatMoney(amount, currencyCode) {
  if (amount == null || currencyCode == null) return null;
  return `${amount} ${currencyCode}`;
}

function formatUsPhone(phone) {
  if (!phone) return "";
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length === 10) {
    const area = digits.slice(0, 3);
    const prefix = digits.slice(3, 6);
    const line = digits.slice(6);
    return `+1 (${area}) ${prefix}-${line}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    const area = digits.slice(1, 4);
    const prefix = digits.slice(4, 7);
    const line = digits.slice(7);
    return `+1 (${area}) ${prefix}-${line}`;
  }
  return phone;
}

const VALID_CONTACT_STATUSES = [
  "Not Contacted",
  "No Answer",
  "Left Message",
  "Spoke to Customer",
];

function extractContactStatusFromMetafields(metafields) {
  if (!metafields || !metafields.edges) return "Not Contacted";
  const entry = metafields.edges.find(
    (edge) => edge.node.key === "contact_status"
  );
  const value = entry?.node?.value?.trim();
  if (value && VALID_CONTACT_STATUSES.includes(value)) {
    return value;
  }
  return "Not Contacted";
}

function extractOverallOrderStatusFromMetafields(metafields) {
  if (!metafields || !metafields.edges) return "Order Pending";
  const entry = metafields.edges.find(
    (edge) => edge.node.key === "overall_order_status"
  );
  return entry?.node?.value || "Order Pending";
}

function normalizeText(text) {
  return String(text || "").toLowerCase().trim();
}

function getOrderStatusTone(status) {
  const s = normalizeText(status);
  if (!s || s === "not set") return "subdued";
  if (s.includes("not ordered") || s.includes("canceled")) return "critical";
  if (s.includes("back ordered")) return "info";
  if (s.includes("ordered") || s.includes("received")) return "success";
  if (s.includes("picked up")) return "success";
  return "subdued";
}

/** Returns { background, border } for the order status dropdown wrapper. */
function getOrderStatusWrapperColors(status) {
  const s = normalizeText(status || "");
  // Critical: Not Ordered, Canceled, Order Canceled
  if (!s || s.includes("not ordered") || s.includes("canceled")) {
    return { background: "#ffebee", border: "#c62828" };
  }
  // Info: Back Ordered
  if (s.includes("back ordered")) {
    return { background: "#e3f2fd", border: "#1976d2" };
  }
  // Success: Ordered, Received
  if (s.includes("ordered") || s.includes("received") || s.includes("picked up")) {
    return { background: "#e8f5e9", border: "#2e7d32" };
  }
  return { background: "#f4f6f8", border: "#5c6ac4" };
}

function getPaymentStatusTone(status) {
  const s = normalizeText(status);
  if (!s) return "subdued";
  // Not Paid -> red
  if (s === "not paid" || s.includes("not paid")) return "critical";
  // Partially Paid -> orange
  if (s === "partially paid" || s.includes("partially paid"))
    return "warning";
  // Paid in Full -> green
  if (s === "paid in full" || s === "paid" || s.includes("paid in full"))
    return "success";
  return "subdued";
}

function getContactStatusTone(status) {
  const s = String(status || "").toLowerCase().trim();
  if (!s || s === "not set" || s === "not contacted") return "critical";
  if (s.includes("order canceled") || s.includes("canceled")) return "critical";
  if (s.includes("order pending")) return "neutral";
  if (s.includes("no answer")) return "critical";
  if (s.includes("left message")) return "warning";
  if (s.includes("spoke to customer")) return "success";
  if (s.includes("picked up") || s.includes("sale complete")) return "success";
  return "critical";
}

function getOverallOrderStatusTone(status) {
  const s = String(status || "").toLowerCase().trim();
  if (s.includes("order pending")) return "warning";
  if (s.includes("picked up") || s.includes("sale complete")) return "success";
  if (s.includes("order canceled")) return "critical";
  return "warning";
}

function isCompletedContactStatus(status) {
  if (!status) return false;
  const normalized = String(status)
    .toLowerCase()
    .replace(/[\s/\\-]+/g, "");
  return normalized.includes("pickedupsalecomplete");
}

const ALWAYS_PRESENT_ATTRIBUTES = ["Brand", "Type", "Style #", "Size", "Color", "Date Ordered"];
const HIDDEN_ATTRIBUTES = new Set([
  "_shopify_item_type",
  "Order Status",
  "Initial Status",
  "Special Order",
]);

function getAttributesForDisplay(attrs) {
  const map = new Map();
  for (const a of attrs || []) {
    if (!HIDDEN_ATTRIBUTES.has(a.key)) {
      map.set(a.key, a.value || "");
    }
  }
  const result = [];
  for (const key of ALWAYS_PRESENT_ATTRIBUTES) {
    result.push({ key, value: map.get(key) || "" });
  }
  for (const [key, value] of map) {
    if (!ALWAYS_PRESENT_ATTRIBUTES.includes(key)) {
      result.push({ key, value });
    }
  }
  return result;
}

function extractItemStatusFromMetafields(metafields, index, customAttributes) {
  const position = index + 1;
  const key = `product_${position}_order_status`;

  // Try order-level metafield first
  if (metafields && metafields.edges) {
    const statusMf = metafields.edges.find(
      (edge) => edge.node.key === key
    );
    if (statusMf && statusMf.node.value) {
      return statusMf.node.value;
    }
  }

  // Fallback to line item custom attributes: "Order Status" or "Initial Status"
  if (customAttributes && customAttributes.length > 0) {
    const orderStatusAttr = customAttributes.find(
      (a) => a.key === "Order Status"
    );
    if (orderStatusAttr && orderStatusAttr.value) {
      return orderStatusAttr.value;
    }
    const initialStatusAttr = customAttributes.find(
      (a) => a.key === "Initial Status"
    );
    if (initialStatusAttr && initialStatusAttr.value) {
      return initialStatusAttr.value;
    }
  }

  return "";
}

export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const id = params.id;

  if (!id) {
    throw new Response("Missing order id", { status: 400 });
  }

  const isDraftOrder = id.includes("DraftOrder");

  if (isDraftOrder) {
    const response = await admin.graphql(
      `#graphql
      query GetDraftOrderDetails($id: ID!) {
        draftOrder(id: $id) {
          id
          name
          createdAt
          updatedAt
          tags
          note2
          subtotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalTaxSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          invoiceUrl
          customer {
            id
            displayName
            email
            phone
            defaultAddress {
              address1
              address2
              city
              province
              zip
              country
              company
            }
          }
          metafields(first: 250, namespace: "custom") {
            edges {
              node {
                key
                value
              }
            }
          }
          lineItems(first: 50) {
            edges {
              node {
                id
                title
                quantity
                variant {
                  title
                }
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
      }`,
      {
        variables: { id },
      }
    );

    const json = await response.json();
    const draftOrder = json.data?.draftOrder;

    if (!draftOrder) {
      throw new Response("Draft order not found", { status: 404 });
    }

    const metafields = draftOrder.metafields || { edges: [] };

    const attributesOverridesByIndex = {};
    metafields.edges.forEach((edge) => {
      const key = edge.node.key;
      if (key.startsWith("lineitem_") && key.endsWith("_attributes")) {
        const middle = key.slice("lineitem_".length, -"_attributes".length);
        const idx = Number(middle) - 1;
        if (!Number.isNaN(idx)) {
          try {
            const parsed = JSON.parse(edge.node.value);
            if (Array.isArray(parsed)) {
              attributesOverridesByIndex[idx] = parsed;
            }
          } catch {
            // ignore malformed JSON
          }
        }
      }
    });

    const contactStatus = extractContactStatusFromMetafields(metafields);
    const overallOrderStatus = extractOverallOrderStatusFromMetafields(metafields);

    const normalized = {
      type: "draft",
      id: draftOrder.id,
      name: draftOrder.name,
      createdAt: draftOrder.createdAt,
      updatedAt: draftOrder.updatedAt,
      tags: draftOrder.tags || [],
      note: draftOrder.note2 || "",
      contactStatus,
      overallOrderStatus,
      subtotal: formatMoneySet(draftOrder.subtotalPriceSet),
      tax: formatMoneySet(draftOrder.totalTaxSet),
      total: formatMoneySet(draftOrder.totalPriceSet),
      outstanding: null, // Draft orders don't have outstanding set in same way
      invoiceUrl: draftOrder.invoiceUrl || null,
      customer: draftOrder.customer || null,
      lineItems:
        draftOrder.lineItems?.edges?.map((edge, index) => {
          const li = edge.node;
          const itemStatus = extractItemStatusFromMetafields(
            metafields,
            index,
            li.customAttributes
          );
          return {
            id: li.id,
            title: li.title,
            quantity: li.quantity,
            variantTitle: li.variant?.title || null,
            pricePerItem: formatMoneySet(li.originalUnitPriceSet),
            customAttributes: getAttributesForDisplay(
              attributesOverridesByIndex[index] || li.customAttributes || []
            ),
            orderStatus: itemStatus,
          };
        }) ?? [],
    };

    return { order: normalized };
  } else {
    const response = await admin.graphql(
      `#graphql
      query GetOrderDetails($id: ID!) {
        order(id: $id) {
          id
          name
          createdAt
          updatedAt
          tags
          note
          displayFinancialStatus
          subtotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalTaxSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalOutstandingSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          customer {
            id
            displayName
            email
            phone
            defaultAddress {
              address1
              address2
              city
              province
              zip
              country
              company
            }
          }
          metafields(first: 250, namespace: "custom") {
            edges {
              node {
                key
                value
              }
            }
          }
          lineItems(first: 50) {
            edges {
              node {
                id
                title
                quantity
                variantTitle
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
      }`,
      {
        variables: { id },
      }
    );

    const json = await response.json();
    const order = json.data?.order;

    if (!order) {
      throw new Response("Order not found", { status: 404 });
    }

    const metafields = order.metafields || { edges: [] };

    const attributesOverridesByIndex = {};
    metafields.edges.forEach((edge) => {
      const key = edge.node.key;
      if (key.startsWith("lineitem_") && key.endsWith("_attributes")) {
        const middle = key.slice("lineitem_".length, -"_attributes".length);
        const idx = Number(middle) - 1;
        if (!Number.isNaN(idx)) {
          try {
            const parsed = JSON.parse(edge.node.value);
            if (Array.isArray(parsed)) {
              attributesOverridesByIndex[idx] = parsed;
            }
          } catch {
            // ignore malformed JSON
          }
        }
      }
    });

    const contactStatus = extractContactStatusFromMetafields(metafields);
    const overallOrderStatus = extractOverallOrderStatusFromMetafields(metafields);

    let paid = null;
    if (
      order.totalPriceSet?.shopMoney &&
      order.totalOutstandingSet?.shopMoney
    ) {
      const totalAmount = parseFloat(order.totalPriceSet.shopMoney.amount);
      const outstandingAmount = parseFloat(
        order.totalOutstandingSet.shopMoney.amount
      );
      const paidAmount = totalAmount - outstandingAmount;
      paid = formatMoney(paidAmount.toFixed(2), order.totalPriceSet.shopMoney.currencyCode);
    }

    const normalized = {
      type: "order",
      id: order.id,
      name: order.name,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      tags: order.tags || [],
      note: order.note || "",
      contactStatus,
      overallOrderStatus,
      subtotal: formatMoneySet(order.subtotalPriceSet),
      tax: formatMoneySet(order.totalTaxSet),
      total: formatMoneySet(order.totalPriceSet),
      outstanding: formatMoneySet(order.totalOutstandingSet),
      paid,
      customer: order.customer || null,
      lineItems:
        order.lineItems?.edges?.map((edge, index) => {
          const li = edge.node;
          const itemStatus = extractItemStatusFromMetafields(
            metafields,
            index,
            attributesOverridesByIndex[index] || li.customAttributes
          );
          return {
            id: li.id,
            title: li.title,
            quantity: li.quantity,
            variantTitle: li.variantTitle || null,
            pricePerItem: formatMoneySet(li.originalUnitPriceSet),
            customAttributes: getAttributesForDisplay(
              attributesOverridesByIndex[index] || li.customAttributes || []
            ),
            orderStatus: itemStatus,
          };
        }) ?? [],
    };

    return { order: normalized };
  }
};

const METAFIELDS_SET = `#graphql
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
        value
        type
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const UPDATE_DRAFT_ORDER_NOTE = `#graphql
  mutation DraftOrderUpdateNote($id: ID!, $input: DraftOrderInput!) {
    draftOrderUpdate(id: $id, input: $input) {
      draftOrder {
        id
        note2
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const UPDATE_ORDER_NOTE = `#graphql
  mutation OrderUpdateNote($input: OrderInput!) {
    orderUpdate(input: $input) {
      order {
        id
        note
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const action = async ({ request }) => {
  const formData = await request.formData();
  const intent = formData.get("intent");
  const orderId = formData.get("orderId");

  if (!orderId) {
    return redirect(request.url);
  }

  const { admin } = await authenticate.admin(request);

  if (intent === "updateNote") {
    const note = formData.get("note") ?? "";
    const isDraftOrder = String(orderId).includes("DraftOrder");

    if (isDraftOrder) {
      const updateResponse = await admin.graphql(UPDATE_DRAFT_ORDER_NOTE, {
        variables: {
          id: orderId,
          input: {
            note: String(note),
          },
        },
      });

      const updateJson = await updateResponse.json();
      const userErrors = updateJson.data?.draftOrderUpdate?.userErrors ?? [];

      if (userErrors.length > 0) {
        throw new Error(
          userErrors.map((e) => e.message).join(", ") ||
            "Failed to update draft order note."
        );
      }
    } else {
      const updateResponse = await admin.graphql(UPDATE_ORDER_NOTE, {
        variables: {
          input: {
            id: orderId,
            note: String(note),
          },
        },
      });

      const updateJson = await updateResponse.json();
      const userErrors = updateJson.data?.orderUpdate?.userErrors ?? [];

      if (userErrors.length > 0) {
        throw new Error(
          userErrors.map((e) => e.message).join(", ") ||
            "Failed to update order note."
        );
      }
    }

    return redirect(request.url);
  }

  if (intent === "updateContactStatus") {
    const contactStatus = formData.get("contactStatus") ?? "";

    const metaResponse = await admin.graphql(METAFIELDS_SET, {
      variables: {
        metafields: [
          {
            ownerId: orderId,
            namespace: "custom",
            key: "contact_status",
            value: String(contactStatus),
            type: "single_line_text_field",
          },
        ],
      },
    });

    const metaJson = await metaResponse.json();
    const metaErrors = metaJson.data?.metafieldsSet?.userErrors ?? [];

    if (metaErrors.length > 0) {
      throw new Error(
        metaErrors.map((e) => e.message).join(", ") ||
          "Failed to update contact status."
      );
    }

    return redirect(request.url);
  }

  if (intent === "updateOverallOrderStatus") {
    const overallOrderStatus = formData.get("overallOrderStatus") ?? "Order Pending";

    const metaResponse = await admin.graphql(METAFIELDS_SET, {
      variables: {
        metafields: [
          {
            ownerId: orderId,
            namespace: "custom",
            key: "overall_order_status",
            value: String(overallOrderStatus),
            type: "single_line_text_field",
          },
        ],
      },
    });

    const metaJson = await metaResponse.json();
    const metaErrors = metaJson.data?.metafieldsSet?.userErrors ?? [];

    if (metaErrors.length > 0) {
      throw new Error(
        metaErrors.map((e) => e.message).join(", ") ||
          "Failed to update overall order status."
      );
    }

    return redirect(request.url);
  }

  if (intent === "updateAttributes") {
    const rawIndex = formData.get("lineItemIndex");
    const attributesJson = formData.get("attributes");
    if (!rawIndex || attributesJson == null) {
      return redirect(request.url);
    }
    const index = Number(rawIndex);
    if (Number.isNaN(index)) {
      return redirect(request.url);
    }

    const metafieldKey = `lineitem_${index + 1}_attributes`;
    const metaResponse = await admin.graphql(METAFIELDS_SET, {
      variables: {
        metafields: [
          {
            ownerId: orderId,
            namespace: "custom",
            key: metafieldKey,
            value: String(attributesJson),
            type: "json",
          },
        ],
      },
    });

    const metaJson = await metaResponse.json();
    const metaErrors = metaJson.data?.metafieldsSet?.userErrors ?? [];

    if (metaErrors.length > 0) {
      throw new Error(
        metaErrors.map((e) => e.message).join(", ") ||
          "Failed to update line item attributes."
      );
    }

    return redirect(request.url);
  }

  const lineItemId = formData.get("lineItemId");
  const newStatus = formData.get("orderStatus");

  if (!lineItemId) {
    return redirect(request.url);
  }

  const isDraftOrder = String(orderId).includes("DraftOrder");

  if (!isDraftOrder) {
    // Placed orders: use order(id)
    const detailsResponse = await admin.graphql(
      `#graphql
        query GetOrderForStatusUpdate($id: ID!) {
          order(id: $id) {
            id
            lineItems(first: 50) {
              edges {
                node {
                  id
                }
              }
            }
          }
        }
      `,
      {
        variables: { id: orderId },
      }
    );

    const detailsJson = await detailsResponse.json();
    const order = detailsJson.data?.order;

    if (!order) {
      return redirect(request.url);
    }

    const index = order.lineItems?.edges?.findIndex(
      (edge) => edge.node.id === lineItemId
    );

    if (index == null || index === -1) {
      return redirect(request.url);
    }

    const metafieldKey = `product_${index + 1}_order_status`;

    const metaResponse = await admin.graphql(METAFIELDS_SET, {
      variables: {
        metafields: [
          {
            ownerId: orderId,
            namespace: "custom",
            key: metafieldKey,
            value: newStatus || "",
            type: "single_line_text_field",
          },
        ],
      },
    });

    const metaJson = await metaResponse.json();
    const metaErrors = metaJson.data?.metafieldsSet?.userErrors ?? [];

    if (metaErrors.length > 0) {
      throw new Error(
        metaErrors.map((e) => e.message).join(", ") ||
          "Failed to update order status metafield."
      );
    }
  } else {
    // Draft orders: use draftOrder(id)
    const detailsResponse = await admin.graphql(
      `#graphql
        query GetDraftOrderForStatusUpdate($id: ID!) {
          draftOrder(id: $id) {
            id
            lineItems(first: 50) {
              edges {
                node {
                  id
                }
              }
            }
          }
        }
      `,
      {
        variables: { id: orderId },
      }
    );

    const detailsJson = await detailsResponse.json();
    const draftOrder = detailsJson.data?.draftOrder;

    if (!draftOrder) {
      return redirect(request.url);
    }

    const index = draftOrder.lineItems?.edges?.findIndex(
      (edge) => edge.node.id === lineItemId
    );

    if (index == null || index === -1) {
      return redirect(request.url);
    }

    const metafieldKey = `product_${index + 1}_order_status`;

    const metaResponse = await admin.graphql(METAFIELDS_SET, {
      variables: {
        metafields: [
          {
            ownerId: orderId,
            namespace: "custom",
            key: metafieldKey,
            value: newStatus || "",
            type: "single_line_text_field",
          },
        ],
      },
    });

    const metaJson = await metaResponse.json();
    const metaErrors = metaJson.data?.metafieldsSet?.userErrors ?? [];

    if (metaErrors.length > 0) {
      throw new Error(
        metaErrors.map((e) => e.message).join(", ") ||
          "Failed to update order status metafield."
      );
    }
  }

  return redirect(request.url);
};

export default function OrderDetails() {
  const { order } = useLoaderData();
  const submit = useSubmit();
  const [note, setNote] = useState(order.note || "");
  const [openItems, setOpenItems] = useState(() => {
    const initial = {};
    (order.lineItems || []).forEach((item) => {
      initial[item.id] = true;
    });
    return initial;
  });

  useEffect(() => {
    setNote(order.note || "");
  }, [order.note]);

  useEffect(() => {
    const initial = {};
    (order.lineItems || []).forEach((item) => {
      initial[item.id] = true;
    });
    setOpenItems(initial);
  }, [order.id]);

  const createdLabel = new Date(order.createdAt).toLocaleString();
  const updatedLabel = new Date(order.updatedAt).toLocaleString();
  const paymentStatusLabel =
    order.type === "draft"
      ? "Not Paid"
      : order.outstanding
        ? "Partially Paid"
        : "Paid in Full";
  const adminId = String(order.id).split("/").pop();
  const adminHref =
    order.type === "draft"
      ? `shopify://admin/draft_orders/${adminId}`
      : `shopify://admin/orders/${adminId}`;

  return (
    <s-page
      heading={order.name}
      inlineSize="large"
    >
      <style>{`
        .order-status-dropdown-wrapper {
          border-radius: 8px;
          padding: 12px 16px;
          display: inline-flex;
          align-items: center;
          gap: 12px;
          border: 2px solid;
        }
        .item-detail-field {
          min-width: 280px;
          width: 280px;
          flex: 0 0 280px;
        }
        .item-detail-field s-text-field {
          display: block;
          width: 100%;
          min-width: 100%;
        }
        .item-detail-field .field-label {
          font-weight: 700 !important;
        }
      `}</style>
      {/* Top bar: back link + order meta */}
      <s-section>
        <s-stack direction="inline" alignItems="center" justifyContent="space-between">
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-button
              variant="secondary"
              href="/app"
              size="large"
              style={{ fontWeight: 600 }}
            >
              ← All Orders
            </s-button>
          </s-stack>
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-badge tone={order.type === "draft" ? "warning" : "success"}>
              {order.type === "draft" ? "Draft order" : "Order"}
            </s-badge>
            {order.tags &&
              order.tags.length > 0 && (
                <s-stack direction="inline" gap="small">
                  {order.tags.map((tag) => (
                    <s-badge key={tag} tone="subdued">
                      {tag}
                    </s-badge>
                  ))}
                </s-stack>
              )}
          </s-stack>
        </s-stack>
      </s-section>

      {/* Customer info + Contact status + Payment status top row */}
      <s-section>
        <s-stack direction="inline" gap="large" alignItems="stretch">
          {/* Customer */}
          <s-box
            padding="base"
            borderRadius="base"
            borderWidth="base"
            background="subdued"
            flex="2"
          >
            <s-stack gap="small">
              <s-heading size="large" style={{ fontSize: "1.6rem" }}>
                👤 CUSTOMER INFORMATION
              </s-heading>
              {order.customer ? (
                <s-stack gap="small" alignItems="start">
                  <s-heading>{order.customer.displayName}</s-heading>
                  {order.customer.email && (
                    <s-text color="subdued">
                      {order.customer.email}
                    </s-text>
                  )}
                  {order.customer.phone && (
                    <s-text type="strong">
                      {formatUsPhone(order.customer.phone)}
                    </s-text>
                  )}
                  {order.customer.defaultAddress && (
                    <s-stack gap="small-300" alignItems="start">
                      {order.customer.defaultAddress.company && (
                        <s-text color="subdued">
                          {order.customer.defaultAddress.company}
                        </s-text>
                      )}
                      <s-text color="subdued">
                        {order.customer.defaultAddress.address1}
                      </s-text>
                      {order.customer.defaultAddress.address2 && (
                        <s-text color="subdued">
                          {order.customer.defaultAddress.address2}
                        </s-text>
                      )}
                      <s-text color="subdued">
                        {[order.customer.defaultAddress.city,
                          order.customer.defaultAddress.province,
                          order.customer.defaultAddress.zip]
                          .filter(Boolean)
                          .join(", ")}
                      </s-text>
                    </s-stack>
                  )}
                </s-stack>
              ) : (
                <s-text color="subdued">
                  No customer information available
                </s-text>
              )}
            </s-stack>
          </s-box>

          {/* Contact status */}
          <s-box
            padding="base"
            borderRadius="base"
            borderWidth="base"
            background="subdued"
            flex="1"
          >
            <s-stack gap="small">
              <s-heading size="large" style={{ fontSize: "1.6rem" }}>
                ☎️ CONTACT STATUS
              </s-heading>
              <s-select
                value={
                  ["Not Contacted", "No Answer", "Left Message", "Spoke to Customer"].includes(
                    order.contactStatus || ""
                  )
                    ? order.contactStatus || "Not Contacted"
                    : "Not Contacted"
                }
                onChange={(event) => {
                  submit(
                    {
                      intent: "updateContactStatus",
                      orderId: order.id,
                      contactStatus: event.currentTarget.value,
                    },
                    { method: "post" }
                  );
                }}
              >
                <s-option value="Not Contacted">Not Contacted</s-option>
                <s-option value="No Answer">No Answer</s-option>
                <s-option value="Left Message">Left Message</s-option>
                <s-option value="Spoke to Customer">Spoke to Customer</s-option>
              </s-select>
              <s-badge tone={getContactStatusTone(order.contactStatus)}>
                {["Not Contacted", "No Answer", "Left Message", "Spoke to Customer"].includes(
                  order.contactStatus || ""
                )
                  ? order.contactStatus || "Not Contacted"
                  : "Not Contacted"}
              </s-badge>
            </s-stack>
          </s-box>

          {/* Overall order status */}
          <s-box
            padding="base"
            borderRadius="base"
            borderWidth="base"
            background="subdued"
            flex="1"
          >
            <s-stack gap="small">
              <s-heading size="large" style={{ fontSize: "1.6rem" }}>
                ✓ OVERALL ORDER STATUS
              </s-heading>
              <s-select
                value={
                  ["Order Pending", "Picked Up - Sale Complete", "Order Canceled"].includes(
                    order.overallOrderStatus || ""
                  )
                    ? order.overallOrderStatus
                    : "Order Pending"
                }
                onChange={(event) => {
                  submit(
                    {
                      intent: "updateOverallOrderStatus",
                      orderId: order.id,
                      overallOrderStatus: event.currentTarget.value,
                    },
                    { method: "post" }
                  );
                }}
              >
                <s-option value="Order Pending">Order Pending</s-option>
                <s-option value="Picked Up - Sale Complete">
                  Picked Up - Sale Complete
                </s-option>
                <s-option value="Order Canceled">Order Canceled</s-option>
              </s-select>
              <s-badge tone={getOverallOrderStatusTone(order.overallOrderStatus)}>
                {["Order Pending", "Picked Up - Sale Complete", "Order Canceled"].includes(
                  order.overallOrderStatus || ""
                )
                  ? order.overallOrderStatus
                  : "Order Pending"}
              </s-badge>
            </s-stack>
          </s-box>

          {/* Payment */}
          <s-box
            padding="base"
            borderRadius="base"
            borderWidth="base"
            background="subdued"
            flex="1"
          >
            <s-stack gap="small">
              <s-heading size="large" style={{ fontSize: "1.6rem" }}>
                💲 PAYMENT STATUS
              </s-heading>
              <s-badge tone={getPaymentStatusTone(paymentStatusLabel)}>
                {paymentStatusLabel}
              </s-badge>
              {order.subtotal && <s-text>Subtotal: {order.subtotal}</s-text>}
              {order.tax && <s-text>Tax: {order.tax}</s-text>}
              {order.total && <s-text>Total: {order.total}</s-text>}
              {order.outstanding && (
                <s-text>Balance: {order.outstanding}</s-text>
              )}
              {order.paid && <s-text>Paid: {order.paid}</s-text>}
            </s-stack>
          </s-box>

        </s-stack>
      </s-section>

      {/* Notes */}
      <s-section>
        <s-box
          padding="small-500"
          borderRadius="base"
          borderWidth="base"
          background="subdued"
        >
          <s-stack gap="small-500">
            <s-heading size="large" style={{ fontSize: "1.6rem" }}>
              NOTES
            </s-heading>
            <s-text-area
              label="Notes"
              labelAccessibilityVisibility="exclusive"
              value={note}
              onInput={(event) => setNote(event.currentTarget.value)}
              placeholder="Add notes about this order..."
            />
            <s-stack direction="inline" justifyContent="end" gap="small-500">
              <s-button
                variant="primary"
                onClick={() => {
                  submit(
                    { intent: "updateNote", orderId: order.id, note },
                    { method: "post" }
                  );
                }}
              >
                Save note
              </s-button>
            </s-stack>
          </s-stack>
        </s-box>
      </s-section>

      {/* Line items */}
      <s-section>
        <s-stack gap="base">
          <s-heading size="large" style={{ fontSize: "1.6rem" }}>
            ITEMS
          </s-heading>
          {order.lineItems.length === 0 ? (
            <s-text color="subdued">No line items</s-text>
          ) : (
            <s-stack gap="base">
              {order.lineItems.map((item, idx) => (
                <s-box
                  key={item.id}
                  padding="base"
                  borderRadius="base"
                  borderWidth="base"
                  background={idx % 2 === 0 ? "subdued" : "base"}
                  data-line-index={idx}
                >
                  <s-stack gap="small-300">
                    <s-stack gap="small-300" style={{ cursor: "pointer" }}
                      onClick={() =>
                        setOpenItems((prev) => ({
                          ...prev,
                          [item.id]: !prev[item.id],
                        }))
                      }
                    >
                      <s-stack direction="inline" gap="small" alignItems="center" justifyContent="space-between">
                        <s-stack direction="inline" gap="small" alignItems="center">
                          <s-text
                            color="subdued"
                            style={{
                              fontSize: "1.25rem",
                              transition: "transform 0.2s ease",
                              transform: openItems[item.id]
                                ? "rotate(180deg)"
                                : "rotate(0deg)",
                            }}
                            aria-hidden
                          >
                            ▼
                          </s-text>
                          <s-badge
                            tone="info"
                            color="strong"
                            style={{
                              fontWeight: 700,
                              fontSize: "1.25rem",
                              minWidth: "2.2rem",
                              textAlign: "center",
                            }}
                          >
                            {idx + 1}
                          </s-badge>
                          <s-heading size="large" style={{ fontSize: "1.5rem" }}>
                            {String(item.title || "").toUpperCase()}
                          </s-heading>
                        </s-stack>
                        <s-stack direction="inline" gap="small" alignItems="center">
                          <s-badge tone={getOrderStatusTone(item.orderStatus)}>
                            {item.orderStatus || "Not set"}
                          </s-badge>
                          <s-text color="subdued">
                            {openItems[item.id] ? "Hide details" : "Show details"}
                          </s-text>
                        </s-stack>
                      </s-stack>
                      <s-stack direction="inline" gap="small">
                        <s-text>Qty: {item.quantity}</s-text>
                        {item.pricePerItem && (
                          <s-text>{item.pricePerItem}</s-text>
                        )}
                      </s-stack>
                    </s-stack>
                    {openItems[item.id] && (
                      <s-stack gap="small-300">
                        {item.variantTitle && (
                          <s-text color="subdued">
                            {item.variantTitle}
                          </s-text>
                        )}

                        {/* ITEM ORDER STATUS - right under title */}
                        <s-stack gap="small" style={{ paddingTop: "1rem" }}>
                          <s-heading size="large" style={{ fontSize: "1.5rem" }}>
                            ITEM ORDER STATUS
                          </s-heading>
                          {(() => {
                            const colors = getOrderStatusWrapperColors(
                              item.orderStatus
                            );
                            return (
                              <div
                                className="order-status-dropdown-wrapper"
                                style={{
                                  backgroundColor: colors.background,
                                  borderColor: colors.border,
                                }}
                              >
                                <s-select
                              value={item.orderStatus || "Not Ordered"}
                              onChange={(event) => {
                                submit(
                                  {
                                    orderId: order.id,
                                    lineItemId: item.id,
                                    orderStatus: event.currentTarget.value,
                                  },
                                  { method: "post" }
                                );
                              }}
                            >
                              <s-option value="Not Ordered">Not Ordered</s-option>
                              <s-option value="Ordered">Ordered</s-option>
                              <s-option value="Back Ordered">
                                Back Ordered
                              </s-option>
                              <s-option value="Received">Received</s-option>
                              <s-option value="Canceled">Canceled</s-option>
                                </s-select>
                                <s-badge tone={getOrderStatusTone(item.orderStatus)}>
                                  {item.orderStatus || "Not set"}
                                </s-badge>
                              </div>
                            );
                          })()}
                        </s-stack>

                        {/* Editable attributes (metafield-backed); Brand, Type, Style #, Size, Color on one row */}
                        <s-stack gap="small-300">
                          <div
                            style={{
                              display: "flex",
                              flexWrap: "wrap",
                              gap: "12px",
                              alignItems: "flex-start",
                            }}
                          >
                            {(item.customAttributes || [])
                              .filter((a) =>
                                ["Brand", "Type", "Style #", "Size", "Color", "Date Ordered"].includes(a.key)
                              )
                              .map((attr) => (
                                <div key={attr.key} className="item-detail-field">
                                  <s-stack gap="small-300">
                                    <span className="field-label" style={{ fontWeight: 700 }}>{attr.key}</span>
                                    {attr.key === "Date Ordered" ? (
                                      <s-date-field
                                        data-attr-key={attr.key}
                                        label=""
                                        labelAccessibilityVisibility="hidden"
                                        value={attr.value || ""}
                                        placeholder="Select date"
                                      />
                                    ) : (
                                      <s-text-field
                                        data-attr-key={attr.key}
                                        label=""
                                        labelAccessibilityVisibility="hidden"
                                        value={attr.value || ""}
                                      />
                                    )}
                                  </s-stack>
                                </div>
                              ))}
                          </div>
                          {(item.customAttributes || [])
                            .filter(
                              (a) =>
                                !["Brand", "Type", "Style #", "Size", "Color", "Date Ordered"].includes(a.key)
                            )
                            .map((attr) => (
                              <div key={attr.key} className="item-detail-field">
                                <s-stack gap="small-300">
                                  <span className="field-label" style={{ fontWeight: 700 }}>{attr.key}</span>
                                  <s-text-field
                                    data-attr-key={attr.key}
                                    label=""
                                    labelAccessibilityVisibility="hidden"
                                    value={attr.value || ""}
                                  />
                                </s-stack>
                              </div>
                            ))}
                              <s-stack direction="inline" justifyContent="end">
                                <s-button
                                  variant="secondary"
                                  onClick={(event) => {
                                    const container =
                                      event.currentTarget.closest(
                                        "[data-line-index]"
                                      );
                                    if (!container) return;
                                    const textFields = Array.from(
                                      container.querySelectorAll("s-text-field")
                                    );
                                    const dateFields = Array.from(
                                      container.querySelectorAll("s-date-field")
                                    );
                                    const fields = [...textFields, ...dateFields];
                                    const updatedAttrs = fields
                                      .map((field) => {
                                        const key =
                                          field.getAttribute("data-attr-key");
                                        const value = field.value || "";
                                        if (!key) return null;
                                        return { key, value };
                                      })
                                      .filter(Boolean);

                                    submit(
                                      {
                                        intent: "updateAttributes",
                                        orderId: order.id,
                                        lineItemIndex: String(idx),
                                        attributes: JSON.stringify(
                                          updatedAttrs
                                        ),
                                      },
                                      { method: "post" }
                                    );
                                  }}
                                >
                                  Save Item Details
                                </s-button>
                              </s-stack>
                        </s-stack>
                      </s-stack>
                    )}
                  </s-stack>
                </s-box>
              ))}
            </s-stack>
          )}
        </s-stack>
      </s-section>

      {/* Order summary + Go to Order in Admin */}
      <s-section>
        <s-box
          padding="base"
          borderRadius="base"
          borderWidth="base"
          background="subdued"
        >
          <s-stack
            direction="inline"
            alignItems="center"
            justifyContent="space-between"
          >
            <s-stack gap="small">
              <s-heading size="large" style={{ fontSize: "1.6rem" }}>
                ORDER SUMMARY
              </s-heading>
              <s-text color="subdued">Created: {createdLabel}</s-text>
              <s-text color="subdued">Updated: {updatedLabel}</s-text>
            </s-stack>
            <s-button
              variant="secondary"
              href={adminHref}
              size="large"
              style={{ fontWeight: 600 }}
            >
              Go to Order in Admin
            </s-button>
          </s-stack>
        </s-box>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};