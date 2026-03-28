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

/**
 * Same logic as POS `calculatePaymentStatus(order)` — uses `displayFinancialStatus`
 * and `totalOutstandingSet` like Shopify shows on the order.
 */
export function calculatePaymentStatus(order) {
  if (!order || String(order.id || "").includes("DraftOrder")) {
    return "Not Paid";
  }
  if (order.displayFinancialStatus === "PAID") return "Paid in Full";
  if (order.displayFinancialStatus === "PARTIALLY_PAID") return "Partially Paid";
  if (
    ["PENDING", "AUTHORIZED", "VOIDED"].includes(order.displayFinancialStatus)
  ) {
    return "Not Paid";
  }
  const out = order.totalOutstandingSet?.shopMoney?.amount;
  if (out != null) {
    const n = parseFloat(out);
    if (n === 0) return "Paid in Full";
    if (n > 0) return "Partially Paid";
  }
  return "Not Paid";
}
