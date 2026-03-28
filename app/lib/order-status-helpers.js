/**
 * Shared with POS (`extensions/special-orders-pos/src/Modal.jsx`): same overall-status
 * options and the same payment-status derivation from Shopify order fields.
 */

export const OVERALL_ORDER_STATUS_OPTIONS = [
  "Order Pending",
  "Picked Up - Sale Complete",
  "Order Canceled",
];

/** Invalid or legacy metafield values display as Order Pending (same as POS banners). */
export function normalizeOverallOrderStatus(raw) {
  const v = String(raw ?? "").trim();
  return OVERALL_ORDER_STATUS_OPTIONS.includes(v) ? v : "Order Pending";
}

function financialStatusKey(order) {
  const raw = order?.displayFinancialStatus;
  return raw ? String(raw).toUpperCase().trim() : "";
}

/**
 * Infer refund labels when `displayFinancialStatus` is missing or unclear but
 * `totalRefundedSet` / `totalPriceSet` are present (Admin API order object).
 */
function inferRefundStatusFromTotals(order) {
  const refunded = parseFloat(order.totalRefundedSet?.shopMoney?.amount ?? "");
  if (!Number.isFinite(refunded) || refunded <= 0) return null;
  const total = parseFloat(order.totalPriceSet?.shopMoney?.amount ?? "");
  if (!Number.isFinite(total) || total <= 0) {
    return "Partially Refunded";
  }
  if (refunded >= total - 0.005) return "Refunded";
  return "Partially Refunded";
}

/**
 * Uses `displayFinancialStatus` (OrderDisplayFinancialStatus) and totals, matching
 * Shopify Admin: REFUNDED / PARTIALLY_REFUNDED, PAID / PARTIALLY_PAID, etc.
 */
export function calculatePaymentStatus(order) {
  if (!order || String(order.id || "").includes("DraftOrder")) {
    return "Not Paid";
  }

  const dfs = financialStatusKey(order);

  if (dfs === "REFUNDED") return "Refunded";
  if (dfs === "PARTIALLY_REFUNDED") return "Partially Refunded";

  if (dfs === "PAID") return "Paid in Full";
  if (dfs === "PARTIALLY_PAID") return "Partially Paid";
  if (
    ["PENDING", "AUTHORIZED", "VOIDED", "EXPIRED"].includes(dfs)
  ) {
    return "Not Paid";
  }

  const out = order.totalOutstandingSet?.shopMoney?.amount;
  if (out != null) {
    const n = parseFloat(out);
    if (n === 0) return "Paid in Full";
    if (n > 0) return "Partially Paid";
  }

  const inferred = inferRefundStatusFromTotals(order);
  if (inferred) return inferred;

  return "Not Paid";
}
