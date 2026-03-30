import "@shopify/ui-extensions/preact";
import { render, Fragment } from "preact";
import { useState, useEffect, useMemo, useCallback } from "preact/hooks";
import {
  computeLineItemFulfillmentUi,
  fulfillOrderLineItem,
  unfulfillOrderLineItem,
  ORDER_REFRESH_QUERY,
} from "./fulfillment.js";
import {
  normalizeAttributesArrayForSave,
  normalizeSpecialOrderAttributeValue,
} from "./special-order-line-item-attributes.js";

export default async () => {
  render(<Extension />, document.body);
};

const SPECIAL_ORDER_TAG = "special-order";
const OPEN_STATUSES = ["Not Ordered", "Ordered", "Back Ordered", "Drop Ship - Ordered", "Drop Ship - Delivered", "Received"];
const ALWAYS_PRESENT_ATTRIBUTES = ["Brand", "Type", "Style #", "Size", "Color", "Date Ordered", "Order Confirmation Number"];
/** iPad order detail: two rows so Color / Item Order Date / Order Confirmation share one line (even columns). */
const TABLET_ORDER_DETAIL_ROW1_KEYS = ["Brand", "Type", "Style #", "Size"];
const TABLET_ORDER_DETAIL_ROW2_KEYS = ["Color", "Date Ordered", "Order Confirmation Number"];
const HIDDEN_ATTRIBUTES = new Set([
  "_shopify_item_type",
  "Order Status",
  "Initial Status",
  "Special Order",
]);

const ORDER_STATUS_OPTIONS = [
  "Not Ordered",
  "Ordered",
  "Back Ordered",
  "Drop Ship - Ordered",
  "Drop Ship - Delivered",
  "Received",
  "Canceled",
];

const CONTACT_STATUS_OPTIONS = [
  "Not Contacted",
  "No Answer",
  "Left Message",
  "Spoke to Customer",
];

const OVERALL_ORDER_STATUS_OPTIONS = [
  "Order Pending",
  "Picked Up - Sale Complete",
  "Order Canceled",
];

const COL_MOBILE = {
  order: "70px",
  customer: "150px",
  status: "100px",
  payment: "100px",
  contact: "230px",
  created: "55px",
};
const COL_IPAD = {
  order: "80px",
  customer: "150px",
  status: "275px",
  payment: "100px",
  contact: "175px",
  created: "130px",
};
const MIN_TABLE_MOBILE = "755px";
const MIN_TABLE_IPAD = "955px";

/** Default (phone) fixed column widths (px) for order-detail customer fields on POS. */
const CUSTOMER_FIELD_WIDTH = {
  firstName: "220px",
  lastName: "220px",
  email: "320px",
  phone: "200px",
  company: "250px",
  address1: "350px",
  city: "220px",
  state: "150px",
  zip: "150px",
  country: "150px",
};

/** iPad order detail: adjusted first/last/email/phone/address column widths. */
const CUSTOMER_FIELD_WIDTH_IPAD = {
  ...CUSTOMER_FIELD_WIDTH,
  firstName: "200px",
  lastName: "200px",
  email: "400px",
  phone: "180px",
  address1: "450px",
};

// Same names as admin; Picked Up and Order Canceled at bottom
const FILTER_OPTIONS = [
  { value: "", labelKey: "all_statuses" },
  { value: "open", labelKey: "filter_open" },
  { value: "Not Ordered", label: "Not Ordered" },
  { value: "Ordered", label: "Ordered" },
  { value: "Back Ordered", label: "Back Ordered" },
  { value: "Drop Ship - Ordered", label: "Drop Ship - Ordered" },
  { value: "Drop Ship - Delivered", label: "Drop Ship - Delivered" },
  { value: "Received", label: "Received" },
  { value: "Picked Up - Sale Complete", label: "Picked Up - Sale Complete" },
  { value: "Order Canceled", label: "Order Canceled" },
];

function getFilterLabel(value, i18n) {
  const opt = FILTER_OPTIONS.find((o) => o.value === value);
  return opt
    ? opt.labelKey
      ? i18n.translate(opt.labelKey)
      : opt.label
    : i18n.translate("all_statuses");
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

/** E.164-style phone for Admin API `customerUpdate`. */
function normalizePhoneForShopify(phone) {
  const t = String(phone ?? "").trim();
  if (!t) return null;
  const digits = t.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (t.startsWith("+")) return t;
  return t;
}

/** Editable customer + default address fields (matches admin order page). */
function customerFormFromCustomer(customer) {
  if (!customer?.id) return null;
  const a = customer.defaultAddress;
  return {
    customerId: customer.id,
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
    countryCode: String(a?.countryCodeV2 ?? "US")
      .toUpperCase()
      .replace(/[^A-Z]/g, "")
      .slice(0, 2) || "US",
    defaultAddressId: a?.id ?? null,
  };
}

function graphql(query, variables = {}) {
  return fetch("shopify:admin/api/graphql.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  }).then((r) => r.json());
}

function applyLineItemAttributeValue(
  item,
  attrKey,
  newVal,
  orderId,
  lineIdx,
  handleUpdateAttributes
) {
  const newAttrs = (item.customAttributes || []).map((a) => ({
    key: a.key,
    value:
      a.key === attrKey
        ? normalizeSpecialOrderAttributeValue(attrKey, newVal)
        : normalizeSpecialOrderAttributeValue(a.key, a.value),
  }));
  handleUpdateAttributes(orderId, lineIdx, newAttrs);
}

/** Renders one line-item attribute cell for tablet order detail rows. */
function TabletOrderDetailAttributeCell({
  attr,
  item,
  orderId,
  lineIndex,
  saving,
  minInlineSize,
  handleUpdateAttributes,
  i18n,
  stackDateControlsVertically,
}) {
  const label = attr.key === "Date Ordered" ? "Item Order Date" : attr.key;
  const dateControls =
    stackDateControlsVertically && attr.key === "Date Ordered" ? (
      <s-stack gap="small-300">
        <s-date-field
          value={attr.value || ""}
          onBlur={(e) => {
            applyLineItemAttributeValue(
              item,
              attr.key,
              e.currentTarget?.value ?? "",
              orderId,
              lineIndex,
              handleUpdateAttributes
            );
          }}
          onInput={(e) => {
            const v = e.currentTarget?.value ?? "";
            if (v === "") {
              applyLineItemAttributeValue(
                item,
                attr.key,
                "",
                orderId,
                lineIndex,
                handleUpdateAttributes
              );
            }
          }}
          disabled={!!saving}
        />
        <s-button
          variant="secondary"
          disabled={
            !!saving || !(attr.value && String(attr.value).trim())
          }
          onClick={() => {
            applyLineItemAttributeValue(
              item,
              attr.key,
              "",
              orderId,
              lineIndex,
              handleUpdateAttributes
            );
          }}
        >
          {i18n.translate("clear_date")}
        </s-button>
      </s-stack>
    ) : attr.key === "Date Ordered" ? (
      <s-stack direction="inline" gap="small" alignItems="end">
        <s-box inlineSize="100%">
          <s-date-field
            value={attr.value || ""}
            onBlur={(e) => {
              applyLineItemAttributeValue(
                item,
                attr.key,
                e.currentTarget?.value ?? "",
                orderId,
                lineIndex,
                handleUpdateAttributes
              );
            }}
            onInput={(e) => {
              const v = e.currentTarget?.value ?? "";
              if (v === "") {
                applyLineItemAttributeValue(
                  item,
                  attr.key,
                  "",
                  orderId,
                  lineIndex,
                  handleUpdateAttributes
                );
              }
            }}
            disabled={!!saving}
          />
        </s-box>
        <s-button
          variant="secondary"
          disabled={
            !!saving || !(attr.value && String(attr.value).trim())
          }
          onClick={() => {
            applyLineItemAttributeValue(
              item,
              attr.key,
              "",
              orderId,
              lineIndex,
              handleUpdateAttributes
            );
          }}
        >
          {i18n.translate("clear_date")}
        </s-button>
      </s-stack>
    ) : (
      <s-text-field
        value={attr.value}
        onBlur={(e) => {
          const newVal = e.currentTarget.value;
          const newAttrs = item.customAttributes.map((a) => ({
            key: a.key,
            value: a.key === attr.key ? newVal : a.value,
          }));
          handleUpdateAttributes(orderId, lineIndex, newAttrs);
        }}
        disabled={!!saving}
      />
    );

  return (
    <s-box minInlineSize={minInlineSize} inlineSize="auto">
      <s-stack gap="small-300">
        <s-text type="strong">{label}</s-text>
        {dateControls}
      </s-stack>
    </s-box>
  );
}

function normalizeAdjustmentType(raw) {
  const s = String(raw || "").toLowerCase().trim();
  if (!s) return null;
  if (s === "exchanged" || s === "exchange") return "exchanged";
  if (s === "returned" || s === "return") return "returned";
  return null;
}

function getOrderMetafieldString(metafields, key) {
  const edge = metafields?.edges?.find((e) => e?.node?.key === key);
  return edge?.node?.value?.trim() || "";
}

/** Mirrors app/lib/order-adjustments readLineItemAdjustmentFields for POS UI. */
function readLineItemAdjustmentFieldsPos(rawAttrs, mfAdjType, mfExchangedFor) {
  const raw = rawAttrs || [];
  const find = (keys) => {
    for (const k of keys) {
      const f = raw.find((a) => a.key?.toLowerCase() === k.toLowerCase());
      if (f?.value != null && String(f.value).trim() !== "")
        return String(f.value).trim();
    }
    return "";
  };
  const typeFromAttr = find([
    "itemAdjustmentType",
    "Item Adjustment Type",
    "item_adjustment_type",
  ]);
  const merged =
    normalizeAdjustmentType(typeFromAttr) ||
    normalizeAdjustmentType(mfAdjType || "");
  const exchangedTitleFromAttr = find([
    "exchangedForProductTitle",
    "Exchanged For Product",
    "Exchanged For Product Title",
    "exchanged_for_product_title",
  ]);
  const exchangedForProductTitle =
    exchangedTitleFromAttr || String(mfExchangedFor || "").trim();
  return {
    itemAdjustmentType: merged,
    exchangedForProductTitle,
  };
}

function extractContactStatus(metafields) {
  if (!metafields?.edges) return "Not Contacted";
  const mf = metafields.edges.find((e) => e?.node?.key === "contact_status");
  return mf?.node?.value || "Not Contacted";
}

function extractOverallOrderStatus(metafields) {
  if (!metafields?.edges) return "Order Pending";
  const mf = metafields.edges.find((e) => e?.node?.key === "overall_order_status");
  return mf?.node?.value || "Order Pending";
}

function extractOrderStatuses(order) {
  const edges = order.metafields?.edges || [];
  const byKey = Object.fromEntries(
    edges.filter((e) => e?.node?.key).map((e) => [e.node.key, e.node.value])
  );
  const lineItems = order.lineItems?.edges || [];

  if (lineItems.length === 0) {
    const productMfs = edges
      .filter(
        (e) =>
          e?.node?.key &&
          /^product_(\d+)_order_status$/.test(e.node.key) &&
          e?.node?.value
      )
      .map((e) => {
        const m = e.node.key.match(/^product_(\d+)_order_status$/);
        return { n: parseInt(m[1], 10), value: e.node.value };
      })
      .sort((a, b) => a.n - b.n)
      .map((x) => ({ title: "Item", status: x.value }));
    return productMfs.length ? productMfs : [{ title: "Item", status: "Not set" }];
  }

  return lineItems.map((edge, i) => {
    const title = edge?.node?.title || `Item ${i + 1}`;
    const mfKey = `product_${i + 1}_order_status`;
    const mfVal = byKey[mfKey] ?? byKey[`custom.${mfKey}`];
    if (mfVal) return { title, status: mfVal };
    const attrs = edge?.node?.customAttributes || [];
    const os = attrs.find((a) => a.key === "Order Status" && a.value);
    if (os) return { title, status: os.value };
    const is = attrs.find((a) => a.key === "Initial Status" && a.value);
    if (is) return { title, status: is.value };
    return { title, status: "Not set" };
  });
}

function formatMoneySet(moneySet) {
  if (!moneySet?.shopMoney) return null;
  const { amount, currencyCode } = moneySet.shopMoney;
  return `${amount} ${currencyCode}`;
}

function formatMoney(amount, currencyCode) {
  if (amount == null || currencyCode == null) return null;
  return `${amount} ${currencyCode}`;
}

function getPaymentDetails(order) {
  const isDraft = order.id?.includes("DraftOrder");
  const subtotal = formatMoneySet(order.subtotalPriceSet);
  const tax = formatMoneySet(order.totalTaxSet);
  const total = formatMoneySet(order.totalPriceSet);

  if (isDraft) {
    return {
      subtotal,
      tax,
      total,
      outstanding: total,
      paid: null,
    };
  }

  let outstanding = null;
  let paid = null;
  if (order.totalPriceSet?.shopMoney && order.totalOutstandingSet?.shopMoney) {
    const totalAmount = parseFloat(order.totalPriceSet.shopMoney.amount);
    const outstandingAmount = parseFloat(
      order.totalOutstandingSet.shopMoney.amount
    );
    const paidAmount = totalAmount - outstandingAmount;
    paid = formatMoney(
      paidAmount.toFixed(2),
      order.totalPriceSet.shopMoney.currencyCode
    );
    outstanding = formatMoneySet(order.totalOutstandingSet);
  }

  return { subtotal, tax, total, outstanding, paid };
}

// Keep in sync with `app/lib/order-status-helpers.js` → calculatePaymentStatus
function calculatePaymentStatus(order) {
  if (!order || String(order.id || "").includes("DraftOrder")) return "Not Paid";

  const dfs = order.displayFinancialStatus
    ? String(order.displayFinancialStatus).toUpperCase().trim()
    : "";

  if (dfs === "REFUNDED") return "Refunded";
  if (dfs === "PARTIALLY_REFUNDED") return "Partially Refunded";

  if (dfs === "PAID") return "Paid in Full";
  if (dfs === "PARTIALLY_PAID") return "Partially Paid";
  if (["PENDING", "AUTHORIZED", "VOIDED", "EXPIRED"].includes(dfs))
    return "Not Paid";

  const out = order.totalOutstandingSet?.shopMoney?.amount;
  if (out != null) {
    const n = parseFloat(out);
    if (n === 0) return "Paid in Full";
    if (n > 0) return "Partially Paid";
  }

  const refunded = parseFloat(order.totalRefundedSet?.shopMoney?.amount ?? "");
  if (Number.isFinite(refunded) && refunded > 0) {
    const total = parseFloat(order.totalPriceSet?.shopMoney?.amount ?? "");
    if (!Number.isFinite(total) || total <= 0) return "Partially Refunded";
    if (refunded >= total - 0.005) return "Refunded";
    return "Partially Refunded";
  }

  return "Not Paid";
}

function isCompletedContactStatus(s) {
  return s === "Picked Up - Sale Complete";
}

function getAttributesForDisplay(attrs, overrides) {
  const src = overrides || attrs || [];
  const map = new Map();
  for (const a of src) {
    if (!HIDDEN_ATTRIBUTES.has(a.key)) map.set(a.key, a.value || "");
  }
  const result = [];
  for (const key of ALWAYS_PRESENT_ATTRIBUTES) {
    result.push({
      key,
      value: normalizeSpecialOrderAttributeValue(key, map.get(key) || ""),
    });
  }
  for (const [key, value] of map) {
    if (!ALWAYS_PRESENT_ATTRIBUTES.includes(key)) result.push({ key, value });
  }
  return result;
}

function extractItemStatus(metafields, index, customAttributes) {
  const key = `product_${index + 1}_order_status`;
  const edges = metafields?.edges || [];
  const mf = edges.find((e) => e?.node?.key === key);
  if (mf?.node?.value) return mf.node.value;
  const attrs = customAttributes || [];
  const os = attrs.find((a) => a.key === "Order Status" && a.value);
  if (os) return os.value;
  const is = attrs.find((a) => a.key === "Initial Status" && a.value);
  if (is) return is.value;
  return "";
}

function getTone(status, type) {
  const s = String(status || "").toLowerCase();
  if (type === "contact") {
    if (!s || s.includes("not contacted") || s.includes("order canceled"))
      return "critical";
    if (s.includes("order pending")) return "neutral";
    if (s.includes("no answer")) return "critical";
    if (s.includes("left message")) return "warning";
    if (s.includes("spoke") || s.includes("picked up")) return "success";
    return "critical";
  }
  if (type === "overall") {
    if (s.includes("order pending")) return "warning";
    if (s.includes("picked up") || s.includes("sale complete")) return "success";
    if (s.includes("order canceled")) return "critical";
    return "warning";
  }
  if (type === "payment") {
    if (s.includes("not paid")) return "critical";
    if (s.includes("partially refunded")) return "warning";
    if (s.includes("refunded")) return "info";
    if (s.includes("partially paid")) return "warning";
    if (s.includes("paid in full") || (s.includes("paid") && !s.includes("not")))
      return "success";
    return "subdued";
  }
  if (type === "order") {
    if (s.includes("not ordered") || s.includes("canceled")) return "critical";
    if (s.includes("back ordered")) return "info";
    if (s.includes("ordered") || s.includes("received") || s.includes("delivered") || s.includes("picked up"))
      return "success";
    return "subdued";
  }
  return "subdued";
}

function getOrderButtonTone(status) {
  const t = getTone(status, "order");
  if (t === "critical") return "critical";
  if (t === "info") return "neutral";
  if (t === "success") return "neutral";
  return "auto";
}

const LIST_QUERY = `
  query GetSpecialOrders($query: String) {
    orders(first: 50, query: $query, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id name createdAt note displayFinancialStatus
          subtotalPriceSet { shopMoney { amount currencyCode } }
          totalTaxSet { shopMoney { amount currencyCode } }
          totalPriceSet { shopMoney { amount currencyCode } }
          totalRefundedSet { shopMoney { amount currencyCode } }
          totalOutstandingSet { shopMoney { amount currencyCode } }
          customer {
            id
            displayName
            firstName
            lastName
            email
            phone
            defaultAddress {
              id
              address1
              address2
              city
              provinceCode
              zip
              countryCodeV2
              company
            }
          }
          metafields(first: 250, namespace: "custom") {
            edges { node { key value } }
          }
          lineItems(first: 50) {
            edges {
              node {
                id title variantTitle
                quantity
                currentQuantity
                originalUnitPriceSet { shopMoney { amount currencyCode } }
                customAttributes { key value }
              }
            }
          }
        }
      }
    }
    draftOrders(first: 50, query: $query, sortKey: ID, reverse: true) {
      edges {
        node {
          id name status createdAt note2
          subtotalPriceSet { shopMoney { amount currencyCode } }
          totalTaxSet { shopMoney { amount currencyCode } }
          totalPriceSet { shopMoney { amount currencyCode } }
          customer {
            id
            displayName
            firstName
            lastName
            email
            phone
            defaultAddress {
              id
              address1
              address2
              city
              provinceCode
              zip
              countryCodeV2
              company
            }
          }
          metafields(first: 250, namespace: "custom") {
            edges { node { key value } }
          }
          lineItems(first: 50) {
            edges {
              node {
                id title
                quantity
                originalUnitPriceSet { shopMoney { amount currencyCode } }
                variant { title }
                customAttributes { key value }
              }
            }
          }
        }
      }
    }
  }
`;

const CUSTOMER_UPDATE_MUTATION = `
  mutation PosCustomerUpdate($input: CustomerInput!) {
    customerUpdate(input: $input) {
      customer { id }
      userErrors { field message }
    }
  }
`;

const CUSTOMER_ADDRESS_UPDATE_MUTATION = `
  mutation PosCustomerAddressUpdate(
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
      address { id }
      userErrors { field message }
    }
  }
`;

const CUSTOMER_ADDRESS_CREATE_MUTATION = `
  mutation PosCustomerAddressCreate(
    $customerId: ID!
    $address: MailingAddressInput!
    $setAsDefault: Boolean
  ) {
    customerAddressCreate(
      customerId: $customerId
      address: $address
      setAsDefault: $setAsDefault
    ) {
      address { id }
      userErrors { field message }
    }
  }
`;

const NODE_CUSTOMER_QUERY = `
  query PosNodeCustomer($id: ID!) {
    node(id: $id) {
      ... on Order {
        customer {
          id
          displayName
          firstName
          lastName
          email
          phone
          defaultAddress {
            id
            address1
            address2
            city
            provinceCode
            zip
            countryCodeV2
            company
          }
        }
      }
      ... on DraftOrder {
        customer {
          id
          displayName
          firstName
          lastName
          email
          phone
          defaultAddress {
            id
            address1
            address2
            city
            provinceCode
            zip
            countryCodeV2
            company
          }
        }
      }
    }
  }
`;

function Extension() {
  const { i18n } = shopify;
  const [rawOrders, setRawOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [localNote, setLocalNote] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [saving, setSaving] = useState(null);
  const [fulfillmentError, setFulfillmentError] = useState(null);
  const [customerForm, setCustomerForm] = useState(null);
  const [customerError, setCustomerError] = useState(null);
  const [isTablet, setIsTablet] = useState(null);

  useEffect(() => {
    shopify.device?.isTablet?.().then(setIsTablet).catch(() => setIsTablet(false));
  }, []);

  useEffect(() => {
    setFulfillmentError(null);
  }, [selectedOrder?.id]);

  const detailOrder = useMemo(() => {
    if (!selectedOrder) return null;
    return rawOrders.find((o) => o.id === selectedOrder.id) || selectedOrder;
  }, [rawOrders, selectedOrder]);

  const customerSyncKey = useMemo(() => {
    const c = detailOrder?.customer;
    if (!c?.id) return "";
    const a = c.defaultAddress;
    return [
      c.id,
      c.firstName ?? "",
      c.lastName ?? "",
      c.email ?? "",
      c.phone ?? "",
      a?.id ?? "",
      a?.address1 ?? "",
      a?.city ?? "",
      a?.zip ?? "",
    ].join("|");
  }, [detailOrder?.customer]);

  useEffect(() => {
    if (!selectedOrder) {
      setCustomerForm(null);
      setCustomerError(null);
      return;
    }
    const f = customerFormFromCustomer(detailOrder?.customer);
    setCustomerForm(f);
    setCustomerError(null);
  }, [selectedOrder?.id, customerSyncKey]);

  const col = isTablet ? COL_IPAD : COL_MOBILE;
  const minTableWidth = isTablet ? MIN_TABLE_IPAD : MIN_TABLE_MOBILE;

  const normalizedOrders = useMemo(() => {
    return [...rawOrders]
      .map((order) => {
        const contactStatus = extractContactStatus(order.metafields);
        const overallOrderStatus = extractOverallOrderStatus(order.metafields);
        const orderStatuses = extractOrderStatuses(order);
        const paymentStatus = calculatePaymentStatus(order);
        const customerName = order.customer?.displayName || "No customer";
        const productTitles = (order.lineItems?.edges || []).map(
          (e) => e?.node?.title || ""
        );
        return {
          ...order,
          contactStatus,
          overallOrderStatus,
          orderStatuses,
          paymentStatus,
          customerName,
          productTitles,
          createdDateLabel: order.createdAt
            ? new Date(order.createdAt).toLocaleDateString("en-US", {
                month: "numeric",
                day: "numeric",
                year: "2-digit",
              })
            : "",
        };
      })
      .sort((a, b) => {
        const tier = (o) => {
          if (o.overallOrderStatus === "Order Canceled") return 2;
          if (o.overallOrderStatus === "Picked Up - Sale Complete") return 1;
          return 0;
        };
        const ta = tier(a);
        const tb = tier(b);
        if (ta !== tb) return ta - tb;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
  }, [rawOrders]);

  const filteredOrders = useMemo(() => {
    let result = normalizedOrders;

    // Search: match customer name, order number, email, phone, or product name (same as admin)
    if (searchTerm?.trim()) {
      const term = searchTerm.trim().toLowerCase();
      const termDigits = term.replace(/\D/g, "");
      result = result.filter((order) => {
        if (
          order.customerName &&
          String(order.customerName).toLowerCase().includes(term)
        )
          return true;
        if (order.name && String(order.name).toLowerCase().includes(term))
          return true;
        if (termDigits && order.customer?.phone) {
          const phoneDigits = String(order.customer.phone).replace(/\D/g, "");
          if (phoneDigits.includes(termDigits))
            return true;
        }
        if (
          order.customer?.email &&
          String(order.customer.email).toLowerCase().includes(term)
        )
          return true;
        const statuses = order.orderStatuses || [];
        const hasMatchingProduct = statuses.some((item) => {
          const title =
            typeof item === "object" && item != null ? item.title : "";
          return title && String(title).toLowerCase().includes(term);
        });
        return hasMatchingProduct;
      });
    }

    // Status filter: same logic as admin
    if (statusFilter) {
      if (statusFilter === "Picked Up - Sale Complete") {
        result = result.filter(
          (order) =>
            order.overallOrderStatus === "Picked Up - Sale Complete"
        );
      } else if (statusFilter === "Order Canceled") {
        result = result.filter(
          (order) => order.overallOrderStatus === "Order Canceled"
        );
      } else if (statusFilter === "open") {
        result = result.filter((order) => {
          if (order.overallOrderStatus === "Picked Up - Sale Complete")
            return false;
          if (order.overallOrderStatus === "Order Canceled") return false;
          const statuses = order.orderStatuses || [];
          return statuses.some((item) => {
            const status =
              typeof item === "object" && item != null ? item.status : item;
            return status && OPEN_STATUSES.includes(status);
          });
        });
      } else {
        result = result.filter((order) => {
          const statuses = order.orderStatuses || [];
          return statuses.some((item) => {
            const status =
              typeof item === "object" && item != null ? item.status : item;
            return (
              status &&
              String(status).toLowerCase() === statusFilter.toLowerCase()
            );
          });
        });
      }
    }

    return result;
  }, [normalizedOrders, searchTerm, statusFilter]);

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    try {
      const data = await graphql(LIST_QUERY, {
        query: `tag:${SPECIAL_ORDER_TAG}`,
      });
      if (data?.errors?.length) {
        console.error("GetSpecialOrders GraphQL errors:", data.errors);
      }
      const orderNodes = data?.data?.orders?.edges?.map((e) => e.node) ?? [];
      let draftNodes =
        data?.data?.draftOrders?.edges?.map((e) => e.node) ?? [];
      draftNodes = draftNodes.filter((d) => d.status !== "COMPLETED");
      setRawOrders([...orderNodes, ...draftNodes]);
    } catch (err) {
      console.error("Failed to fetch special orders:", err);
      setRawOrders([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  /** Fulfillment fields are omitted from LIST_QUERY (cost/size on POS); load when opening an order. */
  useEffect(() => {
    const id = selectedOrder?.id;
    if (!id || String(id).includes("DraftOrder")) return;
    let cancelled = false;
    (async () => {
      try {
        const json = await graphql(ORDER_REFRESH_QUERY, { id });
        if (cancelled) return;
        const refreshed = json?.data?.order;
        if (refreshed) {
          setRawOrders((prev) =>
            prev.map((o) => (o.id === id ? { ...o, ...refreshed } : o))
          );
        }
      } catch (e) {
        console.error("Order refresh for detail failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedOrder?.id]);

  const handleUpdateContactStatus = useCallback(
    async (orderId, value) => {
      setSaving("contact");
      try {
        const res = await graphql(
          `mutation SetMetafield($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              userErrors { field message }
            }
          }`,
          {
            metafields: [
              {
                ownerId: orderId,
                namespace: "custom",
                key: "contact_status",
                value: String(value),
                type: "single_line_text_field",
              },
            ],
          }
        );
        const errs = res?.data?.metafieldsSet?.userErrors ?? [];
        if (errs.length) throw new Error(errs.map((e) => e.message).join(", "));
        setRawOrders((prev) =>
          prev.map((o) =>
            o.id === orderId
              ? {
                  ...o,
                  metafields: {
                    edges: [
                      ...(o.metafields?.edges || []).filter(
                        (e) => e.node.key !== "contact_status"
                      ),
                      { node: { key: "contact_status", value } },
                    ],
                  },
                }
              : o
          )
        );
        if (selectedOrder?.id === orderId) {
          setSelectedOrder((prev) => ({
            ...prev,
            contactStatus: value,
          }));
        }
      } finally {
        setSaving(null);
      }
    },
    [selectedOrder]
  );

  const handleUpdateOverallOrderStatus = useCallback(
    async (orderId, value) => {
      setSaving("overall");
      try {
        const res = await graphql(
          `mutation SetMetafield($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              userErrors { field message }
            }
          }`,
          {
            metafields: [
              {
                ownerId: orderId,
                namespace: "custom",
                key: "overall_order_status",
                value: String(value),
                type: "single_line_text_field",
              },
            ],
          }
        );
        const errs = res?.data?.metafieldsSet?.userErrors ?? [];
        if (errs.length) throw new Error(errs.map((e) => e.message).join(", "));
        setRawOrders((prev) =>
          prev.map((o) =>
            o.id === orderId
              ? {
                  ...o,
                  metafields: {
                    edges: [
                      ...(o.metafields?.edges || []).filter(
                        (e) => e.node.key !== "overall_order_status"
                      ),
                      { node: { key: "overall_order_status", value } },
                    ],
                  },
                }
              : o
          )
        );
        if (selectedOrder?.id === orderId) {
          setSelectedOrder((prev) => ({
            ...prev,
            overallOrderStatus: value,
          }));
        }
      } finally {
        setSaving(null);
      }
    },
    [selectedOrder]
  );

  const handleUpdateOrderStatus = useCallback(
    async (orderId, lineItemId, newStatus) => {
      setSaving("orderStatus");
      try {
        const order = rawOrders.find((o) => o.id === orderId);
        if (!order) return;
        const edges = order.lineItems?.edges || [];
        const idx = edges.findIndex((e) => e.node.id === lineItemId);
        if (idx < 0) return;
        const metafieldKey = `product_${idx + 1}_order_status`;
        const res = await graphql(
          `mutation SetMetafield($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              userErrors { field message }
            }
          }`,
          {
            metafields: [
              {
                ownerId: orderId,
                namespace: "custom",
                key: metafieldKey,
                value: String(newStatus),
                type: "single_line_text_field",
              },
            ],
          }
        );
        const errs = res?.data?.metafieldsSet?.userErrors ?? [];
        if (errs.length) throw new Error(errs.map((e) => e.message).join(", "));
        setRawOrders((prev) =>
          prev.map((o) => {
            if (o.id !== orderId) return o;
            const mfEdges = o.metafields?.edges || [];
            const filtered = mfEdges.filter((e) => e.node.key !== metafieldKey);
            return {
              ...o,
              metafields: {
                edges: [
                  ...filtered,
                  { node: { key: metafieldKey, value: newStatus } },
                ],
              },
            };
          })
        );
      } finally {
        setSaving(null);
      }
    },
    [rawOrders, selectedOrder]
  );

  const handleUpdateNote = useCallback(
    async (orderId, note) => {
      setSaving("note");
      try {
        const isDraft = orderId.includes("DraftOrder");
        if (isDraft) {
          await graphql(
            `mutation UpdateDraft($id: ID!, $input: DraftOrderInput!) {
              draftOrderUpdate(id: $id, input: $input) {
                userErrors { message }
              }
            }`,
            { id: orderId, input: { note: String(note) } }
          );
        } else {
          await graphql(
            `mutation UpdateOrder($input: OrderInput!) {
              orderUpdate(input: $input) {
                userErrors { message }
              }
            }`,
            { input: { id: orderId, note: String(note) } }
          );
        }
        setRawOrders((prev) =>
          prev.map((o) =>
            o.id === orderId
              ? { ...o, note: isDraft ? undefined : note, note2: isDraft ? note : undefined }
              : o
          )
        );
      } finally {
        setSaving(null);
      }
    },
    [selectedOrder]
  );

  const handleUpdateAttributes = useCallback(
    async (orderId, lineItemIndex, attributes) => {
      setSaving("attributes");
      try {
        const key = `lineitem_${lineItemIndex + 1}_attributes`;
        const normalized = normalizeAttributesArrayForSave(attributes);
        const res = await graphql(
          `mutation SetMetafield($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              userErrors { field message }
            }
          }`,
          {
            metafields: [
              {
                ownerId: orderId,
                namespace: "custom",
                key,
                value: JSON.stringify(normalized),
                type: "json",
              },
            ],
          }
        );
        const errs = res?.data?.metafieldsSet?.userErrors ?? [];
        if (errs.length) throw new Error(errs.map((e) => e.message).join(", "));
        setRawOrders((prev) =>
          prev.map((o) => {
            if (o.id !== orderId) return o;
            const mfEdges = o.metafields?.edges || [];
            const filtered = mfEdges.filter((e) => e.node.key !== key);
            return {
              ...o,
              metafields: {
                edges: [
                  ...filtered,
                  { node: { key, value: JSON.stringify(normalized) } },
                ],
              },
            };
          })
        );
      } finally {
        setSaving(null);
      }
    },
    []
  );

  const handleFulfillLineItem = useCallback(async (orderId, lineItemId) => {
    setSaving("fulfillment");
    setFulfillmentError(null);
    try {
      await fulfillOrderLineItem(graphql, orderId, lineItemId);
      const json = await graphql(ORDER_REFRESH_QUERY, { id: orderId });
      const refreshed = json.data?.order;
      if (refreshed) {
        setRawOrders((prev) =>
          prev.map((o) => (o.id === orderId ? { ...o, ...refreshed } : o))
        );
      }
    } catch (e) {
      setFulfillmentError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  }, []);

  const handleUnfulfillLineItem = useCallback(async (orderId, lineItemId) => {
    setSaving("fulfillment");
    setFulfillmentError(null);
    try {
      await unfulfillOrderLineItem(graphql, orderId, lineItemId);
      const json = await graphql(ORDER_REFRESH_QUERY, { id: orderId });
      const refreshed = json.data?.order;
      if (refreshed) {
        setRawOrders((prev) =>
          prev.map((o) => (o.id === orderId ? { ...o, ...refreshed } : o))
        );
      }
    } catch (e) {
      setFulfillmentError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  }, []);

  const handleSaveCustomer = useCallback(async () => {
    if (!customerForm?.customerId || !detailOrder) return;
    setSaving("customer");
    setCustomerError(null);
    try {
      const phone = normalizePhoneForShopify(customerForm.phone);
      const cuRes = await graphql(CUSTOMER_UPDATE_MUTATION, {
        input: {
          id: customerForm.customerId,
          firstName: customerForm.firstName,
          lastName: customerForm.lastName,
          email: customerForm.email?.trim() || null,
          phone,
        },
      });
      const cuErrors = cuRes?.data?.customerUpdate?.userErrors ?? [];
      if (cuErrors.length) {
        throw new Error(cuErrors.map((e) => e.message).join(", "));
      }
      const addressInput = {
        address1: customerForm.address1 || "",
        city: customerForm.city || "",
        zip: customerForm.zip || "",
        countryCode:
          (customerForm.countryCode || "US").toUpperCase().slice(0, 2) || "US",
      };
      if (customerForm.address2?.trim()) {
        addressInput.address2 = customerForm.address2.trim();
      }
      if (customerForm.company?.trim()) {
        addressInput.company = customerForm.company.trim();
      }
      if (customerForm.provinceCode?.trim()) {
        addressInput.provinceCode = customerForm.provinceCode
          .trim()
          .slice(0, 2);
      }
      const hasAddress =
        Boolean(customerForm.address1?.trim()) ||
        Boolean(customerForm.city?.trim()) ||
        Boolean(customerForm.zip?.trim()) ||
        Boolean(customerForm.company?.trim()) ||
        Boolean(customerForm.address2?.trim());
      if (customerForm.defaultAddressId) {
        const ar = await graphql(CUSTOMER_ADDRESS_UPDATE_MUTATION, {
          customerId: customerForm.customerId,
          addressId: customerForm.defaultAddressId,
          address: addressInput,
        });
        const ae = ar?.data?.customerAddressUpdate?.userErrors ?? [];
        if (ae.length) throw new Error(ae.map((e) => e.message).join(", "));
      } else if (hasAddress) {
        const ar = await graphql(CUSTOMER_ADDRESS_CREATE_MUTATION, {
          customerId: customerForm.customerId,
          address: addressInput,
          setAsDefault: true,
        });
        const ae = ar?.data?.customerAddressCreate?.userErrors ?? [];
        if (ae.length) throw new Error(ae.map((e) => e.message).join(", "));
      }
      const ref = await graphql(NODE_CUSTOMER_QUERY, { id: detailOrder.id });
      const node = ref?.data?.node;
      const customer = node?.customer;
      if (!customer) throw new Error("Could not refresh customer");
      setRawOrders((prev) =>
        prev.map((o) => (o.id === detailOrder.id ? { ...o, customer } : o))
      );
      setSelectedOrder((prev) =>
        prev?.id === detailOrder.id ? { ...prev, customer } : prev
      );
      const f = customerFormFromCustomer(customer);
      setCustomerForm(f);
      try {
        shopify.toast?.show?.(i18n.translate("customer_saved"));
      } catch (_) {}
    } catch (e) {
      setCustomerError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  }, [customerForm, detailOrder, i18n]);

  const handleResetCustomer = useCallback(() => {
    const o = rawOrders.find((x) => x.id === selectedOrder?.id) || selectedOrder;
    setCustomerForm(customerFormFromCustomer(o?.customer));
    setCustomerError(null);
  }, [rawOrders, selectedOrder]);

  if (selectedOrder) {
    const order = rawOrders.find((o) => o.id === selectedOrder.id) || selectedOrder;
    const noteValue =
      localNote !== ""
        ? localNote
        : order.id?.includes("DraftOrder")
          ? order.note2
          : order.note;

    const getNoteRows = (text) => {
      const t = (text || "").trim();
      if (!t) return 1;
      const lines = t.split("\n");
      const charsPerLine = isTablet ? 50 : 35;
      let rows = 0;
      for (const line of lines) {
        rows += Math.max(1, Math.ceil(line.length / charsPerLine));
      }
      return Math.min(12, Math.max(1, rows));
    };
    const metafields = order.metafields || { edges: [] };
    const attrsByIndex = {};
    metafields.edges.forEach((e) => {
      const k = e.node.key;
      if (k.startsWith("lineitem_") && k.endsWith("_attributes")) {
        const mid = k.slice(9, -11);
        const idx = parseInt(mid, 10) - 1;
        if (!isNaN(idx)) {
          try {
            const parsed = JSON.parse(e.node.value);
            if (Array.isArray(parsed)) attrsByIndex[idx] = parsed;
          } catch (_) {}
        }
      }
    });
    const contactStatus = extractContactStatus(metafields);
    const overallOrderStatus = extractOverallOrderStatus(metafields);
    const paymentStatus = calculatePaymentStatus(order);
    const isDraftOrder = order.id?.includes("DraftOrder");
    const fulfillmentOrderEdges = order.fulfillmentOrders?.edges || [];
    const rawFulfillments = order.fulfillments;
    const fulfillmentEdges = Array.isArray(rawFulfillments)
      ? rawFulfillments.map((node) => ({ node }))
      : [];
    const lineItems = (order.lineItems?.edges || []).map((edge, idx) => {
      const li = edge.node;
      const overrides = attrsByIndex[idx];
      const attrs = getAttributesForDisplay(li.customAttributes, overrides);
      const rawAttrs = overrides || li.customAttributes || [];
      const mfAdj = getOrderMetafieldString(
        metafields,
        `product_${idx + 1}_adjustment_type`
      );
      const mfExchangedFor = getOrderMetafieldString(
        metafields,
        `product_${idx + 1}_exchanged_for_title`
      );
      const adj = readLineItemAdjustmentFieldsPos(rawAttrs, mfAdj, mfExchangedFor);
      const orderStatus = extractItemStatus(
        metafields,
        idx,
        overrides || li.customAttributes
      );
      const priceSet = li.originalUnitPriceSet?.shopMoney;
      const priceLabel = priceSet
        ? priceSet.currencyCode === "USD"
          ? `$${parseFloat(priceSet.amount).toFixed(2)}`
          : `${priceSet.currencyCode} ${parseFloat(priceSet.amount).toFixed(2)}`
        : null;
      const qty = Number(li.quantity ?? 0);
      const currentQty = Number(li.currentQuantity ?? li.quantity ?? 0);
      const lineItemRefunded =
        !isDraftOrder && qty > currentQty;
      const fulfillmentUi = computeLineItemFulfillmentUi(
        li.id,
        fulfillmentOrderEdges,
        fulfillmentEdges
      );
      const canShowFulfillment = currentQty > 0 && !isDraftOrder;
      return {
        id: li.id,
        title: li.title,
        variantTitle: li.variant?.title ?? li.variantTitle,
        quantity: li.quantity,
        priceLabel,
        customAttributes: attrs,
        orderStatus: orderStatus || "Not Ordered",
        rawAttributes: rawAttrs,
        lineItemRefunded,
        lineItemExchanged: adj.itemAdjustmentType === "exchanged",
        exchangedForProductTitle: adj.exchangedForProductTitle || null,
        fulfillmentCanFulfill:
          canShowFulfillment && fulfillmentUi.canFulfill,
        fulfillmentCanUnfulfill:
          canShowFulfillment && fulfillmentUi.canUnfulfill,
        fulfillmentUnfulfillBlocked:
          canShowFulfillment && fulfillmentUi.unfulfillBlockedMixed,
      };
    });

    const customerFieldWidth =
      isTablet === true ? CUSTOMER_FIELD_WIDTH_IPAD : CUSTOMER_FIELD_WIDTH;

    const orderNoteSection = (
      <s-box
        padding={isTablet ? "small-500" : "base"}
        borderRadius="base"
        background="subdued"
      >
        <s-stack gap={isTablet ? "small-500" : "small"}>
          <s-text type="strong">{i18n.translate("note")}</s-text>
          <s-text-area
            value={noteValue || ""}
            rows={getNoteRows(noteValue)}
            onInput={(e) => setLocalNote(e.currentTarget.value)}
            onBlur={(e) =>
              handleUpdateNote(order.id, e.currentTarget.value)
            }
            disabled={!!saving}
          />
        </s-stack>
      </s-box>
    );

    return (
      <s-page inlineSize={isTablet ? "large" : "base"}>
        <s-scroll-box>
          <s-box padding="base">
            <s-stack gap="small">
              {isTablet === true ? null : <s-heading>{order.name}</s-heading>}
              <s-stack
                direction="inline"
                gap="small"
                alignItems="center"
                inlineSize="100%"
                justifyContent="space-between"
              >
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-button
                    variant="secondary"
                    onClick={() => {
                      setSelectedOrder(null);
                      setLocalNote("");
                      setFulfillmentError(null);
                      setCustomerError(null);
                    }}
                  >
                    ← {i18n.translate("back")}
                  </s-button>
                  <s-button
                    variant="primary"
                    onClick={() => {
                      const path = `/print?id=${encodeURIComponent(order.id)}`;
                      shopify.print.print(path);
                    }}
                  >
                    {i18n.translate("print_order_summary")}
                  </s-button>
                  {isTablet === true ? (
                    <s-text type="strong">{order.name}</s-text>
                  ) : null}
                </s-stack>
                {order.createdAt ||
                (order.customer?.id && customerForm) ? (
                  <s-stack direction="inline" gap="small" alignItems="center">
                    {order.createdAt ? (
                      <s-text type="strong">
                        {i18n.translate("date_created")}:{" "}
                        {new Date(order.createdAt).toLocaleDateString("en-US", {
                          month: "2-digit",
                          day: "2-digit",
                          year: "2-digit",
                        })}
                      </s-text>
                    ) : null}
                    {order.customer?.id && customerForm ? (
                      <>
                        <s-button
                          variant="primary"
                          onClick={handleSaveCustomer}
                          disabled={!!saving}
                        >
                          {i18n.translate("save_customer")}
                        </s-button>
                        <s-button
                          variant="secondary"
                          onClick={handleResetCustomer}
                          disabled={!!saving}
                        >
                          {i18n.translate("reset_customer")}
                        </s-button>
                      </>
                    ) : null}
                  </s-stack>
                ) : null}
              </s-stack>

              {fulfillmentError && !order.id?.includes("DraftOrder") && (
                <s-banner tone="critical" heading={fulfillmentError} />
              )}

              {customerError && (
                <s-banner tone="critical" heading={customerError} />
              )}

              <s-stack gap="small" blockSize="auto">
                {order.customer?.id && customerForm ? (
                  <s-box padding="base" inlineSize="100%" background="subdued" border="base" borderRadius="base">
                    <span
                      style={{
                        display: "block",
                        fontSize: "calc(1em - 3pt)",
                      }}
                    >
                    <s-stack gap="small">
                      {/* Row 1: POS ignores raw div flex — use s-stack inline + s-box like TabletOrderDetailAttributeCell */}
                      <s-stack
                        direction="inline"
                        gap="small-300"
                        alignItems="end"
                        inlineSize="100%"
                      >
                        <s-box
                          inlineSize={customerFieldWidth.firstName}
                          minInlineSize={customerFieldWidth.firstName}
                          maxInlineSize={customerFieldWidth.firstName}
                        >
                          <s-text-field
                            label={i18n.translate("first_name")}
                            value={customerForm.firstName}
                            onInput={(e) =>
                              setCustomerForm((f) =>
                                f
                                  ? { ...f, firstName: e.currentTarget.value }
                                  : f
                              )
                            }
                            disabled={!!saving}
                          />
                        </s-box>
                        <s-box
                          inlineSize={customerFieldWidth.lastName}
                          minInlineSize={customerFieldWidth.lastName}
                          maxInlineSize={customerFieldWidth.lastName}
                        >
                          <s-text-field
                            label={i18n.translate("last_name")}
                            value={customerForm.lastName}
                            onInput={(e) =>
                              setCustomerForm((f) =>
                                f
                                  ? { ...f, lastName: e.currentTarget.value }
                                  : f
                              )
                            }
                            disabled={!!saving}
                          />
                        </s-box>
                        <s-box
                          inlineSize={customerFieldWidth.email}
                          minInlineSize={customerFieldWidth.email}
                          maxInlineSize={customerFieldWidth.email}
                        >
                          <s-text-field
                            label={i18n.translate("email_label")}
                            value={customerForm.email}
                            onInput={(e) =>
                              setCustomerForm((f) =>
                                f ? { ...f, email: e.currentTarget.value } : f
                              )
                            }
                            disabled={!!saving}
                          />
                        </s-box>
                        <s-box
                          inlineSize={customerFieldWidth.phone}
                          minInlineSize={customerFieldWidth.phone}
                          maxInlineSize={customerFieldWidth.phone}
                        >
                          <s-text-field
                            label={i18n.translate("phone_label")}
                            value={customerForm.phone}
                            onInput={(e) =>
                              setCustomerForm((f) =>
                                f ? { ...f, phone: e.currentTarget.value } : f
                              )
                            }
                            disabled={!!saving}
                          />
                        </s-box>
                        {!isTablet ? (
                        <s-box
                          inlineSize={customerFieldWidth.company}
                          minInlineSize={customerFieldWidth.company}
                          maxInlineSize={customerFieldWidth.company}
                        >
                          <s-text-field
                            label={i18n.translate("company")}
                            value={customerForm.company}
                            onInput={(e) =>
                              setCustomerForm((f) =>
                                f
                                  ? { ...f, company: e.currentTarget.value }
                                  : f
                              )
                            }
                            disabled={!!saving}
                          />
                        </s-box>
                        ) : null}
                      </s-stack>
                      <s-stack
                        direction="inline"
                        gap="small-300"
                        alignItems="end"
                        inlineSize="100%"
                      >
                        <s-box
                          inlineSize={customerFieldWidth.address1}
                          minInlineSize={customerFieldWidth.address1}
                          maxInlineSize={customerFieldWidth.address1}
                        >
                          <s-text-field
                            label={i18n.translate("address_line_1")}
                            value={customerForm.address1}
                            onInput={(e) =>
                              setCustomerForm((f) =>
                                f
                                  ? { ...f, address1: e.currentTarget.value }
                                  : f
                              )
                            }
                            disabled={!!saving}
                          />
                        </s-box>
                        <s-box
                          inlineSize={customerFieldWidth.city}
                          minInlineSize={customerFieldWidth.city}
                          maxInlineSize={customerFieldWidth.city}
                        >
                          <s-text-field
                            label={i18n.translate("city")}
                            value={customerForm.city}
                            onInput={(e) =>
                              setCustomerForm((f) =>
                                f ? { ...f, city: e.currentTarget.value } : f
                              )
                            }
                            disabled={!!saving}
                          />
                        </s-box>
                        <s-box
                          inlineSize={customerFieldWidth.state}
                          minInlineSize={customerFieldWidth.state}
                          maxInlineSize={customerFieldWidth.state}
                        >
                          <s-text-field
                            label={i18n.translate("state")}
                            value={customerForm.provinceCode}
                            onInput={(e) =>
                              setCustomerForm((f) =>
                                f
                                  ? {
                                      ...f,
                                      provinceCode: e.currentTarget.value
                                        .toUpperCase()
                                        .replace(/[^A-Za-z]/g, "")
                                        .slice(0, 2),
                                    }
                                  : f
                              )
                            }
                            disabled={!!saving}
                          />
                        </s-box>
                        <s-box
                          inlineSize={customerFieldWidth.zip}
                          minInlineSize={customerFieldWidth.zip}
                          maxInlineSize={customerFieldWidth.zip}
                        >
                          <s-text-field
                            label={
                              isTablet === true
                                ? "Zip Code"
                                : i18n.translate("zip_postal")
                            }
                            value={customerForm.zip}
                            onInput={(e) =>
                              setCustomerForm((f) =>
                                f ? { ...f, zip: e.currentTarget.value } : f
                              )
                            }
                            disabled={!!saving}
                          />
                        </s-box>
                        {!isTablet ? (
                        <s-box
                          inlineSize={customerFieldWidth.country}
                          minInlineSize={customerFieldWidth.country}
                          maxInlineSize={customerFieldWidth.country}
                        >
                          <s-text-field
                            label={i18n.translate("country")}
                            value={customerForm.countryCode}
                            onInput={(e) => {
                              const v = e.currentTarget.value
                                .toUpperCase()
                                .replace(/[^A-Z]/g, "")
                                .slice(0, 2);
                              setCustomerForm((f) =>
                                f ? { ...f, countryCode: v || "US" } : f
                              );
                            }}
                            disabled={!!saving}
                          />
                        </s-box>
                        ) : null}
                      </s-stack>
                    </s-stack>
                    </span>
                  </s-box>
                ) : (
                  <s-box padding="base" inlineSize="100%" background="subdued" border="base" borderRadius="base">
                    <s-text color="subdued">{i18n.translate("no_customer_on_order")}</s-text>
                  </s-box>
                )}

                {isTablet === true ? orderNoteSection : null}

                {!isTablet ? (
                <s-stack gap="10px" blockSize="auto">
                  <s-divider />
                <s-box padding="base" inlineSize="100%" background="subdued" border="base" borderRadius="base">
                  <s-stack gap="small">
                    <s-text type="strong">{i18n.translate("contact_status")}</s-text>
                    <s-button
                      variant="secondary"
                      commandFor="contact-status-modal"
                      command="--show"
                      disabled={!!saving}
                    >
                      {CONTACT_STATUS_OPTIONS.includes(contactStatus) ? contactStatus : i18n.translate("select")}
                    </s-button>
                    <s-modal id="contact-status-modal" heading={i18n.translate("contact_status")}>
                      <s-stack gap="small">
                        {CONTACT_STATUS_OPTIONS.map((opt) => (
                          <s-button
                            key={opt}
                            variant="secondary"
                            commandFor="contact-status-modal"
                            command="--hide"
                            onClick={() => handleUpdateContactStatus(order.id, opt)}
                          >
                            {opt}
                          </s-button>
                        ))}
                      </s-stack>
                    </s-modal>
                    <s-banner
                      tone={getTone(contactStatus, "contact") === "subdued" || getTone(contactStatus, "contact") === "neutral" ? "auto" : getTone(contactStatus, "contact")}
                      heading={CONTACT_STATUS_OPTIONS.includes(contactStatus) ? contactStatus : ""}
                    />
                  </s-stack>
                </s-box>
                <s-divider />
                <s-box padding="base" inlineSize="100%" background="subdued" border="base" borderRadius="base">
                  <s-stack gap="small">
                    <s-text type="strong">{i18n.translate("overall_order_status")}</s-text>
                    <s-button
                      variant="secondary"
                      commandFor="overall-order-status-modal"
                      command="--show"
                      disabled={!!saving}
                    >
                      {OVERALL_ORDER_STATUS_OPTIONS.includes(overallOrderStatus) ? overallOrderStatus : "Order Pending"}
                    </s-button>
                    <s-modal id="overall-order-status-modal" heading={i18n.translate("overall_order_status")}>
                      <s-stack gap="small">
                        {OVERALL_ORDER_STATUS_OPTIONS.map((opt) => (
                          <s-button
                            key={opt}
                            variant="secondary"
                            commandFor="overall-order-status-modal"
                            command="--hide"
                            onClick={() => handleUpdateOverallOrderStatus(order.id, opt)}
                          >
                            {opt}
                          </s-button>
                        ))}
                      </s-stack>
                    </s-modal>
                    <s-banner
                      tone={getTone(overallOrderStatus, "overall") === "subdued" || getTone(overallOrderStatus, "overall") === "neutral" ? "auto" : getTone(overallOrderStatus, "overall")}
                      heading={OVERALL_ORDER_STATUS_OPTIONS.includes(overallOrderStatus) ? overallOrderStatus : "Order Pending"}
                    />
                  </s-stack>
                </s-box>
                <s-divider />
                <s-box padding="base" inlineSize="100%" background="subdued" border="base" borderRadius="base">
                  <s-stack gap="small">
                    <s-text type="strong">{i18n.translate("payment_status")}</s-text>
                    <s-banner
                      tone={getTone(paymentStatus, "payment") === "subdued" || getTone(paymentStatus, "payment") === "neutral" ? "auto" : getTone(paymentStatus, "payment")}
                      heading={paymentStatus}
                    />
                    {(() => {
                      const details = getPaymentDetails(order);
                      return (
                        <>
                          {details.subtotal && (
                            <s-text color="subdued" type="small">
                              {i18n.translate("subtotal")}: {details.subtotal}
                            </s-text>
                          )}
                          {details.tax && (
                            <s-text color="subdued" type="small">
                              {i18n.translate("tax")}: {details.tax}
                            </s-text>
                          )}
                          {details.total && (
                            <s-text color="subdued" type="small">
                              {i18n.translate("total")}: {details.total}
                            </s-text>
                          )}
                          {details.outstanding && (
                            <s-text color="subdued" type="small">
                              {i18n.translate("balance")}: {details.outstanding}
                            </s-text>
                          )}
                          {details.paid && (
                            <s-text color="subdued" type="small">
                              {i18n.translate("paid")}: {details.paid}
                            </s-text>
                          )}
                        </>
                      );
                    })()}
                  </s-stack>
                </s-box>
                </s-stack>
              ) : (
                /* iPad: status cards in one row below customer */
              <>
                <s-divider />
                <s-stack direction="inline" gap="100px" blockSize="auto">
                <s-box padding="base" inlineSize="220px" background="subdued" border="base" borderRadius="base">
                  <s-stack gap="small">
                    <s-text type="strong">{i18n.translate("contact_status")}</s-text>
                    <s-button
                      variant="secondary"
                      commandFor="contact-status-modal"
                      command="--show"
                      disabled={!!saving}
                    >
                      {CONTACT_STATUS_OPTIONS.includes(contactStatus) ? `${contactStatus}${" ".repeat(10)}↕️` : i18n.translate("select")}
                    </s-button>
                    <s-modal id="contact-status-modal" heading={i18n.translate("contact_status")}>
                      <s-stack gap="small">
                        {CONTACT_STATUS_OPTIONS.map((opt) => (
                          <s-button
                            key={opt}
                            variant="secondary"
                            commandFor="contact-status-modal"
                            command="--hide"
                            onClick={() => handleUpdateContactStatus(order.id, opt)}
                          >
                            {opt}
                          </s-button>
                        ))}
                      </s-stack>
                    </s-modal>
                    <s-banner
                      tone={getTone(contactStatus, "contact") === "subdued" || getTone(contactStatus, "contact") === "neutral" ? "auto" : getTone(contactStatus, "contact")}
                      heading={CONTACT_STATUS_OPTIONS.includes(contactStatus) ? contactStatus : ""}
                    />
                  </s-stack>
                </s-box>
                <s-divider />
                <s-box padding="base" inlineSize="220px" background="subdued" border="base" borderRadius="base">
                  <s-stack gap="small">
                    <s-text type="strong">{i18n.translate("overall_order_status")}</s-text>
                    <s-button
                      variant="secondary"
                      commandFor="overall-order-status-modal"
                      command="--show"
                      disabled={!!saving}
                    >
                      {OVERALL_ORDER_STATUS_OPTIONS.includes(overallOrderStatus) ? `${overallOrderStatus}${" ".repeat(10)}↕️` : "Order Pending"}
                    </s-button>
                    <s-modal id="overall-order-status-modal" heading={i18n.translate("overall_order_status")}>
                      <s-stack gap="small">
                        {OVERALL_ORDER_STATUS_OPTIONS.map((opt) => (
                          <s-button
                            key={opt}
                            variant="secondary"
                            commandFor="overall-order-status-modal"
                            command="--hide"
                            onClick={() => handleUpdateOverallOrderStatus(order.id, opt)}
                          >
                            {opt}
                          </s-button>
                        ))}
                      </s-stack>
                    </s-modal>
                    <s-banner
                      tone={getTone(overallOrderStatus, "overall") === "subdued" || getTone(overallOrderStatus, "overall") === "neutral" ? "auto" : getTone(overallOrderStatus, "overall")}
                      heading={OVERALL_ORDER_STATUS_OPTIONS.includes(overallOrderStatus) ? overallOrderStatus : "Order Pending"}
                    />
                  </s-stack>
                </s-box>
                <s-divider />
                <s-box padding="base" inlineSize="220px" background="subdued" border="base" borderRadius="base">
                  <s-stack gap="small">
                    <s-text type="strong">{i18n.translate("payment_status")}</s-text>
                    <s-banner
                      tone={getTone(paymentStatus, "payment") === "subdued" || getTone(paymentStatus, "payment") === "neutral" ? "auto" : getTone(paymentStatus, "payment")}
                      heading={paymentStatus}
                    />
                    {(() => {
                      const details = getPaymentDetails(order);
                      return (
                        <>
                          {details.subtotal && (
                            <s-text color="subdued" type="small">
                              {i18n.translate("subtotal")}: {details.subtotal}
                            </s-text>
                          )}
                          {details.tax && (
                            <s-text color="subdued" type="small">
                              {i18n.translate("tax")}: {details.tax}
                            </s-text>
                          )}
                          {details.total && (
                            <s-text color="subdued" type="small">
                              {i18n.translate("total")}: {details.total}
                            </s-text>
                          )}
                          {details.outstanding && (
                            <s-text color="subdued" type="small">
                              {i18n.translate("balance")}: {details.outstanding}
                            </s-text>
                          )}
                          {details.paid && (
                            <s-text color="subdued" type="small">
                              {i18n.translate("paid")}: {details.paid}
                            </s-text>
                          )}
                        </>
                      );
                    })()}
                  </s-stack>
                </s-box>
                </s-stack>
              </>
              )}
              </s-stack>

              {isTablet !== true ? orderNoteSection : null}

              {lineItems.map((item, idx) => (
                <Fragment key={item.id}>
                  {idx > 0 && <s-divider />}
                  <s-box
                    padding="base"
                    borderRadius="base"
                    borderWidth="base"
                    background="subdued"
                  >
                    <s-stack gap="small">
                      <s-stack direction="inline" gap="small" inlineSize="100%" justifyContent="space-between" alignItems="center">
                        <s-stack direction="inline" gap="small" alignItems="center">
                          <s-heading>{item.title}</s-heading>
                          {item.lineItemRefunded && (
                            <s-badge tone="critical">Refunded</s-badge>
                          )}
                          {item.lineItemExchanged && (
                            <s-stack direction="inline" gap="small-300" alignItems="center">
                              <s-badge tone="warning">Exchanged</s-badge>
                              {item.exchangedForProductTitle ? (
                                <s-text type="strong">{item.exchangedForProductTitle}</s-text>
                              ) : null}
                            </s-stack>
                          )}
                        </s-stack>
                        <s-stack direction="inline" gap="small">
                          <s-heading>{i18n.translate("quantity")}: {item.quantity}</s-heading>
                          {item.priceLabel && (
                            <s-heading>{item.priceLabel}</s-heading>
                          )}
                        </s-stack>
                      </s-stack>
                      {item.variantTitle && (
                        <s-text color="subdued">{item.variantTitle}</s-text>
                      )}
                      {!isDraftOrder &&
                        (item.fulfillmentCanFulfill ||
                          item.fulfillmentCanUnfulfill ||
                          item.fulfillmentUnfulfillBlocked) && (
                          <s-stack direction="inline" gap="small" alignItems="center">
                            {item.fulfillmentCanFulfill && (
                              <s-button
                                variant="secondary"
                                onClick={() =>
                                  handleFulfillLineItem(order.id, item.id)
                                }
                                disabled={!!saving}
                              >
                                {i18n.translate("fulfill_item")}
                              </s-button>
                            )}
                            {item.fulfillmentCanUnfulfill && (
                              <s-button
                                variant="secondary"
                                tone="critical"
                                onClick={() =>
                                  handleUnfulfillLineItem(order.id, item.id)
                                }
                                disabled={!!saving}
                              >
                                {i18n.translate("unfulfill_item")}
                              </s-button>
                            )}
                            {item.fulfillmentUnfulfillBlocked && (
                              <s-text color="subdued" type="small">
                                {i18n.translate("fulfillment_unfulfill_blocked")}
                              </s-text>
                            )}
                          </s-stack>
                        )}
                      <s-stack gap="small">
                        <s-box inlineSize="100%">
                          <s-stack gap="small">
                            <s-button
                              variant="secondary"
                              tone={getOrderButtonTone(item.orderStatus)}
                              commandFor={`order-status-modal-${item.id}`}
                              command="--show"
                              disabled={!!saving}
                            >
                              {ORDER_STATUS_OPTIONS.includes(item.orderStatus) ? (isTablet ? `${item.orderStatus}${" ".repeat(30)}↕️` : item.orderStatus) : "Not Ordered"}
                            </s-button>
                            <s-modal id={`order-status-modal-${item.id}`}>
                              <s-stack gap="base">
                                {ORDER_STATUS_OPTIONS.map((opt) => (
                                  <s-button
                                    key={opt}
                                    variant="secondary"
                                    commandFor={`order-status-modal-${item.id}`}
                                    command="--hide"
                                    onClick={() => handleUpdateOrderStatus(order.id, item.id, opt)}
                                  >
                                    {opt}
                                  </s-button>
                                ))}
                              </s-stack>
                            </s-modal>
                            <s-stack gap="small" inlineSize="100%">
                              <s-banner
                                tone={getTone(item.orderStatus, "order") === "subdued" ? "auto" : getTone(item.orderStatus, "order")}
                                heading={ORDER_STATUS_OPTIONS.includes(item.orderStatus) ? item.orderStatus : "Not Ordered"}
                              />
                              <s-stack
                                direction="inline"
                                inlineSize="100%"
                                justifyContent="end"
                              >
                                <s-text type="strong">
                                  {i18n.translate("cart_line_item_details_heading")}
                                </s-text>
                              </s-stack>
                            </s-stack>
                          </s-stack>
                        </s-box>
                      </s-stack>
                      {isTablet ? (
                        <>
                          <s-stack
                            direction="inline"
                            gap="small"
                            alignItems="stretch"
                            inlineSize="100%"
                          >
                            {TABLET_ORDER_DETAIL_ROW1_KEYS.map((key) => {
                              const attr = (item.customAttributes || []).find(
                                (a) => a.key === key
                              );
                              if (!attr) return null;
                              return (
                                <TabletOrderDetailAttributeCell
                                  key={attr.key}
                                  attr={attr}
                                  item={item}
                                  orderId={order.id}
                                  lineIndex={idx}
                                  saving={saving}
                                  minInlineSize="23%"
                                  handleUpdateAttributes={handleUpdateAttributes}
                                  i18n={i18n}
                                  stackDateControlsVertically={false}
                                />
                              );
                            })}
                          </s-stack>
                          <s-stack
                            direction="inline"
                            gap="small"
                            alignItems="stretch"
                            inlineSize="100%"
                          >
                            {TABLET_ORDER_DETAIL_ROW2_KEYS.map((key) => {
                              const attr = (item.customAttributes || []).find(
                                (a) => a.key === key
                              );
                              if (!attr) return null;
                              return (
                                <TabletOrderDetailAttributeCell
                                  key={attr.key}
                                  attr={attr}
                                  item={item}
                                  orderId={order.id}
                                  lineIndex={idx}
                                  saving={saving}
                                  minInlineSize="31%"
                                  handleUpdateAttributes={handleUpdateAttributes}
                                  i18n={i18n}
                                  stackDateControlsVertically
                                />
                              );
                            })}
                          </s-stack>
                          {(item.customAttributes || [])
                            .filter(
                              (a) =>
                                !["Brand", "Type", "Style #", "Size", "Color", "Date Ordered", "Order Confirmation Number"].includes(a.key)
                            )
                            .map((attr) => (
                              <s-stack key={attr.key} gap="small-300">
                                <s-text type="bodySmall">{attr.key}</s-text>
                                <s-text-field
                                  value={attr.value}
                                  onBlur={(e) => {
                                    const newVal = e.currentTarget.value;
                                    const newAttrs = item.customAttributes.map((a) => ({
                                      key: a.key,
                                      value: a.key === attr.key ? newVal : a.value,
                                    }));
                                    handleUpdateAttributes(order.id, idx, newAttrs);
                                  }}
                                  disabled={!!saving}
                                />
                              </s-stack>
                            ))}
                        </>
                      ) : (
                        item.customAttributes.map((attr) => (
                          <s-stack key={attr.key} gap="small-300">
                            <s-text type="bodySmall">{attr.key}</s-text>
                            {attr.key === "Date Ordered" ? (
                              <s-stack direction="inline" gap="small" alignItems="end">
                                <s-box inlineSize="100%">
                                  <s-date-field
                                    value={attr.value || ""}
                                    onBlur={(e) => {
                                      applyLineItemAttributeValue(
                                        item,
                                        attr.key,
                                        e.currentTarget?.value ?? "",
                                        order.id,
                                        idx,
                                        handleUpdateAttributes
                                      );
                                    }}
                                    onInput={(e) => {
                                      const v = e.currentTarget?.value ?? "";
                                      if (v === "") {
                                        applyLineItemAttributeValue(
                                          item,
                                          attr.key,
                                          "",
                                          order.id,
                                          idx,
                                          handleUpdateAttributes
                                        );
                                      }
                                    }}
                                    disabled={!!saving}
                                  />
                                </s-box>
                                <s-button
                                  variant="secondary"
                                  disabled={
                                    !!saving ||
                                    !(attr.value && String(attr.value).trim())
                                  }
                                  onClick={() => {
                                    applyLineItemAttributeValue(
                                      item,
                                      attr.key,
                                      "",
                                      order.id,
                                      idx,
                                      handleUpdateAttributes
                                    );
                                  }}
                                >
                                  {i18n.translate("clear_date")}
                                </s-button>
                              </s-stack>
                            ) : (
                              <s-text-field
                                value={attr.value}
                                onBlur={(e) => {
                                  const newVal = e.currentTarget.value;
                                  const newAttrs = item.customAttributes.map((a) => ({
                                    key: a.key,
                                    value: a.key === attr.key ? newVal : a.value,
                                  }));
                                  handleUpdateAttributes(order.id, idx, newAttrs);
                                }}
                                disabled={!!saving}
                              />
                            )}
                          </s-stack>
                        ))
                      )}
                    </s-stack>
                  </s-box>
                  <s-divider />
                </Fragment>
              ))}

              {saving && (
                <s-text color="subdued">{i18n.translate("saving")}</s-text>
              )}
            </s-stack>
          </s-box>
        </s-scroll-box>
      </s-page>
    );
  }

  return (
    <s-page heading={i18n.translate("modal_heading")} inlineSize={isTablet ? "large" : "base"}>
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="base">
            {/* Filters section - search + dropdown */}
            <s-box padding="base" borderRadius="base" background="subdued">
              <s-stack gap="base">
                {isTablet && (
                  <s-heading>🔍 Search</s-heading>
                )}
                <s-text-field
                  label={i18n.translate("search")}
                  value={searchTerm}
                  onInput={(e) => setSearchTerm(e.currentTarget.value)}
                  placeholder={i18n.translate("search_placeholder")}
                />
                {isTablet ? (
                  <>
                    <s-stack direction="inline" gap="small" inlineSize="100%" justifyContent="space-between" alignItems="center">
                      <s-heading>{i18n.translate("filter")}</s-heading>
                      <s-button
                        variant="secondary"
                        onClick={() => {
                          setSearchTerm("");
                          setStatusFilter("");
                          fetchOrders();
                        }}
                        disabled={loading}
                      >
                        {i18n.translate("refresh")}
                      </s-button>
                    </s-stack>
                    <s-button
                      variant="secondary"
                      commandFor="filter-modal"
                      command="--show"
                      inlineSize="fill"
                    >
                      <s-box padding="large">
                        <span style={{ fontSize: "40px", fontWeight: "600" }}>{`${getFilterLabel(statusFilter, i18n)}${" ".repeat(30)}↕️`}</span>
                      </s-box>
                    </s-button>
                  </>
                ) : (
                  <>
                    <s-text type="strong">{i18n.translate("filter")}</s-text>
                    <s-button
                      variant="secondary"
                      commandFor="filter-modal"
                      command="--show"
                    >
                      {getFilterLabel(statusFilter, i18n)}
                    </s-button>
                    <s-button
                      variant="secondary"
                      onClick={() => {
                        setSearchTerm("");
                        setStatusFilter("");
                        fetchOrders();
                      }}
                      disabled={loading}
                    >
                      {i18n.translate("refresh")}
                    </s-button>
                  </>
                )}
                <s-modal id="filter-modal" heading={i18n.translate("filter")}>
                  <s-stack gap="base">
                    {FILTER_OPTIONS.map((opt) => (
                      <s-button
                        key={opt.value || "all"}
                        variant="secondary"
                        commandFor="filter-modal"
                        command="--hide"
                        onClick={() => setStatusFilter(opt.value)}
                      >
                        {opt.labelKey ? i18n.translate(opt.labelKey) : opt.label}
                      </s-button>
                    ))}
                  </s-stack>
                </s-modal>
              </s-stack>
            </s-box>

            {loading ? (
              <s-text>{i18n.translate("loading")}</s-text>
            ) : filteredOrders.length === 0 ? (
              <s-text color="subdued">{i18n.translate("empty")}</s-text>
            ) : isTablet !== true ? (
              /* iPhone: stacked card layout (includes isTablet null until device resolves) */
              <s-stack gap="base">
                {filteredOrders.map((order, index) => {
                  const completed = order.overallOrderStatus === "Picked Up - Sale Complete";
                  const canceled = order.overallOrderStatus === "Order Canceled";
                  const orderBadgeTone = completed ? "success" : canceled ? "critical" : "warning";
                  const statusItems = (order.orderStatuses || []).length > 0
                    ? order.orderStatuses
                    : [{ title: "Item", status: "Not set" }];
                  return (
                    <Fragment key={order.id}>
                      <s-box padding="base" borderRadius="base" background="subdued">
                        <s-stack gap="base">
                          <s-stack
                            direction="inline"
                            gap="small"
                            inlineSize="100%"
                            justifyContent="space-between"
                            alignItems="start"
                          >
                            <s-box inlineSize="fill" minInlineSize="0">
                              <s-banner tone={orderBadgeTone} heading={order.name} />
                            </s-box>
                            <s-box inlineSize="auto">
                              <s-button
                                variant="secondary"
                                onClick={() => {
                                  setSelectedOrder(order);
                                  setLocalNote(
                                    order.id?.includes("DraftOrder")
                                      ? order.note2 || ""
                                      : order.note || ""
                                  );
                                }}
                              >
                                {i18n.translate("view_details")}
                              </s-button>
                            </s-box>
                          </s-stack>
                          <s-heading>{order.customerName}</s-heading>
                          <s-stack direction="inline" gap="small">
                            <s-text type="strong">{i18n.translate("column_order_status")}</s-text>
                            <s-stack direction="block" gap="small-300">
                              {statusItems.map((item, i) => {
                                const title = typeof item === "object" && item != null ? item.title : "Item";
                                const status = typeof item === "object" && item != null ? item.status : item;
                                const label = `${title} - ${String(status ?? "Not set").trim() || "Not set"}`;
                                return (
                                  <s-badge key={i} tone={getTone(status, "order")}>
                                    {label}
                                  </s-badge>
                                );
                              })}
                            </s-stack>
                          </s-stack>
                          <s-stack direction="inline" gap="small">
                            <s-text type="strong">{i18n.translate("payment_status")}</s-text>
                            <s-badge tone={getTone(order.paymentStatus, "payment")}>
                              {order.paymentStatus}
                            </s-badge>
                          </s-stack>
                          <s-stack direction="inline" gap="small">
                            <s-text type="strong">{i18n.translate("contact_status")}</s-text>
                            <s-badge tone={getTone(order.contactStatus, "contact")}>
                              {order.contactStatus || "Not Contacted"}
                            </s-badge>
                          </s-stack>
                          <s-stack direction="inline" gap="small">
                            <s-text type="strong">{i18n.translate("date_created")}</s-text>
                            <s-text color="subdued" type="small">{order.createdDateLabel || ""}</s-text>
                          </s-stack>
                        </s-stack>
                      </s-box>
                      {index < filteredOrders.length - 1 && (
                        <s-divider />
                      )}
                    </Fragment>
                  );
                })}
              </s-stack>
            ) : (
              /* iPad: table layout */
              <s-box minInlineSize={minTableWidth}>
                <s-stack gap="small-100">
                  <s-box padding="base" background="subdued" border="base" borderRadius="base" minInlineSize={minTableWidth}>
                    <s-stack direction="inline" gap="small">
                    <s-box inlineSize={col.order} minInlineSize={col.order}>
                      <s-stack gap="none">
                        <s-text type="strong">{i18n.translate("column_order").toUpperCase()}</s-text>
                        <s-box blockSize="1px" inlineSize="100%" background="base" />
                      </s-stack>
                    </s-box>
                    <s-box inlineSize="auto" minInlineSize="0" />
                    <s-box inlineSize={col.customer} minInlineSize={col.customer}>
                      <s-stack gap="none">
                        <s-text type="strong">{i18n.translate("column_customer").toUpperCase()}</s-text>
                        <s-box blockSize="1px" inlineSize="100%" background="base" />
                      </s-stack>
                    </s-box>
                    <s-box inlineSize={col.status} minInlineSize={col.status}>
                      <s-stack gap="none">
                        <s-text type="strong">{i18n.translate("column_order_status").toUpperCase()}</s-text>
                        <s-box blockSize="1px" inlineSize="100%" background="base" />
                      </s-stack>
                    </s-box>
                    <s-box inlineSize={col.payment} minInlineSize={col.payment}>
                      <s-stack gap="none">
                        <s-text type="strong">{i18n.translate("column_payment").toUpperCase()}</s-text>
                        <s-box blockSize="1px" inlineSize="100%" background="base" />
                      </s-stack>
                    </s-box>
                    <s-box inlineSize={col.contact} minInlineSize={col.contact}>
                      <s-stack gap="none">
                        <s-text type="strong">{i18n.translate("column_contact").toUpperCase()}</s-text>
                        <s-box blockSize="1px" inlineSize="100%" background="base" />
                      </s-stack>
                    </s-box>
                    <s-box inlineSize={col.created} minInlineSize={col.created}>
                      <s-stack gap="none">
                        <s-text type="strong">CREATED</s-text>
                        <s-box blockSize="1px" inlineSize="100%" background="base" />
                      </s-stack>
                    </s-box>
                  </s-stack>
                </s-box>
                <s-divider />
                <s-divider />
                {filteredOrders.map((order, index) => {
                  const completed = order.overallOrderStatus === "Picked Up - Sale Complete";
                  const canceled = order.overallOrderStatus === "Order Canceled";
                  const orderBadgeTone = completed ? "success" : canceled ? "critical" : "warning";
                  const statusItems = (order.orderStatuses || []).length > 0
                    ? order.orderStatuses
                    : [{ title: "Item", status: "Not set" }];
                  return (
                    <Fragment key={order.id}>
                      <s-clickable
                        onClick={() => {
                          setSelectedOrder(order);
                          setLocalNote(
                            order.id?.includes("DraftOrder")
                              ? order.note2 || ""
                              : order.note || ""
                          );
                        }}
                      >
                        <s-box padding="base" background="subdued" minInlineSize={minTableWidth}>
                        <s-stack direction="inline" gap="small">
                          <s-box inlineSize={col.order} minInlineSize={col.order}>
                            {completed || canceled ? (
                              <s-badge tone={orderBadgeTone}>
                                {order.name}
                              </s-badge>
                            ) : (
                              <s-text>{order.name}</s-text>
                            )}
                          </s-box>
                          <s-box inlineSize="auto" minInlineSize="0" />
                          <s-box inlineSize={col.customer} minInlineSize={col.customer}>
                            <s-text>{order.customerName}</s-text>
                          </s-box>
                          <s-box inlineSize={col.status} minInlineSize={col.status}>
                            <s-stack direction="inline" gap="small-300">
                              {statusItems.map((item, i) => {
                                const title = typeof item === "object" && item != null ? item.title : "Item";
                                const status = typeof item === "object" && item != null ? item.status : item;
                                const label = `${title} - ${String(status ?? "Not set").trim() || "Not set"}`;
                                return (
                                  <s-badge key={i} tone={getTone(status, "order")}>
                                    {label}
                                  </s-badge>
                                );
                              })}
                            </s-stack>
                          </s-box>
                          <s-box inlineSize={col.payment} minInlineSize={col.payment}>
                            <s-badge tone={getTone(order.paymentStatus, "payment")}>
                              {order.paymentStatus}
                            </s-badge>
                          </s-box>
                          <s-box inlineSize={col.contact} minInlineSize={col.contact}>
                            <s-badge tone={getTone(order.contactStatus, "contact")}>
                              {order.contactStatus || "Not Contacted"}
                            </s-badge>
                          </s-box>
                          <s-box inlineSize={col.created} minInlineSize={col.created}>
                            <s-text color="subdued">{`${order.createdDateLabel || ""}${" ".repeat(8)}↕️`}</s-text>
                          </s-box>
                        </s-stack>
                      </s-box>
                    </s-clickable>
                    {index < filteredOrders.length - 1 && (
                      <s-divider />
                    )}
                  </Fragment>
                  );
                })}
                </s-stack>
              </s-box>
            )}

            <s-text color="subdued" type="bodySmall">
              {i18n.translate("view_admin")}
            </s-text>
          </s-stack>
        </s-box>
      </s-scroll-box>
    </s-page>
  );
}
