import "@shopify/ui-extensions/preact";
import { render, Fragment } from "preact";
import { useState, useEffect, useMemo, useCallback } from "preact/hooks";

export default async () => {
  render(<Extension />, document.body);
};

const SPECIAL_ORDER_TAG = "special-order";
const OPEN_STATUSES = ["Not Ordered", "Ordered", "Back Ordered", "Received"];
const ALWAYS_PRESENT_ATTRIBUTES = ["Brand", "Type", "Style #", "Size", "Color"];
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
  "Received",
  "Canceled",
  "Order Canceled",
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
  contact: "230px",
  created: "70px",
};
const MIN_TABLE_MOBILE = "755px";
const MIN_TABLE_IPAD = "955px";

// Same names as admin; Picked Up and Order Canceled at bottom
const FILTER_OPTIONS = [
  { value: "", labelKey: "all_statuses" },
  { value: "open", labelKey: "filter_open" },
  { value: "Not Ordered", label: "Not Ordered" },
  { value: "Ordered", label: "Ordered" },
  { value: "Back Ordered", label: "Back Ordered" },
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

function graphql(query, variables = {}) {
  return fetch("shopify:admin/api/graphql.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  }).then((r) => r.json());
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

function calculatePaymentStatus(order) {
  if (order.id?.includes("DraftOrder")) return "Not Paid";
  if (order.displayFinancialStatus === "PAID") return "Paid in Full";
  if (order.displayFinancialStatus === "PARTIALLY_PAID") return "Partially Paid";
  if (
    ["PENDING", "AUTHORIZED", "VOIDED"].includes(order.displayFinancialStatus)
  )
    return "Not Paid";
  const out = order.totalOutstandingSet?.shopMoney?.amount;
  if (out != null) {
    const n = parseFloat(out);
    if (n === 0) return "Paid in Full";
    if (n > 0) return "Partially Paid";
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
    result.push({ key, value: map.get(key) || "" });
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
    if (s.includes("partially")) return "warning";
    if (s.includes("paid")) return "success";
    return "subdued";
  }
  if (type === "order") {
    if (s.includes("not ordered") || s.includes("canceled")) return "critical";
    if (s.includes("back ordered")) return "info";
    if (s.includes("ordered") || s.includes("received") || s.includes("picked up"))
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
          totalOutstandingSet { shopMoney { amount currencyCode } }
          customer { id displayName email phone }
          metafields(first: 250, namespace: "custom") {
            edges { node { key value } }
          }
          lineItems(first: 50) {
            edges {
              node {
                id title variantTitle
                quantity
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
          customer { id displayName email phone }
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

function Extension() {
  const { i18n } = shopify;
  const [rawOrders, setRawOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [localNote, setLocalNote] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [saving, setSaving] = useState(null);
  const [isTablet, setIsTablet] = useState(null);

  useEffect(() => {
    shopify.device?.isTablet?.().then(setIsTablet).catch(() => setIsTablet(false));
  }, []);

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

    // Search: match customer name, order number, or product name (same as admin)
    if (searchTerm?.trim()) {
      const term = searchTerm.trim().toLowerCase();
      result = result.filter((order) => {
        if (
          order.customerName &&
          String(order.customerName).toLowerCase().includes(term)
        )
          return true;
        if (order.name && String(order.name).toLowerCase().includes(term))
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
                value: JSON.stringify(attributes),
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
                  { node: { key, value: JSON.stringify(attributes) } },
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

  if (selectedOrder) {
    const order = rawOrders.find((o) => o.id === selectedOrder.id) || selectedOrder;
    const noteValue =
      localNote !== ""
        ? localNote
        : order.id?.includes("DraftOrder")
          ? order.note2
          : order.note;
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
    const lineItems = (order.lineItems?.edges || []).map((edge, idx) => {
      const li = edge.node;
      const overrides = attrsByIndex[idx];
      const attrs = getAttributesForDisplay(li.customAttributes, overrides);
      const orderStatus = extractItemStatus(
        metafields,
        idx,
        overrides || li.customAttributes
      );
      const priceSet = li.originalUnitPriceSet?.shopMoney;
      const priceLabel = priceSet
        ? `${priceSet.currencyCode} ${parseFloat(priceSet.amount).toFixed(2)}`
        : null;
      return {
        id: li.id,
        title: li.title,
        variantTitle: li.variant?.title ?? li.variantTitle,
        quantity: li.quantity,
        priceLabel,
        customAttributes: attrs,
        orderStatus: orderStatus || "Not Ordered",
        rawAttributes: overrides || li.customAttributes || [],
      };
    });

    return (
      <s-page heading={order.name} inlineSize={isTablet ? "large" : "base"}>
        <s-scroll-box>
          <s-box padding="base">
            <s-stack gap="base">
              <s-button
                variant="secondary"
                onClick={() => {
                  setSelectedOrder(null);
                  setLocalNote("");
                }}
              >
                ← {i18n.translate("back")}
              </s-button>

              {/* Customer, Contact Status, Overall Order Status, Payment Status */}
              <s-stack gap="10px" blockSize="auto">
              {!isTablet ? (
                /* iPhone: Customer info and status cards stacked with dividers */
                <s-stack gap="10px" blockSize="auto">
                  <s-box padding="base" inlineSize="100%" background="subdued" border="base" borderRadius="base">
                    <s-stack gap="small">
                      <s-text type="strong">{i18n.translate("customer_information")}</s-text>
                      <s-heading>{order.customer?.displayName || "No customer"}</s-heading>
                      {order.customer?.email && (
                        <s-text color="subdued" type="small">{order.customer.email}</s-text>
                      )}
                      {order.customer?.phone && (
                        <s-text color="subdued" type="small">{order.customer.phone}</s-text>
                      )}
                    </s-stack>
                  </s-box>
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
                /* iPad: side by side layout - dividers between cards */
              <s-stack direction="inline" gap="50px" blockSize="auto">
                <s-box padding="base" inlineSize="300px" background="subdued" border="base" borderRadius="base">
                  <s-stack gap="small">
                    <s-text type="strong">{i18n.translate("customer_information")}</s-text>
                    <s-heading>{order.customer?.displayName || "No customer"}</s-heading>
                    {order.customer?.email && (
                      <s-text color="subdued" type="small">{order.customer.email}</s-text>
                    )}
                    {order.customer?.phone && (
                      <s-text type="strong">{formatUsPhone(order.customer.phone)}</s-text>
                    )}
                  </s-stack>
                </s-box>
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
                    <s-badge tone={getTone(contactStatus, "contact")}>
                      {CONTACT_STATUS_OPTIONS.includes(contactStatus) ? contactStatus : ""}
                    </s-badge>
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
                    <s-badge tone={getTone(overallOrderStatus, "overall")}>
                      {OVERALL_ORDER_STATUS_OPTIONS.includes(overallOrderStatus) ? overallOrderStatus : "Order Pending"}
                    </s-badge>
                  </s-stack>
                </s-box>
                <s-divider />
                <s-box padding="base" inlineSize="220px" background="subdued" border="base" borderRadius="base">
                  <s-stack gap="small">
                    <s-text type="strong">{i18n.translate("payment_status")}</s-text>
                    <s-badge tone={getTone(paymentStatus, "payment")}>
                      {paymentStatus}
                    </s-badge>
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
              </s-stack>
              )}
              </s-stack>

              <s-divider />

              {/* Note */}
              <s-box padding="base" borderRadius="base" background="subdued">
                <s-stack gap="small">
                  <s-text type="strong">{i18n.translate("note")}</s-text>
                  <s-text-field
                    value={noteValue || ""}
                    onInput={(e) => setLocalNote(e.currentTarget.value)}
                    onBlur={(e) =>
                      handleUpdateNote(order.id, e.currentTarget.value)
                    }
                    disabled={!!saving}
                  />
                </s-stack>
              </s-box>

              <s-divider />

              {/* Line Items */}
              <s-text type="strong">{i18n.translate("line_items")}</s-text>
              {lineItems.map((item, idx) => (
                <Fragment key={item.id}>
                  <s-divider />
                  <s-box
                    padding="base"
                    borderRadius="base"
                    borderWidth="base"
                    background="subdued"
                  >
                    <s-stack gap="small">
                      <s-heading>{item.title}</s-heading>
                      {item.variantTitle && (
                        <s-text color="subdued">{item.variantTitle}</s-text>
                      )}
                      <s-stack gap="small">
                        <s-text type="bodySmall">{i18n.translate("item_order_status")}</s-text>
                        <s-box inlineSize="100%">
                          <s-stack gap="small">
                            <s-button
                              variant="secondary"
                              tone={getOrderButtonTone(item.orderStatus)}
                              commandFor={`order-status-modal-${item.id}`}
                              command="--show"
                              disabled={!!saving}
                            >
                              {ORDER_STATUS_OPTIONS.includes(item.orderStatus) ? item.orderStatus : "Not Ordered"}
                            </s-button>
                            <s-modal id={`order-status-modal-${item.id}`} heading={i18n.translate("item_order_status")}>
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
                            <s-banner
                              tone={getTone(item.orderStatus, "order") === "subdued" ? "auto" : getTone(item.orderStatus, "order")}
                              heading={ORDER_STATUS_OPTIONS.includes(item.orderStatus) ? item.orderStatus : "Not Ordered"}
                            />
                          </s-stack>
                        </s-box>
                      </s-stack>
                      {item.customAttributes.map((attr) => (
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
                      {!isTablet && item.priceLabel && (
                        <s-text type="strong">{item.priceLabel}</s-text>
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
                  <s-text type="strong">{i18n.translate("filters_heading")}</s-text>
                )}
                <s-text-field
                  label={i18n.translate("search")}
                  value={searchTerm}
                  onInput={(e) => setSearchTerm(e.currentTarget.value)}
                  placeholder={i18n.translate("search_placeholder")}
                />
                <s-text type="strong">{i18n.translate("filter")}</s-text>
                <s-button
                  variant="secondary"
                  commandFor="filter-modal"
                  command="--show"
                >
                  {getFilterLabel(statusFilter, i18n)}
                </s-button>
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
                {statusFilter && (
                  <s-button
                    variant="secondary"
                    onClick={() => setStatusFilter("")}
                  >
                    {i18n.translate("clear_filters")}
                  </s-button>
                )}
                {!isTablet && (
                  <s-button variant="secondary" onClick={fetchOrders} disabled={loading}>
                    {i18n.translate("refresh")}
                  </s-button>
                )}
              </s-stack>
            </s-box>

            {loading ? (
              <s-text>{i18n.translate("loading")}</s-text>
            ) : filteredOrders.length === 0 ? (
              <s-text color="subdued">{i18n.translate("empty")}</s-text>
            ) : !isTablet ? (
              /* iPhone: stacked card layout */
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
                          <s-banner tone={orderBadgeTone} heading={order.name} />
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
                  <s-box padding="base" background="subdued" borderWidth="base" minInlineSize={minTableWidth}>
                    <s-stack direction="inline" gap="small">
                    <s-box inlineSize={col.order} minInlineSize={col.order}>
                      <s-text type="strong">{i18n.translate("column_order")}</s-text>
                    </s-box>
                    <s-box inlineSize={col.customer} minInlineSize={col.customer}>
                      <s-text type="strong">{i18n.translate("column_customer")}</s-text>
                    </s-box>
                    <s-box inlineSize={col.status} minInlineSize={col.status}>
                      <s-text type="strong">{i18n.translate("column_order_status")}</s-text>
                    </s-box>
                    <s-box inlineSize={col.payment} minInlineSize={col.payment}>
                      <s-text type="strong">{i18n.translate("column_payment")}</s-text>
                    </s-box>
                    <s-box inlineSize={col.contact} minInlineSize={col.contact}>
                      <s-text type="strong">{i18n.translate("column_contact")}</s-text>
                    </s-box>
                    <s-box inlineSize="auto" minInlineSize="0" />
                    <s-box inlineSize={col.created} minInlineSize={col.created}>
                      <s-text type="small">{i18n.translate("column_created")}</s-text>
                    </s-box>
                  </s-stack>
                </s-box>
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
                            <s-badge tone={orderBadgeTone}>
                              {order.name}
                            </s-badge>
                          </s-box>
                          <s-box inlineSize={col.customer} minInlineSize={col.customer}>
                            <s-text>{order.customerName}</s-text>
                          </s-box>
                          <s-box inlineSize={col.status} minInlineSize={col.status}>
                            <s-stack direction="inline" gap="small-300">
                              {statusItems.slice(0, 5).map((item, i) => {
                                const title = typeof item === "object" && item != null ? item.title : "Item";
                                const status = typeof item === "object" && item != null ? item.status : item;
                                const label = `${title} - ${String(status ?? "Not set").trim() || "Not set"}`;
                                return (
                                  <s-badge key={i} tone={getTone(status, "order")}>
                                    {label}
                                  </s-badge>
                                );
                              })}
                              {statusItems.length > 5 && (
                                <s-badge tone="info">+{statusItems.length - 5}</s-badge>
                              )}
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
                          <s-box inlineSize="auto" minInlineSize="0" />
                          <s-box inlineSize={col.created} minInlineSize={col.created}>
                            <s-text color="subdued">{order.createdDateLabel || ""}</s-text>
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
