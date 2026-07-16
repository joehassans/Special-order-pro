import { useState, useMemo } from "react";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getSpecialOrderListRows } from "../lib/special-order-list.server";

function getPaymentStatusTone(status) {
  if (!status) return "subdued";
  const s = status.toLowerCase().trim();
  if (s === "not paid" || s.includes("not paid")) return "critical";
  if (s.includes("partially refunded")) return "warning";
  if (s.includes("refunded")) return "info";
  if (s === "partially paid" || s.includes("partially paid")) return "warning";
  if (s === "paid in full" || s.includes("paid in full")) return "success";
  if (s === "paid" && !s.includes("not")) return "success";
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

function getContactStatusTone(status) {
  const s = String(status || "").toLowerCase().trim();
  if (!s || s === "not set" || s === "not contacted") return "critical";
  if (s.includes("no answer")) return "critical";
  if (s.includes("left message")) return "warning";
  if (s.includes("spoke to customer")) return "success";
  if (s.includes("notified") && s.includes("pickup")) return "success";
  return "critical";
}

/** Item-status badges shown per row before collapsing to "+N more". */
const MAX_ITEM_BADGES = 4;

// Treat "Picked Up - Sale Complete" as completed (overall order status)
function isCompletedOverallOrderStatus(status) {
  if (!status || typeof status !== "string") return false;
  const s = String(status).trim();
  return s === "Picked Up - Sale Complete";
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  // Phase 1 step 2: rows come from the app database (fast), refreshed
  // from Shopify in the background. Falls back to a live Shopify fetch
  // (which seeds the database) when the DB is still empty.
  const { rows } = await getSpecialOrderListRows(admin, session.shop);

  return { orders: rows };
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

    // Search: match customer name, order number, email, phone, or product name
    if (searchTerm && searchTerm.trim()) {
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
        if (
          order.customerEmail &&
          String(order.customerEmail).toLowerCase().includes(term)
        )
          return true;
        if (termDigits && order.customerPhone) {
          const phoneDigits = String(order.customerPhone).replace(/\D/g, "");
          if (phoneDigits.includes(termDigits))
            return true;
        }
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

  const hasActiveFilters = Boolean(searchTerm.trim() || statusFilter);

  return (
    <s-page heading="Special Orders Pro" inlineSize="large">
      {/* Filters section */}
      <s-section id="filters-section">
        <s-stack direction="inline" gap="base" alignItems="end">
          <s-search-field
            id="order-search"
            label="Search orders"
            labelAccessibilityVisibility="exclusive"
            placeholder="Search by customer, order number, email, phone, or product..."
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
            disabled={!hasActiveFilters}
            onClick={() => {
              setSearchTerm("");
              setStatusFilter("");
            }}
          >
            Clear filters
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
                      {orders.length > 0 && hasActiveFilters
                        ? "No orders match your search or filters."
                        : "No special orders yet"}
                    </s-text>
                    {orders.length > 0 && hasActiveFilters && (
                      <s-button
                        variant="secondary"
                        onClick={() => {
                          setSearchTerm("");
                          setStatusFilter("");
                        }}
                      >
                        Clear filters
                      </s-button>
                    )}
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

                return (
                  <s-table-row
                    id={`order-row-${order.id}`}
                    key={order.id}
                  >
                    <s-table-cell id={`cell-order-${order.id}`}>
                      <s-stack gap="small-300">
                        <s-text type="strong">{order.name}</s-text>
                        {completed && (
                          <s-badge tone="success">Picked Up</s-badge>
                        )}
                        {orderCanceled && (
                          <s-badge tone="critical">Canceled</s-badge>
                        )}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell id={`cell-customer-${order.id}`}>
                      <s-text>{order.customerName}</s-text>
                    </s-table-cell>
                    <s-table-cell id={`cell-status-${order.id}`}>
                      <s-stack gap="small-300">
                        {(() => {
                          const statuses =
                            (order.orderStatuses || []).length > 0
                              ? order.orderStatuses
                              : [{ title: "Item", status: "Not set" }];
                          const shown = statuses.slice(0, MAX_ITEM_BADGES);
                          const hidden = statuses.length - shown.length;
                          return (
                            <>
                              {shown.map((item, i) => {
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
                                  (String(status ?? "Not set").trim() ||
                                    "Not set");
                                return (
                                  <s-badge
                                    key={i}
                                    tone={getOrderStatusTone(status)}
                                  >
                                    {label}
                                  </s-badge>
                                );
                              })}
                              {hidden > 0 && (
                                <s-text color="subdued" type="small">
                                  +{hidden} more item{hidden === 1 ? "" : "s"} —
                                  view details
                                </s-text>
                              )}
                            </>
                          );
                        })()}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell id={`cell-payment-${order.id}`}>
                      <s-badge tone={getPaymentStatusTone(order.paymentStatus)}>
                        {order.paymentStatus}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell id={`cell-contact-${order.id}`}>
                      {/* Loader normalizes contactStatus to a valid value. */}
                      <s-badge tone={getContactStatusTone(order.contactStatus)}>
                        {order.contactStatus || "Not Contacted"}
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