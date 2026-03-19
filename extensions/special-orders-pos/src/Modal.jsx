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

const ROW_SEPARATOR = "\u2014".repeat(72);

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
    if (s.includes("no answer")) return "critical";
    if (s.includes("left message")) return "warning";
    if (s.includes("spoke") || s.includes("picked up")) return "success";
    return "critical";
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

const LIST_QUERY = `
  query GetSpecialOrders($query: String) {
    orders(first: 50, query: $query, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id name createdAt note displayFinancialStatus
          totalOutstandingSet { shopMoney { amount currencyCode } }
          customer { id displayName email }
          metafields(first: 250, namespace: "custom") {
            edges { node { key value } }
          }
          lineItems(first: 50) {
            edges {
              node {
                id title variantTitle
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
          customer { id displayName email }
          metafields(first: 250, namespace: "custom") {
            edges { node { key value } }
          }
          lineItems(first: 50) {
            edges {
              node {
                id title
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
        const orderStatuses = extractOrderStatuses(order);
        const paymentStatus = calculatePaymentStatus(order);
        const customerName = order.customer?.displayName || "No customer";
        const productTitles = (order.lineItems?.edges || []).map(
          (e) => e?.node?.title || ""
        );
        return {
          ...order,
          contactStatus,
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
          if (o.contactStatus === "Order Canceled") return 2;
          if (isCompletedContactStatus(o.contactStatus)) return 1;
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
    if (searchTerm?.trim()) {
      const term = searchTerm.trim().toLowerCase();
      result = result.filter(
        (o) =>
          o.customerName?.toLowerCase().includes(term) ||
          o.name?.toLowerCase().includes(term) ||
          o.productTitles?.some((t) => t?.toLowerCase().includes(term))
      );
    }
    if (statusFilter) {
      if (statusFilter === "Picked Up - Sale Complete") {
        result = result.filter((o) => o.contactStatus === "Picked Up - Sale Complete");
      } else if (statusFilter === "Order Canceled") {
        result = result.filter((o) => o.contactStatus === "Order Canceled");
      } else if (statusFilter === "open") {
        result = result.filter((o) => {
          if (o.contactStatus === "Picked Up - Sale Complete") return false;
          if (o.contactStatus === "Order Canceled") return false;
          return o.orderStatuses?.some((item) =>
            OPEN_STATUSES.includes(item.status)
          );
        });
      } else {
        result = result.filter((o) =>
          o.orderStatuses?.some((item) => {
            const status = typeof item === "object" ? item.status : item;
            return status && status.toLowerCase() === statusFilter.toLowerCase();
          })
        );
      }
    }
    return result;
  }, [normalizedOrders, searchTerm, statusFilter]);

  useEffect(() => {
    async function fetchOrders() {
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
    }
    fetchOrders();
  }, []);

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
      return {
        id: li.id,
        title: li.title,
        variantTitle: li.variant?.title ?? li.variantTitle,
        quantity: li.quantity,
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

              {/* Customer */}
              <s-box padding="base" borderRadius="base" background="subdued">
                <s-stack gap="small">
                  <s-text type="strong">{i18n.translate("customer")}</s-text>
                  <s-text>
                    {order.customer?.displayName || "No customer"}
                  </s-text>
                  {order.customer?.email && (
                    <s-text color="subdued">{order.customer.email}</s-text>
                  )}
                </s-stack>
              </s-box>

              {/* Contact Status */}
              <s-box padding="base" borderRadius="base" background="subdued">
                <s-stack gap="small">
                  <s-text type="strong">{i18n.translate("contact_status")}</s-text>
                  <s-button
                    variant="secondary"
                    commandFor="contact-status-modal"
                    command="--show"
                    disabled={!!saving}
                  >
                    {contactStatus}
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
                    {contactStatus}
                  </s-badge>
                </s-stack>
              </s-box>

              {/* Payment Status */}
              <s-box padding="base" borderRadius="base" background="subdued">
                <s-stack gap="small">
                  <s-text type="strong">{i18n.translate("payment_status")}</s-text>
                  <s-badge tone={getTone(paymentStatus, "payment")}>
                    {paymentStatus}
                  </s-badge>
                </s-stack>
              </s-box>

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

              {/* Line Items */}
              <s-text type="strong">{i18n.translate("line_items")}</s-text>
              {lineItems.map((item, idx) => (
                <s-box
                  key={item.id}
                  padding="base"
                  borderRadius="base"
                  borderWidth="base"
                  background="subdued"
                >
                  <s-stack gap="small">
                    <s-text type="strong">{item.title}</s-text>
                    {item.variantTitle && (
                      <s-text color="subdued">{item.variantTitle}</s-text>
                    )}
                    <s-stack gap="small">
                      <s-text type="bodySmall">{i18n.translate("order_status")}</s-text>
                      <s-select
                        value={item.orderStatus}
                        onChange={(e) =>
                          handleUpdateOrderStatus(
                            order.id,
                            item.id,
                            e.currentTarget.value
                          )
                        }
                        disabled={!!saving}
                      >
                        {ORDER_STATUS_OPTIONS.map((opt) => (
                          <s-option key={opt} value={opt}>
                            {opt}
                          </s-option>
                        ))}
                      </s-select>
                      <s-badge tone={getTone(item.orderStatus, "order")}>
                        {item.orderStatus}
                      </s-badge>
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
                  </s-stack>
                </s-box>
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
                <s-text type="strong">{i18n.translate("filters_heading")}</s-text>
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
              </s-stack>
            </s-box>

            {loading ? (
              <s-text>{i18n.translate("loading")}</s-text>
            ) : filteredOrders.length === 0 ? (
              <s-text color="subdued">{i18n.translate("empty")}</s-text>
            ) : (
              <s-box minInlineSize={minTableWidth}>
                <s-stack gap="small-100">
                  {/* Table header */}
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
                {/* Table rows */}
                {filteredOrders.map((order, index) => {
                  const completed = isCompletedContactStatus(order.contactStatus);
                  const canceled = order.contactStatus === "Order Canceled";
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
                            <s-badge tone={completed ? "success" : canceled ? "critical" : "neutral"}>
                              {order.name}
                            </s-badge>
                          </s-box>
                          <s-box inlineSize={col.customer} minInlineSize={col.customer}>
                            <s-text>{order.customerName}</s-text>
                          </s-box>
                          <s-box inlineSize={col.status} minInlineSize={col.status}>
                            <s-stack direction="inline" gap="small-300">
                              {statusItems.slice(0, isTablet ? 5 : 2).map((item, i) => {
                                const title = typeof item === "object" && item != null ? item.title : "Item";
                                const status = typeof item === "object" && item != null ? item.status : item;
                                const label = `${title} - ${String(status ?? "Not set").trim() || "Not set"}`;
                                return (
                                  <s-badge key={i} tone={getTone(status, "order")}>
                                    {label}
                                  </s-badge>
                                );
                              })}
                              {statusItems.length > (isTablet ? 5 : 2) && (
                                <s-badge tone="info">+{statusItems.length - (isTablet ? 5 : 2)}</s-badge>
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
                      <s-box minInlineSize={minTableWidth} paddingBlock="small-100 none">
                        <s-text color="subdued" type="small">{ROW_SEPARATOR}</s-text>
                      </s-box>
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
