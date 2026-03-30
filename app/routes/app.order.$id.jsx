import { useCallback, useEffect, useRef, useState } from "react";
import {
  redirect,
  useLoaderData,
  useSearchParams,
  useSubmit,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  deriveOrderAdjustments,
  formatAdjustmentMoney,
  readLineItemAdjustmentFields,
} from "../lib/order-adjustments";
import {
  calculatePaymentStatus,
  normalizeOverallOrderStatus,
} from "../lib/order-status-helpers";
import {
  computeLineItemFulfillmentUi,
  fulfillOrderLineItem,
  unfulfillOrderLineItem,
} from "../lib/line-item-fulfillment.server";
import {
  normalizeAttributesArrayForSave,
  normalizeSpecialOrderAttributeValue,
} from "../lib/special-order-line-item-attributes";

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

/** Prefer E.164 for Shopify customer/address phone fields. */
function normalizePhoneForShopify(phone) {
  const t = String(phone ?? "").trim();
  if (!t) return null;
  const digits = t.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (t.startsWith("+")) return t;
  return t;
}

function normalizeCustomerFromGraphql(customer) {
  if (!customer) return null;
  const addr = customer.defaultAddress;
  return {
    id: customer.id,
    firstName: customer.firstName ?? "",
    lastName: customer.lastName ?? "",
    displayName: customer.displayName ?? "",
    email: customer.email ?? "",
    phone: customer.phone ?? "",
    defaultAddress: addr
      ? {
          id: addr.id,
          address1: addr.address1 ?? "",
          address2: addr.address2 ?? "",
          city: addr.city ?? "",
          province: addr.province ?? "",
          provinceCode: addr.provinceCode ?? "",
          zip: addr.zip ?? "",
          country: addr.country ?? "",
          countryCodeV2: addr.countryCodeV2 ?? "US",
          company: addr.company ?? "",
        }
      : null,
  };
}

function customerFormStateFromOrder(customer) {
  if (!customer) return null;
  const a = customer.defaultAddress;
  return {
    firstName: customer.firstName ?? "",
    lastName: customer.lastName ?? "",
    email: customer.email ?? "",
    phone: customer.phone ?? "",
    company: a?.company ?? "",
    address1: a?.address1 ?? "",
    address2: a?.address2 ?? "",
    city: a?.city ?? "",
    provinceCode: a?.provinceCode ?? "",
    zip: a?.zip ?? "",
    countryCode: a?.countryCodeV2 ?? "US",
    defaultAddressId: a?.id ?? null,
  };
}

/**
 * Polaris web components may emit events where `currentTarget` is null after
 * React's delegation; use target fallback for `.value` and DOM traversal.
 */
function webComponentFieldValue(event) {
  const t = event?.currentTarget ?? event?.target;
  if (t == null) return "";
  const v = /** @type {{ value?: unknown }} */ (t).value;
  return v == null ? "" : String(v);
}

function eventTargetElement(event) {
  return (event?.currentTarget ?? event?.target) ?? null;
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
  return normalizeOverallOrderStatus(entry?.node?.value || "Order Pending");
}

function normalizeText(text) {
  return String(text || "").toLowerCase().trim();
}

function getOrderStatusTone(status) {
  const s = normalizeText(status);
  if (!s || s === "not set") return "subdued";
  if (s.includes("not ordered") || s.includes("canceled")) return "critical";
  if (s.includes("back ordered")) return "info";
  if (s.includes("ordered") || s.includes("received") || s.includes("delivered")) return "success";
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
  // Success: Ordered, Received, Drop Ship - Ordered, Drop Ship - Delivered
  if (s.includes("ordered") || s.includes("received") || s.includes("delivered") || s.includes("picked up")) {
    return { background: "#e8f5e9", border: "#2e7d32" };
  }
  return { background: "#f4f6f8", border: "#5c6ac4" };
}

function getPaymentStatusTone(status) {
  const s = normalizeText(status);
  if (!s) return "subdued";
  if (s === "not paid" || s.includes("not paid")) return "critical";
  if (s.includes("partially refunded")) return "warning";
  if (s.includes("refunded")) return "info";
  if (s === "partially paid" || s.includes("partially paid")) return "warning";
  if (s === "paid in full" || s.includes("paid in full")) return "success";
  if (s === "paid" && !s.includes("not")) return "success";
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

/** Width classes for editable line-item attribute fields (see `.item-detail-field--w*` in page styles). */
function itemDetailFieldClassName(key) {
  if (key === "Brand" || key === "Type") {
    return "item-detail-field item-detail-field--w200";
  }
  if (key === "Style #" || key === "Size" || key === "Color") {
    return "item-detail-field item-detail-field--w100";
  }
  if (key === "Date Ordered") {
    return "item-detail-field item-detail-field--w150";
  }
  if (key === "Order Confirmation Number") {
    return "item-detail-field item-detail-field--w200";
  }
  return "item-detail-field item-detail-field--w200";
}

function lineItemAttrByKey(customAttributes, key) {
  const a = (customAttributes || []).find((x) => x.key === key);
  return a ?? { key, value: "" };
}

const LINE_ITEM_ATTR_KEYS_IN_STATUS_BOX = [
  "Brand",
  "Type",
  "Style #",
  "Size",
  "Color",
];

const ALWAYS_PRESENT_ATTRIBUTES = ["Brand", "Type", "Style #", "Size", "Color", "Date Ordered", "Order Confirmation Number"];
const HIDDEN_ATTRIBUTES = new Set([
  "_shopify_item_type",
  "Order Status",
  "Initial Status",
  "Special Order",
  "itemAdjustmentType",
  "Item Adjustment Type",
  "item_adjustment_type",
  "adjustmentRefundAmount",
  "Adjustment Refund Amount",
  "adjustment_refund_amount",
  "additionalPaymentAmount",
  "Additional Payment Amount",
  "additional_payment_amount",
  "exchangedForProductTitle",
  "Exchanged For Product",
  "Exchanged For Product Title",
  "exchanged_for_product_title",
]);

function getOrderMetafieldNumber(metafields, key) {
  const edge = metafields?.edges?.find((e) => e?.node?.key === key);
  if (!edge?.node?.value) return 0;
  const n = parseFloat(String(edge.node.value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function getProductAdjustmentTypeMetafield(metafields, position) {
  const key = `product_${position}_adjustment_type`;
  const edge = metafields?.edges?.find((e) => e?.node?.key === key);
  return edge?.node?.value?.trim() || "";
}

function getProductExchangedForTitleMetafield(metafields, position) {
  const key = `product_${position}_exchanged_for_title`;
  const edge = metafields?.edges?.find((e) => e?.node?.key === key);
  return edge?.node?.value?.trim() || "";
}

function getAttributesForDisplay(attrs) {
  const map = new Map();
  for (const a of attrs || []) {
    if (!HIDDEN_ATTRIBUTES.has(a.key)) {
      map.set(a.key, a.value || "");
    }
  }
  const result = [];
  for (const key of ALWAYS_PRESENT_ATTRIBUTES) {
    result.push({
      key,
      value: normalizeSpecialOrderAttributeValue(key, map.get(key) || ""),
    });
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
            firstName
            lastName
            displayName
            email
            phone
            defaultAddress {
              id
              address1
              address2
              city
              province
              provinceCode
              zip
              country
              countryCodeV2
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

    const draftLineItems =
      draftOrder.lineItems?.edges?.map((edge, index) => {
        const li = edge.node;
        const rawAttrs = attributesOverridesByIndex[index] || li.customAttributes || [];
        const mfAdj = getProductAdjustmentTypeMetafield(metafields, index + 1);
        const mfExchangedFor = getProductExchangedForTitleMetafield(
          metafields,
          index + 1
        );
        const adj = readLineItemAdjustmentFields(
          rawAttrs,
          mfAdj,
          mfExchangedFor
        );
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
          customAttributes: getAttributesForDisplay(rawAttrs),
          orderStatus: itemStatus,
          itemAdjustmentType: adj.itemAdjustmentType,
          adjustmentRefundAmount: adj.adjustmentRefundAmount,
          additionalPaymentAmount: adj.additionalPaymentAmount,
          currencyCode: li.originalUnitPriceSet?.shopMoney?.currencyCode || null,
          lineItemRefunded: false,
          lineItemExchanged: adj.itemAdjustmentType === "exchanged",
          exchangedForProductTitle: adj.exchangedForProductTitle || null,
          fulfillmentCanFulfill: false,
          fulfillmentCanUnfulfill: false,
          fulfillmentUnfulfillBlocked: false,
        };
      }) ?? [];

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
      paymentStatus: calculatePaymentStatus(draftOrder),
      subtotal: formatMoneySet(draftOrder.subtotalPriceSet),
      tax: formatMoneySet(draftOrder.totalTaxSet),
      total: formatMoneySet(draftOrder.totalPriceSet),
      outstanding: null, // Draft orders don't have outstanding set in same way
      invoiceUrl: draftOrder.invoiceUrl || null,
      customer: normalizeCustomerFromGraphql(draftOrder.customer),
      totalRefundedAmount: 0,
      totalRefundedCurrency: draftLineItems[0]?.currencyCode || "USD",
      orderAdjustmentsAdditionalPaymentMetafield: getOrderMetafieldNumber(
        metafields,
        "order_adjustments_additional_payment"
      ),
      orderAdjustmentsRefundTotalMetafield: getOrderMetafieldNumber(
        metafields,
        "order_adjustments_refund_total"
      ),
      lineItems: draftLineItems,
    };

    normalized.orderAdjustments = deriveOrderAdjustments(normalized);

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
          totalRefundedSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          customer {
            id
            firstName
            lastName
            displayName
            email
            phone
            defaultAddress {
              id
              address1
              address2
              city
              province
              provinceCode
              zip
              country
              countryCodeV2
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
                quantity
                currentQuantity
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
    if (json.errors?.length) {
      console.error(
        "GetOrderDetails GraphQL errors:",
        json.errors.map((e) => e.message).join("; ")
      );
    }
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

    const totalRefundedAmount = parseFloat(
      order.totalRefundedSet?.shopMoney?.amount ?? ""
    );
    const totalRefundedCurrency =
      order.totalRefundedSet?.shopMoney?.currencyCode ||
      order.lineItems?.edges?.[0]?.node?.originalUnitPriceSet?.shopMoney?.currencyCode ||
      "USD";

    const fulfillmentOrderEdges = order.fulfillmentOrders?.edges || [];
    const rawFulfillments = order.fulfillments;
    const fulfillmentEdges = Array.isArray(rawFulfillments)
      ? rawFulfillments.map((node) => ({ node }))
      : [];

    const placedLineItems =
      order.lineItems?.edges?.map((edge, index) => {
        const li = edge.node;
        const rawAttrs = attributesOverridesByIndex[index] || li.customAttributes || [];
        const mfAdj = getProductAdjustmentTypeMetafield(metafields, index + 1);
        const mfExchangedFor = getProductExchangedForTitleMetafield(
          metafields,
          index + 1
        );
        const adj = readLineItemAdjustmentFields(
          rawAttrs,
          mfAdj,
          mfExchangedFor
        );
        const itemStatus = extractItemStatusFromMetafields(
          metafields,
          index,
          attributesOverridesByIndex[index] || li.customAttributes
        );
        const qty = Number(li.quantity ?? 0);
        const currentQty = Number(li.currentQuantity ?? li.quantity ?? 0);
        const fulfillmentUi = computeLineItemFulfillmentUi(
          li.id,
          fulfillmentOrderEdges,
          Array.isArray(fulfillmentEdges) ? fulfillmentEdges : []
        );
        const canShowFulfillment = currentQty > 0;
        return {
          id: li.id,
          title: li.title,
          quantity: li.quantity,
          variantTitle: li.variantTitle || null,
          pricePerItem: formatMoneySet(li.originalUnitPriceSet),
          customAttributes: getAttributesForDisplay(rawAttrs),
          orderStatus: itemStatus,
          itemAdjustmentType: adj.itemAdjustmentType,
          adjustmentRefundAmount: adj.adjustmentRefundAmount,
          additionalPaymentAmount: adj.additionalPaymentAmount,
          currencyCode: li.originalUnitPriceSet?.shopMoney?.currencyCode || null,
          lineItemRefunded:
            qty > currentQty,
          lineItemExchanged: adj.itemAdjustmentType === "exchanged",
          exchangedForProductTitle: adj.exchangedForProductTitle || null,
          fulfillmentCanFulfill:
            canShowFulfillment && fulfillmentUi.canFulfill,
          fulfillmentCanUnfulfill:
            canShowFulfillment && fulfillmentUi.canUnfulfill,
          fulfillmentUnfulfillBlocked:
            canShowFulfillment && fulfillmentUi.unfulfillBlockedMixed,
        };
      }) ?? [];

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
      paymentStatus: calculatePaymentStatus(order),
      subtotal: formatMoneySet(order.subtotalPriceSet),
      tax: formatMoneySet(order.totalTaxSet),
      total: formatMoneySet(order.totalPriceSet),
      outstanding: formatMoneySet(order.totalOutstandingSet),
      paid,
      customer: normalizeCustomerFromGraphql(order.customer),
      totalRefundedAmount: Number.isFinite(totalRefundedAmount) ? totalRefundedAmount : 0,
      totalRefundedCurrency,
      orderAdjustmentsAdditionalPaymentMetafield: getOrderMetafieldNumber(
        metafields,
        "order_adjustments_additional_payment"
      ),
      orderAdjustmentsRefundTotalMetafield: getOrderMetafieldNumber(
        metafields,
        "order_adjustments_refund_total"
      ),
      lineItems: placedLineItems,
    };

    normalized.orderAdjustments = deriveOrderAdjustments(normalized);

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

const CUSTOMER_UPDATE = `#graphql
  mutation CustomerUpdate($input: CustomerInput!) {
    customerUpdate(input: $input) {
      customer {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const CUSTOMER_ADDRESS_UPDATE = `#graphql
  mutation CustomerAddressUpdate(
    $customerId: ID!
    $addressId: ID!
    $address: MailingAddressInput!
  ) {
    customerAddressUpdate(
      customerId: $customerId
      addressId: $addressId
      address: $address
      setAsDefault: true
    ) {
      address {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const CUSTOMER_ADDRESS_CREATE = `#graphql
  mutation CustomerAddressCreate(
    $customerId: ID!
    $address: MailingAddressInput!
    $setAsDefault: Boolean
  ) {
    customerAddressCreate(
      customerId: $customerId
      address: $address
      setAsDefault: $setAsDefault
    ) {
      address {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

function redirectWithFulfillmentError(request, message) {
  const url = new URL(request.url);
  const short =
    message.length > 450 ? `${message.slice(0, 450)}…` : message;
  url.searchParams.set("fulfillmentError", short);
  return redirect(url.pathname + url.search);
}

function redirectClearFulfillmentError(request) {
  const url = new URL(request.url);
  url.searchParams.delete("fulfillmentError");
  return redirect(url.pathname + url.search);
}

function redirectWithCustomerError(request, message) {
  const url = new URL(request.url);
  const short =
    message.length > 450 ? `${message.slice(0, 450)}…` : message;
  url.searchParams.set("customerError", short);
  return redirect(url.pathname + url.search);
}

function redirectClearCustomerError(request) {
  const url = new URL(request.url);
  url.searchParams.delete("customerError");
  return redirect(url.pathname + url.search);
}

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

  if (intent === "updateCustomer") {
    const customerId = formData.get("customerId");
    if (!customerId) {
      return redirect(request.url);
    }

    const firstName = String(formData.get("firstName") ?? "").trim();
    const lastName = String(formData.get("lastName") ?? "").trim();
    const email = String(formData.get("email") ?? "").trim();
    const phoneRaw = String(formData.get("phone") ?? "").trim();

    const company = String(formData.get("company") ?? "").trim();
    const address1 = String(formData.get("address1") ?? "").trim();
    const address2 = String(formData.get("address2") ?? "").trim();
    const city = String(formData.get("city") ?? "").trim();
    const provinceCode = String(formData.get("provinceCode") ?? "").trim();
    const zip = String(formData.get("zip") ?? "").trim();
    let countryCode = String(formData.get("countryCode") ?? "US")
      .trim()
      .toUpperCase();
    if (!countryCode) countryCode = "US";

    const defaultAddressIdRaw = formData.get("defaultAddressId");
    const hasDefaultAddressId =
      typeof defaultAddressIdRaw === "string" &&
      defaultAddressIdRaw.trim().length > 0;

    const phone = normalizePhoneForShopify(phoneRaw);

    const customerInput = {
      id: String(customerId),
      firstName,
      lastName,
      email: email || null,
      phone,
    };

    const cuRes = await admin.graphql(CUSTOMER_UPDATE, {
      variables: { input: customerInput },
    });
    const cuJson = await cuRes.json();
    if (cuJson.errors?.length) {
      return redirectWithCustomerError(
        request,
        cuJson.errors.map((e) => e.message).join("; ")
      );
    }
    const cuErrors = cuJson.data?.customerUpdate?.userErrors ?? [];
    if (cuErrors.length > 0) {
      return redirectWithCustomerError(
        request,
        cuErrors.map((e) => e.message).join(", ") || "Failed to update customer."
      );
    }

    const addressInput = {
      address1: address1 || "",
      city: city || "",
      zip: zip || "",
      countryCode,
    };
    if (address2) addressInput.address2 = address2;
    if (company) addressInput.company = company;
    if (provinceCode) addressInput.provinceCode = provinceCode;

    const hasAddress =
      Boolean(address1) ||
      Boolean(city) ||
      Boolean(zip) ||
      Boolean(company) ||
      Boolean(address2);

    if (hasDefaultAddressId) {
      const addrRes = await admin.graphql(CUSTOMER_ADDRESS_UPDATE, {
        variables: {
          customerId: String(customerId),
          addressId: String(defaultAddressIdRaw).trim(),
          address: addressInput,
        },
      });
      const addrJson = await addrRes.json();
      if (addrJson.errors?.length) {
        return redirectWithCustomerError(
          request,
          addrJson.errors.map((e) => e.message).join("; ")
        );
      }
      const addrErrors = addrJson.data?.customerAddressUpdate?.userErrors ?? [];
      if (addrErrors.length > 0) {
        return redirectWithCustomerError(
          request,
          addrErrors.map((e) => e.message).join(", ") ||
            "Failed to update address."
        );
      }
    } else if (hasAddress) {
      const acRes = await admin.graphql(CUSTOMER_ADDRESS_CREATE, {
        variables: {
          customerId: String(customerId),
          address: addressInput,
          setAsDefault: true,
        },
      });
      const acJson = await acRes.json();
      if (acJson.errors?.length) {
        return redirectWithCustomerError(
          request,
          acJson.errors.map((e) => e.message).join("; ")
        );
      }
      const acErrors = acJson.data?.customerAddressCreate?.userErrors ?? [];
      if (acErrors.length > 0) {
        return redirectWithCustomerError(
          request,
          acErrors.map((e) => e.message).join(", ") || "Failed to add address."
        );
      }
    }

    return redirectClearCustomerError(request);
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

  if (intent === "fulfillLineItem") {
    const lineItemId = formData.get("lineItemId");
    if (!lineItemId || String(orderId).includes("DraftOrder")) {
      return redirectClearFulfillmentError(request);
    }
    try {
      await fulfillOrderLineItem(admin.graphql, orderId, String(lineItemId));
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : "Could not fulfill this line item.";
      return redirectWithFulfillmentError(request, msg);
    }
    return redirectClearFulfillmentError(request);
  }

  if (intent === "unfulfillLineItem") {
    const lineItemId = formData.get("lineItemId");
    if (!lineItemId || String(orderId).includes("DraftOrder")) {
      return redirectClearFulfillmentError(request);
    }
    try {
      await unfulfillOrderLineItem(admin.graphql, orderId, String(lineItemId));
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : "Could not unfulfill this line item.";
      return redirectWithFulfillmentError(request, msg);
    }
    return redirectClearFulfillmentError(request);
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

    let parsedAttributes;
    try {
      parsedAttributes = JSON.parse(String(attributesJson));
    } catch {
      return redirect(request.url);
    }
    if (!Array.isArray(parsedAttributes)) {
      return redirect(request.url);
    }
    const normalizedJson = JSON.stringify(
      normalizeAttributesArrayForSave(parsedAttributes)
    );

    const metafieldKey = `lineitem_${index + 1}_attributes`;
    const metaResponse = await admin.graphql(METAFIELDS_SET, {
      variables: {
        metafields: [
          {
            ownerId: orderId,
            namespace: "custom",
            key: metafieldKey,
            value: normalizedJson,
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

function OrderAdjustmentsCard({ orderAdjustments }) {
  if (!orderAdjustments) {
    return null;
  }
  const {
    exchangeCount,
    returnCount,
    refundTotal,
    additionalPaymentTotal,
    currencyCode,
  } = orderAdjustments;
  const hasEvents = exchangeCount > 0 || returnCount > 0;
  const hasFinancial = refundTotal > 0 || additionalPaymentTotal > 0;
  const hasAny = hasEvents || hasFinancial;

  return (
    <s-box
      padding="base"
      borderRadius="base"
      borderWidth="base"
      background="subdued"
      flex="1"
    >
      <s-stack gap="small">
        <s-heading size="large" style={{ fontSize: "1.6rem" }}>
          Order Adjustments
        </s-heading>
        {!hasAny ? (
          <s-text color="subdued">No adjustments</s-text>
        ) : (
          <>
            {exchangeCount > 0 && <s-text>Exchanges: {exchangeCount}</s-text>}
            {returnCount > 0 && <s-text>Returns: {returnCount}</s-text>}
            {hasEvents && hasFinancial && (
              <div
                style={{
                  borderTop: "1px solid #e1e3e5",
                  margin: "4px 0",
                }}
              />
            )}
            {refundTotal > 0 && (
              <s-text>
                Refund Issued:{" "}
                {formatAdjustmentMoney(refundTotal, currencyCode)}
              </s-text>
            )}
            {additionalPaymentTotal > 0 && (
              <s-text>
                Additional Payment:{" "}
                {formatAdjustmentMoney(additionalPaymentTotal, currencyCode)}
              </s-text>
            )}
          </>
        )}
      </s-stack>
    </s-box>
  );
}

export default function OrderDetails() {
  const { order } = useLoaderData();
  const submit = useSubmit();
  const [searchParams] = useSearchParams();
  const fulfillmentError = searchParams.get("fulfillmentError");
  const customerError = searchParams.get("customerError");
  const [note, setNote] = useState(order.note || "");
  const [customerForm, setCustomerForm] = useState(() =>
    customerFormStateFromOrder(order.customer)
  );

  useEffect(() => {
    setNote(order.note || "");
  }, [order.note]);

  useEffect(() => {
    setCustomerForm(customerFormStateFromOrder(order.customer));
  }, [order.customer, order.updatedAt]);

  const createdLabel = new Date(order.createdAt).toLocaleString();
  const updatedLabel = new Date(order.updatedAt).toLocaleString();
  const paymentStatusLabel = order.paymentStatus || "Not Paid";
  const adminId = String(order.id).split("/").pop();
  const adminHref =
    order.type === "draft"
      ? `shopify://admin/draft_orders/${adminId}`
      : `shopify://admin/orders/${adminId}`;

  const tagsWithoutSpecialOrder = (order.tags || []).filter(
    (tag) => String(tag || "").toLowerCase().trim() !== "special-order"
  );

  const [printModalOpen, setPrintModalOpen] = useState(false);
  const [printHtml, setPrintHtml] = useState(null);
  const [printLoading, setPrintLoading] = useState(false);
  const [printError, setPrintError] = useState(null);
  const printIframeRef = useRef(null);

  const closePrintModal = useCallback(() => {
    setPrintModalOpen(false);
    setPrintHtml(null);
    setPrintError(null);
    setPrintLoading(false);
  }, []);

  const openPrintModal = useCallback(async () => {
    setPrintModalOpen(true);
    setPrintHtml(null);
    setPrintError(null);
    setPrintLoading(true);
    try {
      const res = await fetch(
        `/app/print-order-summary?id=${encodeURIComponent(order.id)}`,
        { credentials: "same-origin" }
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Could not load print preview");
      }
      setPrintHtml(data.html);
    } catch (e) {
      setPrintError(e instanceof Error ? e.message : String(e));
    } finally {
      setPrintLoading(false);
    }
  }, [order.id]);

  const handlePrintFromModal = useCallback(() => {
    const win = printIframeRef.current?.contentWindow;
    if (win) {
      win.focus();
      win.print();
    }
  }, []);

  useEffect(() => {
    if (!printModalOpen) return;
    const onKey = (e) => {
      if (e.key === "Escape") closePrintModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [printModalOpen, closePrintModal]);

  return (
    <s-page
      heading={order.name}
      inlineSize="large"
    >
      {fulfillmentError && order.type === "order" && (
        <s-section>
          <s-banner tone="critical" heading={fulfillmentError} />
        </s-section>
      )}
      {customerError && (
        <s-section>
          <s-banner tone="critical" heading={customerError} />
        </s-section>
      )}
      <style>{`
        .order-status-dropdown-wrapper {
          border-radius: 8px;
          padding: 12px 16px;
          border: 2px solid;
          width: 100%;
          box-sizing: border-box;
          position: relative;
        }
        .order-status-dropdown-badge-corner {
          position: absolute;
          top: 12px;
          right: 16px;
          z-index: 2;
          pointer-events: none;
        }
        .order-status-dropdown-badge-corner s-badge {
          pointer-events: auto;
        }
        .order-status-dropdown-inner {
          display: flex;
          flex-direction: column;
          gap: 12px;
          width: 100%;
          padding-right: 132px;
          box-sizing: border-box;
        }
        .order-status-attr-fields {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          align-items: flex-end;
          width: 100%;
        }
        .order-status-second-row {
          display: flex;
          flex-wrap: wrap;
          align-items: flex-end;
          gap: 24px;
          width: 100%;
        }
        .order-status-select-row {
          width: 400px;
          max-width: 100%;
          flex: 0 0 auto;
        }
        .order-status-select-row s-select {
          width: 100%;
          min-width: 0;
        }
        .item-detail-field {
          box-sizing: border-box;
        }
        .item-detail-field--w100 {
          min-width: 100px;
          width: 100px;
          flex: 0 0 100px;
        }
        .item-detail-field--w150 {
          min-width: 150px;
          width: 150px;
          flex: 0 0 150px;
        }
        .item-detail-field--date-clear-row.item-detail-field--w150 {
          min-width: 260px;
          width: auto;
          flex: 0 0 auto;
          max-width: 100%;
        }
        .item-detail-field--w200 {
          min-width: 200px;
          width: 200px;
          flex: 0 0 200px;
        }
        .item-detail-field--date-clear-row .date-clear-inline {
          display: flex;
          flex-direction: row;
          align-items: flex-end;
          justify-content: flex-start;
          gap: 12px;
          width: 100%;
          min-width: 0;
        }
        .item-detail-field--date-clear-row .date-clear-inline s-box {
          flex: 1 1 auto;
          min-width: 148px;
          max-width: 100%;
        }
        .item-detail-field--date-clear-row .date-clear-inline s-button {
          flex-shrink: 0;
        }
        .item-detail-field s-text-field {
          display: block;
          width: 100%;
          min-width: 0;
          max-width: 100%;
        }
        .item-detail-field s-date-field {
          display: block;
          width: 100%;
          min-width: 0;
          max-width: 100%;
        }
        .item-detail-field .field-label {
          font-weight: 700 !important;
        }
        .print-modal-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.45);
          z-index: 10000;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          box-sizing: border-box;
        }
        .print-modal-panel {
          background: #fff;
          border-radius: 12px;
          max-width: 920px;
          width: 100%;
          max-height: 90vh;
          display: flex;
          flex-direction: column;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
          overflow: hidden;
        }
        .print-modal-toolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          padding: 16px 20px;
          border-bottom: 1px solid #e3e3e3;
          flex-shrink: 0;
        }
        .print-modal-body {
          padding: 12px 16px 20px;
          overflow: auto;
          flex: 1;
          min-height: 0;
        }
        .print-modal-iframe {
          width: 100%;
          min-height: 480px;
          height: min(70vh, 720px);
          border: 1px solid #e3e3e3;
          border-radius: 8px;
          background: #fff;
        }
        .customer-info-row {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          width: 100%;
          align-items: flex-end;
        }
        .customer-info-row.customer-info-row--labels-top {
          align-items: flex-start;
        }
        .customer-info-row .customer-info-field {
          flex: 1 1 0;
          min-width: 140px;
          max-width: 100%;
        }
        .customer-info-row .customer-info-field s-text-field {
          display: block;
          width: 100%;
        }
        .customer-info-row .customer-info-field--phone {
          flex: 0 0 140px;
          width: 140px;
          min-width: 140px;
          max-width: 140px;
        }
        .customer-info-row .customer-info-field--email {
          flex: 2 1 0;
          min-width: 160px;
        }
        /* Address row: address lines share space; city is half the width of each line */
        .customer-info-row--address .customer-info-field--address-line {
          flex: 5 1 0;
          min-width: 100px;
          max-width: 100%;
        }
        .customer-info-row--address .customer-info-field--city {
          flex: 2 1 0;
          min-width: 80px;
          max-width: 100%;
        }
        .customer-info-row--address .customer-info-field--state {
          flex: 0 0 2.75rem;
          min-width: 2.75rem;
          max-width: 3.25rem;
        }
        /* ~3 letter widths; value is still 2-letter ISO for Shopify */
        .customer-info-row--address .customer-info-field--country {
          flex: 0 0 3.25rem;
          min-width: 3ch;
          max-width: 4rem;
        }
        .customer-info-row--address .customer-info-field--zip {
          flex: 0 0 auto;
          min-width: 12rem;
          max-width: 18ch;
        }
        .customer-info-row--address .customer-info-address-actions {
          flex: 0 0 auto;
          margin-left: auto;
          align-self: flex-end;
        }
        /* Status + notes row: four compact cards, then notes fills remaining width and stretches */
        .order-status-grid {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr)) minmax(0, 3fr);
          gap: 16px;
          align-items: stretch;
          width: 100%;
        }
        @media (max-width: 1100px) {
          .order-status-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
          .order-status-notes-card {
            grid-column: 1 / -1;
          }
        }
        @media (max-width: 600px) {
          .order-status-grid {
            grid-template-columns: 1fr;
          }
        }
        .order-status-notes-card {
          display: flex;
          flex-direction: column;
          min-height: 0;
          height: 100%;
        }
        .order-status-notes-inner {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-height: 0;
          height: 100%;
          gap: 12px;
        }
        /* Row height follows the other cards; textarea fills card without forcing extra height */
        .order-status-notes-inner s-text-area {
          flex: 1 1 0;
          min-height: 0;
        }
      `}</style>
      {/* Top bar: back, print, dates, admin link, type badge, tags */}
      <s-section>
        <s-stack
          direction="inline"
          alignItems="center"
          justifyContent="space-between"
          gap="small"
        >
          <s-stack
            direction="inline"
            gap="small"
            alignItems="center"
            style={{ flexWrap: "wrap" }}
          >
            <s-button
              variant="secondary"
              href="/app"
              size="large"
              style={{ fontWeight: 600 }}
            >
              ← All Orders
            </s-button>
            <s-button
              variant="primary"
              size="large"
              style={{ fontWeight: 600 }}
              onClick={openPrintModal}
            >
              Print Order Summary
            </s-button>
            <s-text color="subdued" style={{ whiteSpace: "nowrap" }}>
              Created: {createdLabel}
            </s-text>
            <s-text color="subdued" style={{ whiteSpace: "nowrap" }}>
              Updated: {updatedLabel}
            </s-text>
          </s-stack>
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-button
              variant="secondary"
              href={adminHref}
              size="large"
              style={{ fontWeight: 600 }}
            >
              Go to Order in Admin
            </s-button>
            <s-badge tone={order.type === "draft" ? "warning" : "success"}>
              {order.type === "draft" ? "Draft order" : "Order"}
            </s-badge>
            {tagsWithoutSpecialOrder.length > 0 && (
              <s-stack direction="inline" gap="small">
                {tagsWithoutSpecialOrder.map((tag) => (
                  <s-badge key={tag} tone="subdued">
                    {tag}
                  </s-badge>
                ))}
              </s-stack>
            )}
          </s-stack>
        </s-stack>
      </s-section>

      {/* Customer information — full width, two rows */}
      <s-section>
        <s-box
          padding="base"
          borderRadius="base"
          borderWidth="base"
          background="subdued"
          inlineSize="100%"
        >
          <s-stack gap="base">
            {order.customer && customerForm ? (
              <s-stack gap="base" alignItems="stretch">
                <div className="customer-info-row">
                  <div className="customer-info-field">
                    <s-text-field
                      label="First name"
                      value={customerForm.firstName}
                      onChange={(e) =>
                        setCustomerForm((f) =>
                          f
                            ? { ...f, firstName: webComponentFieldValue(e) }
                            : f
                        )
                      }
                    />
                  </div>
                  <div className="customer-info-field">
                    <s-text-field
                      label="Last name"
                      value={customerForm.lastName}
                      onChange={(e) =>
                        setCustomerForm((f) =>
                          f
                            ? { ...f, lastName: webComponentFieldValue(e) }
                            : f
                        )
                      }
                    />
                  </div>
                  <div className="customer-info-field customer-info-field--email">
                    <s-text-field
                      label="Email"
                      type="email"
                      autocomplete="email"
                      value={customerForm.email}
                      onChange={(e) =>
                        setCustomerForm((f) =>
                          f ? { ...f, email: webComponentFieldValue(e) } : f
                        )
                      }
                    />
                  </div>
                  <div className="customer-info-field customer-info-field--phone">
                    <s-text-field
                      label="Phone"
                      type="tel"
                      autocomplete="tel"
                      value={customerForm.phone}
                      onChange={(e) =>
                        setCustomerForm((f) =>
                          f ? { ...f, phone: webComponentFieldValue(e) } : f
                        )
                      }
                    />
                  </div>
                  <div className="customer-info-field">
                    <s-text-field
                      label="Company"
                      value={customerForm.company}
                      onChange={(e) =>
                        setCustomerForm((f) =>
                          f ? { ...f, company: webComponentFieldValue(e) } : f
                        )
                      }
                    />
                  </div>
                </div>
                <div className="customer-info-row customer-info-row--labels-top customer-info-row--address">
                  <div className="customer-info-field customer-info-field--address-line">
                    <s-text-field
                      label="Address line 1"
                      value={customerForm.address1}
                      onChange={(e) =>
                        setCustomerForm((f) =>
                          f ? { ...f, address1: webComponentFieldValue(e) } : f
                        )
                      }
                    />
                  </div>
                  <div className="customer-info-field customer-info-field--city">
                    <s-text-field
                      label="City"
                      value={customerForm.city}
                      onChange={(e) =>
                        setCustomerForm((f) =>
                          f ? { ...f, city: webComponentFieldValue(e) } : f
                        )
                      }
                    />
                  </div>
                  <div className="customer-info-field customer-info-field--state">
                    <s-text-field
                      label="State"
                      maxlength={2}
                      value={customerForm.provinceCode}
                      onChange={(e) =>
                        setCustomerForm((f) =>
                          f
                            ? {
                                ...f,
                                provinceCode: webComponentFieldValue(e).slice(
                                  0,
                                  2
                                ),
                              }
                            : f
                        )
                      }
                    />
                  </div>
                  <div className="customer-info-field customer-info-field--zip">
                    <s-text-field
                      label="ZIP / Postal code"
                      value={customerForm.zip}
                      onChange={(e) =>
                        setCustomerForm((f) =>
                          f
                            ? { ...f, zip: webComponentFieldValue(e) }
                            : f
                        )
                      }
                    />
                  </div>
                  <div className="customer-info-field customer-info-field--country">
                    <s-text-field
                      label="Country"
                      maxlength={2}
                      value={customerForm.countryCode}
                      onChange={(e) => {
                        const v = webComponentFieldValue(e)
                          .toUpperCase()
                          .replace(/[^A-Z]/g, "")
                          .slice(0, 2);
                        setCustomerForm((f) =>
                          f ? { ...f, countryCode: v || "US" } : f
                        );
                      }}
                    />
                  </div>
                  <div className="customer-info-address-actions">
                    <s-stack direction="inline" gap="small" alignItems="end">
                      <s-button
                        variant="primary"
                        onClick={() => {
                          submit(
                            {
                              intent: "updateCustomer",
                              orderId: order.id,
                              customerId: order.customer.id,
                              defaultAddressId:
                                customerForm.defaultAddressId ?? "",
                              firstName: customerForm.firstName,
                              lastName: customerForm.lastName,
                              email: customerForm.email,
                              phone: customerForm.phone,
                              company: customerForm.company,
                              address1: customerForm.address1,
                              address2: customerForm.address2,
                              city: customerForm.city,
                              provinceCode: customerForm.provinceCode,
                              zip: customerForm.zip,
                              countryCode: customerForm.countryCode,
                            },
                            { method: "post" }
                          );
                        }}
                      >
                        Save customer
                      </s-button>
                      <s-button
                        variant="secondary"
                        onClick={() =>
                          setCustomerForm(
                            customerFormStateFromOrder(order.customer)
                          )
                        }
                      >
                        Reset
                      </s-button>
                    </s-stack>
                  </div>
                </div>
              </s-stack>
            ) : (
              <s-text color="subdued">
                No customer on this order. Add or associate a customer in
                Shopify admin.
              </s-text>
            )}
          </s-stack>
        </s-box>
      </s-section>

      {/* Contact, overall, payment, adjustments, notes (grid: notes column is wide; stretches to row height) */}
      <s-section>
        <div className="order-status-grid">
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
                      contactStatus: webComponentFieldValue(event),
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
                      overallOrderStatus: webComponentFieldValue(event),
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

          <OrderAdjustmentsCard orderAdjustments={order.orderAdjustments} />

          {/* Notes — wide column; stretches to match tallest card in row */}
          <s-box
            className="order-status-notes-card"
            padding="small-500"
            borderRadius="base"
            borderWidth="base"
            background="subdued"
            minInlineSize="0"
            inlineSize="100%"
          >
            <div className="order-status-notes-inner">
              <s-heading size="large" style={{ fontSize: "1.6rem" }}>
                NOTES
              </s-heading>
              <s-text-area
                label="Notes"
                labelAccessibilityVisibility="exclusive"
                value={note}
                rows={5}
                onInput={(event) => setNote(webComponentFieldValue(event))}
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
            </div>
          </s-box>
        </div>
      </s-section>

      {/* Line items */}
      <s-section>
        <s-stack gap="base">
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
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "12px",
                        width: "100%",
                        minWidth: 0,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                          flex: "1 1 auto",
                          minWidth: 0,
                          flexWrap: "wrap",
                        }}
                      >
                        <s-badge
                          tone="info"
                          color="strong"
                          style={{
                            fontWeight: 700,
                            fontSize: "1.25rem",
                            minWidth: "2.2rem",
                            textAlign: "center",
                            flexShrink: 0,
                          }}
                        >
                          {idx + 1}
                        </s-badge>
                        <s-heading
                          size="large"
                          style={{
                            fontSize: "1.5rem",
                            margin: 0,
                            minWidth: 0,
                          }}
                        >
                          {String(item.title || "").toUpperCase()}
                        </s-heading>
                        {item.lineItemRefunded && (
                          <s-badge tone="critical">Refunded</s-badge>
                        )}
                        {item.lineItemExchanged && (
                          <s-stack direction="inline" gap="small-300" alignItems="center">
                            <s-badge tone="warning">Exchanged</s-badge>
                            {item.exchangedForProductTitle ? (
                              <s-text type="strong">
                                {item.exchangedForProductTitle}
                              </s-text>
                            ) : null}
                          </s-stack>
                        )}
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "10px",
                          flexShrink: 0,
                          marginLeft: "auto",
                        }}
                      >
                        <s-button
                          variant="secondary"
                          onClick={(event) => {
                            const el = eventTargetElement(event);
                            const container =
                              el?.closest?.("[data-line-index]");
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
                                const key = field.getAttribute("data-attr-key");
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
                                attributes: JSON.stringify(updatedAttrs),
                              },
                              { method: "post" }
                            );
                          }}
                        >
                          Save Item Details
                        </s-button>
                        <s-text type="strong" style={{ whiteSpace: "nowrap" }}>
                          QTY {item.quantity}
                        </s-text>
                        {item.pricePerItem ? (
                          <s-text type="strong" style={{ whiteSpace: "nowrap" }}>
                            {item.pricePerItem}
                          </s-text>
                        ) : null}
                      </div>
                    </div>
                    {order.type === "order" && (
                      <s-stack direction="inline" gap="small" alignItems="center">
                        {item.fulfillmentCanFulfill && (
                          <s-button
                            variant="secondary"
                            onClick={() =>
                              submit(
                                {
                                  intent: "fulfillLineItem",
                                  orderId: order.id,
                                  lineItemId: item.id,
                                },
                                { method: "post" }
                              )
                            }
                          >
                            Fulfill Item
                          </s-button>
                        )}
                        {item.fulfillmentCanUnfulfill && (
                          <s-button
                            variant="secondary"
                            tone="critical"
                            onClick={() =>
                              submit(
                                {
                                  intent: "unfulfillLineItem",
                                  orderId: order.id,
                                  lineItemId: item.id,
                                },
                                { method: "post" }
                              )
                            }
                          >
                            Unfulfill Item
                          </s-button>
                        )}
                        {item.fulfillmentUnfulfillBlocked && (
                          <s-text color="subdued" type="small">
                            Unfulfill in Shopify admin — this item was fulfilled
                            with other products in the same shipment.
                          </s-text>
                        )}
                      </s-stack>
                    )}
                    <s-stack gap="small-300">
                        {item.variantTitle && (
                          <s-text color="subdued">
                            {item.variantTitle}
                          </s-text>
                        )}

                        {(() => {
                          const colors = getOrderStatusWrapperColors(
                            item.orderStatus
                          );
                          const attrs = item.customAttributes || [];
                          return (
                            <div
                              className="order-status-dropdown-wrapper"
                              style={{
                                backgroundColor: colors.background,
                                borderColor: colors.border,
                              }}
                            >
                              <div className="order-status-dropdown-badge-corner">
                                <s-badge
                                  tone={getOrderStatusTone(item.orderStatus)}
                                >
                                  {item.orderStatus || "Not set"}
                                </s-badge>
                              </div>
                              <div className="order-status-dropdown-inner">
                                <div className="order-status-attr-fields">
                                  {LINE_ITEM_ATTR_KEYS_IN_STATUS_BOX.map(
                                    (key) => {
                                      const attr = lineItemAttrByKey(
                                        attrs,
                                        key
                                      );
                                      return (
                                        <div
                                          key={key}
                                          className={itemDetailFieldClassName(
                                            key
                                          )}
                                        >
                                          <s-stack gap="small-300">
                                            <span
                                              className="field-label"
                                              style={{ fontWeight: 700 }}
                                            >
                                              {key}
                                            </span>
                                            <s-text-field
                                              data-attr-key={key}
                                              label=""
                                              labelAccessibilityVisibility="hidden"
                                              value={attr.value || ""}
                                            />
                                          </s-stack>
                                        </div>
                                      );
                                    }
                                  )}
                                </div>
                                <div className="order-status-second-row">
                                  <div className="order-status-select-row">
                                    <s-select
                                      value={item.orderStatus || "Not Ordered"}
                                      onChange={(event) => {
                                        submit(
                                          {
                                            orderId: order.id,
                                            lineItemId: item.id,
                                            orderStatus:
                                              webComponentFieldValue(event),
                                          },
                                          { method: "post" }
                                        );
                                      }}
                                    >
                                      <s-option value="Not Ordered">
                                        Not Ordered
                                      </s-option>
                                      <s-option value="Ordered">Ordered</s-option>
                                      <s-option value="Back Ordered">
                                        Back Ordered
                                      </s-option>
                                      <s-option value="Drop Ship - Ordered">
                                        Drop Ship - Ordered
                                      </s-option>
                                      <s-option value="Drop Ship - Delivered">
                                        Drop Ship - Delivered
                                      </s-option>
                                      <s-option value="Received">Received</s-option>
                                      <s-option value="Canceled">Canceled</s-option>
                                    </s-select>
                                  </div>
                                  <div
                                    className={`${itemDetailFieldClassName("Date Ordered")} item-detail-field--date-clear-row`}
                                  >
                                    <s-stack gap="small-300">
                                      <span
                                        className="field-label"
                                        style={{ fontWeight: 700 }}
                                      >
                                        Date Ordered
                                      </span>
                                      <div className="date-clear-inline">
                                        <s-box
                                          inlineSize="100%"
                                          minInlineSize="0"
                                        >
                                          <s-date-field
                                            data-attr-key="Date Ordered"
                                            label=""
                                            labelAccessibilityVisibility="hidden"
                                            value={
                                              lineItemAttrByKey(
                                                item.customAttributes,
                                                "Date Ordered"
                                              ).value || ""
                                            }
                                            placeholder="Select date"
                                          />
                                        </s-box>
                                        <s-button
                                          variant="secondary"
                                          disabled={
                                            !(
                                              lineItemAttrByKey(
                                                item.customAttributes,
                                                "Date Ordered"
                                              ).value || ""
                                            ).trim()
                                          }
                                          onClick={(e) => {
                                            const el = eventTargetElement(e);
                                            const container =
                                              el?.closest?.(
                                                "[data-line-index]"
                                              );
                                            if (!container) return;
                                            const df = container.querySelector(
                                              's-date-field[data-attr-key="Date Ordered"]'
                                            );
                                            if (df)
                                              /** @type {any} */ (df).value =
                                                "";
                                            const textFields = Array.from(
                                              container.querySelectorAll(
                                                "s-text-field"
                                              )
                                            );
                                            const dateFields = Array.from(
                                              container.querySelectorAll(
                                                "s-date-field"
                                              )
                                            );
                                            const fields = [
                                              ...textFields,
                                              ...dateFields,
                                            ];
                                            const updatedAttrs = fields
                                              .map((field) => {
                                                const key =
                                                  field.getAttribute(
                                                    "data-attr-key"
                                                  );
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
                                          Clear date
                                        </s-button>
                                      </div>
                                    </s-stack>
                                  </div>
                                  <div
                                    className={itemDetailFieldClassName(
                                      "Order Confirmation Number"
                                    )}
                                  >
                                    <s-stack gap="small-300">
                                      <span
                                        className="field-label"
                                        style={{ fontWeight: 700 }}
                                      >
                                        Order Confirmation Number
                                      </span>
                                      <s-text-field
                                        data-attr-key="Order Confirmation Number"
                                        label=""
                                        labelAccessibilityVisibility="hidden"
                                        value={
                                          lineItemAttrByKey(
                                            item.customAttributes,
                                            "Order Confirmation Number"
                                          ).value || ""
                                        }
                                      />
                                    </s-stack>
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })()}

                        {(item.customAttributes || [])
                          .filter(
                            (a) =>
                              ![
                                "Brand",
                                "Type",
                                "Style #",
                                "Size",
                                "Color",
                                "Date Ordered",
                                "Order Confirmation Number",
                              ].includes(a.key)
                          )
                          .map((attr) => (
                            <div
                              key={attr.key}
                              className={itemDetailFieldClassName(attr.key)}
                            >
                              <s-stack gap="small-300">
                                <span
                                  className="field-label"
                                  style={{ fontWeight: 700 }}
                                >
                                  {attr.key}
                                </span>
                                <s-text-field
                                  data-attr-key={attr.key}
                                  label=""
                                  labelAccessibilityVisibility="hidden"
                                  value={attr.value || ""}
                                />
                              </s-stack>
                            </div>
                          ))}
                    </s-stack>
                  </s-stack>
                </s-box>
              ))}
            </s-stack>
          )}
        </s-stack>
      </s-section>

      {printModalOpen && (
        <div
          className="print-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="print-modal-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) closePrintModal();
          }}
        >
          <div
            className="print-modal-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="print-modal-toolbar">
              <s-heading id="print-modal-title" size="large">
                Order summary
              </s-heading>
              <s-stack direction="inline" gap="small">
                <s-button
                  variant="secondary"
                  onClick={closePrintModal}
                  disabled={printLoading}
                >
                  Close
                </s-button>
                <s-button
                  variant="primary"
                  onClick={handlePrintFromModal}
                  disabled={printLoading || !printHtml}
                >
                  Print
                </s-button>
              </s-stack>
            </div>
            <div className="print-modal-body">
              {printLoading && (
                <s-text color="subdued">Loading preview…</s-text>
              )}
              {printError && (
                <s-banner tone="critical" heading={printError} />
              )}
              {!printLoading && !printError && printHtml && (
                <iframe
                  ref={printIframeRef}
                  className="print-modal-iframe"
                  title="Order summary print preview"
                  srcDoc={printHtml}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};