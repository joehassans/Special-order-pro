import { useState, useMemo } from "react";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

const SPECIAL_ORDER_TAG = "special-order";

function calculatePaymentStatus(order) {
  // Draft orders are always "Not Paid" in your original logic
  const isDraftOrder = order.id.includes("DraftOrder");

  if (isDraftOrder) {
    return "Not Paid";
  }

  if (order.displayFinancialStatus) {
    const status = order.displayFinancialStatus;
    if (status === "PAID") {
      return "Paid in Full";
    } else if (status === "PARTIALLY_PAID") {
      return "Partially Paid";
    } else if (
      status === "PENDING" ||
      status === "AUTHORIZED" ||
      status === "VOIDED"
    ) {
      return "Not Paid";
    }
  }

  if (order.totalOutstandingSet && order.totalOutstandingSet.shopMoney) {
    const outstanding = parseFloat(order.totalOutstandingSet.shopMoney.amount);
    if (outstanding === 0) {
      return "Paid in Full";
    } else if (outstanding > 0) {
      return "Partially Paid";
    }
  }

  return "Not Paid";
}

function getPaymentStatusTone(status) {
  if (!status) return "subdued";
  const s = status.toLowerCase().trim();
  if (s === "not paid" || s.includes("not paid")) return "critical"; // red
  if (s === "partially paid" || s.includes("partially paid"))
    return "warning"; // orange
  if (s === "paid in full" || s === "paid" || s.includes("paid in full"))
    return "success"; // green
  return "subdued";
}
function getOrderStatusTone(status) {
  if (!status) return "subdued";
  const s = String(status).toLowerCase().trim();
  if (!s || s === "not set") return "subdued";
  if (s.includes("not ordered") || s.includes("canceled")) return "critical";
  if (s.includes("back ordered")) return "info";
  if (s.includes("ordered") || s.includes("received") || s.includes("delivered")) return "success";
  if (s.includes("picked up")) return "success";
  return "subdued";
}

function toTitleCase(str) {
  if (!str || typeof str !== "string") return "";
  return str
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Returns an array of { title, status } per line item, in order (first item first). */
function extractOrderStatuses(order) {
  const metafields = order.metafields || { edges: [] };
  const edges = metafields.edges || [];
  const metafieldsByKey = Object.fromEntries(
    edges
      .filter((e) => e?.node?.key != null)
      .map((e) => [e.node.key, e.node.value])
  );
  const lineItems = order.lineItems?.edges || [];

  if (lineItems.length === 0) {
    // Fallback: gather all product_N_order_status metafields, sorted by N
    const productStatusMfs = edges
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
    if (productStatusMfs.length > 0) return productStatusMfs;
    const anyStatus = edges.find(
      (e) => e?.node?.key?.includes?.("order_status") && e?.node?.value
    );
    return [
      { title: "Item", status: anyStatus?.node?.value || "Not set" },
    ];
  }

  const items = lineItems.map((edge, index) => {
    const title = edge?.node?.title || `Item ${index + 1}`;
    const mfKey = `product_${index + 1}_order_status`;
    const mfKeyAlt = `custom.${mfKey}`;
    const mfValue =
      metafieldsByKey[mfKey] ?? metafieldsByKey[mfKeyAlt];
    if (mfValue) return { title, status: mfValue };

    const attrs = edge?.node?.customAttributes || [];
    const orderStatusAttr = attrs.find((a) => a.key === "Order Status" && a.value);
    if (orderStatusAttr) return { title, status: orderStatusAttr.value };
    const initialStatusAttr = attrs.find((a) => a.key === "Initial Status" && a.value);
    if (initialStatusAttr) return { title, status: initialStatusAttr.value };

    return { title, status: "Not set" };
  });

  return items.length > 0 ? items : [{ title: "Item", status: "Not set" }];
}

const VALID_CONTACT_STATUSES = [
  "Not Contacted",
  "No Answer",
  "Left Message",
  "Spoke to Customer",
];

function extractContactStatusFromMetafields(metafields) {
  if (!metafields || !metafields.edges) return "Not Contacted";

  const contactMf = metafields.edges.find(
    (edge) => edge.node.key === "contact_status"
  );
  if (contactMf && contactMf.node.value) {
    const value = contactMf.node.value.trim();
    // Only return if it's a valid contact status (exclude Overall Order Status values)
    if (VALID_CONTACT_STATUSES.includes(value)) {
      return value;
    }
  }

  return "Not Contacted";
}

function extractOverallOrderStatusFromMetafields(metafields) {
  if (!metafields || !metafields.edges) return "Order Pending";

  const mf = metafields.edges.find(
    (edge) => edge.node.key === "overall_order_status"
  );
  if (mf && mf.node.value) {
    return mf.node.value;
  }

  return "Order Pending";
}

function getContactStatusTone(status) {
  const s = String(status || "").toLowerCase().trim();
  if (!s || s === "not set" || s === "not contacted") return "critical";
  if (s.includes("no answer")) return "critical";
  if (s.includes("left message")) return "warning";
  if (s.includes("spoke to customer")) return "success";
  return "critical";
}

// Treat "Picked Up - Sale Complete" as completed (overall order status)
function isCompletedOverallOrderStatus(status) {
  if (!status || typeof status !== "string") return false;
  const s = String(status).trim();
  return s === "Picked Up - Sale Complete";
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  // For now, use a fixed query filter for special orders only.
  const queryFilter = `tag:${SPECIAL_ORDER_TAG}`;

  const response = await admin.graphql(
    `#graphql
    query GetSpecialOrdersAndDrafts($query: String) {
      orders(first: 50, query: $query, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            createdAt
            note
            displayFinancialStatus
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
                  variantTitle
                  customAttributes {
                    key
                    value
                  }
                }
              }
            }
          }
        }
      }
      draftOrders(first: 50, query: $query, sortKey: ID, reverse: true) {
        edges {
          node {
            id
            name
            status
            createdAt
            note2
            customer {
              id
              displayName
              email
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
                  variant {
                    title
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
      }
    }
    `,
    {
      variables: {
        query: queryFilter,
      },
    }
  );

  const json = await response.json();

  const fetchedOrders =
    json.data?.orders?.edges?.map((edge) => edge.node) ?? [];
  let fetchedDraftOrders =
    json.data?.draftOrders?.edges?.map((edge) => edge.node) ?? [];

  // Hide draft orders that have been converted to real orders (e.g. paid → Order #1003).
  // When a draft is paid/completed, Shopify sets its status to COMPLETED; the resulting
  // order appears in the orders list, so we only show open draft orders here.
  const DRAFT_STATUS_COMPLETED = "COMPLETED";
  fetchedDraftOrders = fetchedDraftOrders.filter(
    (draft) => draft.status !== DRAFT_STATUS_COMPLETED
  );

  // Normalize both into a common shape for the table
  const normalizedOrders = [...fetchedOrders, ...fetchedDraftOrders]
    .map((order) => {
      const metafields = order.metafields || { edges: [] };
      let orderStatuses = extractOrderStatuses(order);
      if (!Array.isArray(orderStatuses) || orderStatuses.length === 0) {
        orderStatuses = [{ title: "Item", status: "Not set" }];
      }
      const contactStatus = extractContactStatusFromMetafields(metafields);
      const overallOrderStatus = extractOverallOrderStatusFromMetafields(metafields);
      const paymentStatus = calculatePaymentStatus(order);

      return {
        id: order.id,
        name: order.name,
        customerName: order.customer?.displayName || "No customer",
        orderStatuses,
        paymentStatus,
        contactStatus,
        overallOrderStatus,
        createdAt: order.createdAt,
        createdDateLabel: new Date(order.createdAt).toLocaleDateString(),
      };
    })
    // Open orders first; Picked Up - Sale Complete second; Order Canceled last. Within each group, newest first.
    .sort((a, b) => {
      const getTier = (order) => {
        if (order.overallOrderStatus === "Order Canceled") return 2;
        if (isCompletedOverallOrderStatus(order.overallOrderStatus)) return 1;
        return 0;
      };
      const aTier = getTier(a);
      const bTier = getTier(b);
      if (aTier !== bTier) return aTier - bTier;
      return (
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
    });

  return { orders: normalizedOrders };
};

/**
 * We’re keeping the original demo `action` here for now so the route
 * structure stays intact. It isn’t used by the current UI.
 */
export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const color = ["Red", "Orange", "Yellow", "Green"][
    Math.floor(Math.random() * 4)
  ];
  const response = await admin.graphql(
    `#graphql
      mutation populateProduct($product: ProductCreateInput!) {
        productCreate(product: $product) {
          product {
            id
            title
            handle
            status
            variants(first: 10) {
              edges {
                node {
                  id
                  price
                  barcode
                  createdAt
                }
              }
            }
            demoInfo: metafield(namespace: "$app", key: "demo_info") {
              jsonValue
            }
          }
        }
      }`,
    {
      variables: {
        product: {
          title: `${color} Snowboard`,
          metafields: [
            {
              namespace: "$app",
              key: "demo_info",
              value: "Created by React Router Template",
            },
          ],
        },
      },
    }
  );
  const responseJson = await response.json();
  const product = responseJson.data.productCreate.product;
  const variantId = product.variants.edges[0].node.id;
  const variantResponse = await admin.graphql(
    `#graphql
    mutation shopifyReactRouterTemplateUpdateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
          price
          barcode
          createdAt
        }
      }
    }`,
    {
      variables: {
        productId: product.id,
        variants: [{ id: variantId, price: "100.00" }],
      },
    }
  );
  const variantResponseJson = await variantResponse.json();
  const metaobjectResponse = await admin.graphql(
    `#graphql
    mutation shopifyReactRouterTemplateUpsertMetaobject($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
      metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
        metaobject {
          id
          handle
          title: field(key: "title") {
            jsonValue
          }
          description: field(key: "description") {
            jsonValue
          }
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        handle: {
          type: "$app:example",
          handle: "demo-entry",
        },
        metaobject: {
          fields: [
            { key: "title", value: "Demo Entry" },
            {
              key: "description",
              value:
                "This metaobject was created by the Shopify app template to demonstrate the metaobject API.",
            },
          ],
        },
      },
    }
  );
  const metaobjectResponseJson = await metaobjectResponse.json();

  return {
    product: responseJson.data.productCreate.product,
    variant: variantResponseJson.data.productVariantsBulkUpdate.productVariants,
    metaobject: metaobjectResponseJson.data.metaobjectUpsert.metaobject,
  };
};

export default function Index() {
  // Local UI state for your filters
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  // Read normalized orders from the loader
  const { orders } = useLoaderData();

  // Apply search and status filters client-side
  const filteredOrders = useMemo(() => {
    let result = orders;

    // Search: match customer name, order number, or product name
    if (searchTerm && searchTerm.trim()) {
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

    // Status filter: overall order status (Picked Up, Order Canceled) or line item order status
    const OPEN_STATUSES = ["Not Ordered", "Ordered", "Back Ordered", "Drop Ship - Ordered", "Drop Ship - Delivered", "Received"];
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
        // Only orders with at least one item in Not Ordered, Ordered, Back Ordered, or Received
        // Excludes: overall order status Picked Up - Sale Complete, Order Canceled
        // Orders with a canceled item are included if another item has an open status
        result = result.filter((order) => {
          if (order.overallOrderStatus === "Picked Up - Sale Complete") return false;
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
  }, [orders, searchTerm, statusFilter]);

  return (
    <s-page heading="Special Orders Pro" inlineSize="large">
      <style>{`
        s-table-cell.order-cell-completed {
          background-color: #66bb6a !important;
        }
        s-table-cell.order-cell-canceled {
          background-color: #e53935 !important;
        }
        s-table-cell.order-cell-pending {
          background-color: #ff9800 !important;
        }
      `}</style>
      {/* Filters section */}
      <s-section id="filters-section">
        <s-stack direction="inline" gap="base" alignItems="end">
          <s-search-field
            id="order-search"
            label="Search orders"
            labelAccessibilityVisibility="exclusive"
            placeholder="Search by customer, order number, or product..."
            value={searchTerm}
            onInput={(event) => setSearchTerm(event.currentTarget.value)}
          />
          <s-select
            id="status-filter"
            label="Filter by Status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.currentTarget.value)}
          >
            <s-option value="">All Statuses</s-option>
            <s-option value="open">
              Not Ordered, Ordered, Back Ordered &amp; Received
            </s-option>
            <s-option value="Not Ordered">Not Ordered</s-option>
            <s-option value="Ordered">Ordered</s-option>
            <s-option value="Back Ordered">Back Ordered</s-option>
            <s-option value="Drop Ship - Ordered">Drop Ship - Ordered</s-option>
            <s-option value="Drop Ship - Delivered">Drop Ship - Delivered</s-option>
            <s-option value="Received">Received</s-option>
            <s-option value="Picked Up - Sale Complete">
              Picked Up - Sale Complete
            </s-option>
            <s-option value="Order Canceled">Order Canceled</s-option>
          </s-select>
          <s-button
            id="clear-filters-button"
            onClick={() => {
              setSearchTerm("");
              setStatusFilter("");
              // Later: trigger a reload with new query params for search
            }}
          >
            Refresh
          </s-button>
        </s-stack>
      </s-section>

      {/* Orders table section */}
      <s-section id="orders-table-section" padding="none">
        <s-table id="orders-table">
          <s-table-header-row id="table-header">
            <s-table-header id="header-order" listSlot="primary">
              Order
            </s-table-header>
            <s-table-header id="header-customer" listSlot="labeled">
              Customer
            </s-table-header>
            <s-table-header id="header-status" listSlot="labeled">
              Item Order Status
            </s-table-header>
            <s-table-header id="header-payment" listSlot="labeled">
              Payment Status
            </s-table-header>
            <s-table-header id="header-contact" listSlot="labeled">
              Contact Status
            </s-table-header>
            <s-table-header id="header-actions" listSlot="labeled">
              Actions
            </s-table-header>
            <s-table-header id="header-date" listSlot="labeled">
              Created
            </s-table-header>
          </s-table-header-row>

          <s-table-body id="table-body">
            {filteredOrders.length === 0 ? (
              <s-table-row id="empty-row">
                <s-table-cell id="empty-cell">
                  <s-stack
                    id="empty-stack"
                    gap="base"
                    alignItems="center"
                    padding="large"
                  >
                    <s-text id="empty-text" color="subdued">
                      No special orders yet
                    </s-text>
                  </s-stack>
                </s-table-cell>
              </s-table-row>
            ) : (
              filteredOrders.map((order) => {
                const completed = isCompletedOverallOrderStatus(
                  order.overallOrderStatus
                );
                const orderCanceled =
                  order.overallOrderStatus === "Order Canceled";
                const orderPending =
                  order.overallOrderStatus === "Order Pending" ||
                  !order.overallOrderStatus;

                const orderCellClass =
                  completed
                    ? "order-cell-completed"
                    : orderCanceled
                      ? "order-cell-canceled"
                      : orderPending
                        ? "order-cell-pending"
                        : "";

                const orderSpanBg =
                  completed
                    ? "#66bb6a"
                    : orderCanceled
                      ? "#e53935"
                      : orderPending
                        ? "#ff9800"
                        : undefined;

                return (
                  <s-table-row
                    id={`order-row-${order.id}`}
                    key={order.id}
                  >
                    <s-table-cell
                      id={`cell-order-${order.id}`}
                      className={orderCellClass}
                    >
                      <span
                        style={
                          orderSpanBg
                            ? {
                                backgroundColor: orderSpanBg,
                                padding: "6px 10px",
                                borderRadius: "4px",
                                display: "inline-block",
                              }
                            : undefined
                        }
                      >
                        <s-text type="strong">{order.name}</s-text>
                      </span>
                    </s-table-cell>
                    <s-table-cell id={`cell-customer-${order.id}`}>
                      <s-text>{order.customerName}</s-text>
                    </s-table-cell>
                    <s-table-cell id={`cell-status-${order.id}`}>
                      <s-stack gap="small-300">
                        {((order.orderStatuses || []).length > 0
                          ? order.orderStatuses
                          : [{ title: "Item", status: "Not set" }]
                        ).map((item, i) => {
                          const title =
                            typeof item === "object" && item != null
                              ? item.title
                              : "Item";
                          const status =
                            typeof item === "object" && item != null
                              ? item.status
                              : item;
                          const label =
                            toTitleCase(title || "Item") +
                            " - " +
                            (String(status ?? "Not set").trim() || "Not set");
                          return (
                            <s-badge
                              key={i}
                              tone={getOrderStatusTone(status)}
                            >
                              {label}
                            </s-badge>
                          );
                        })}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell id={`cell-payment-${order.id}`}>
                      <s-badge tone={getPaymentStatusTone(order.paymentStatus)}>
                        {order.paymentStatus}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell id={`cell-contact-${order.id}`}>
                      <s-badge tone={getContactStatusTone(order.contactStatus)}>
                        {VALID_CONTACT_STATUSES.includes(order.contactStatus)
                          ? order.contactStatus
                          : "Not Contacted"}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell id={`cell-actions-${order.id}`}>
                      <s-button
                        id={`view-button-${order.id}`}
                        variant="secondary"
                        href={`/app/order/${encodeURIComponent(order.id)}`}
                      >
                        View Details
                      </s-button>
                    </s-table-cell>
                    <s-table-cell id={`cell-date-${order.id}`}>
                      <s-text color="subdued">
                        {order.createdDateLabel}
                      </s-text>
                    </s-table-cell>
                  </s-table-row>
                );
              })
            )}
          </s-table-body>
        </s-table>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};