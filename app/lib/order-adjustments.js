/**
 * Derives Order Adjustments card data from a normalized order (loader output).
 * Item adjustment: custom attr itemAdjustmentType / Item Adjustment Type, or metafield product_N_adjustment_type (exchanged | returned).
 * Money: per-item adjustmentRefundAmount, additionalPaymentAmount; order totalRefundedAmount (Shopify); order metafield order_adjustments_additional_payment.
 */

export function normalizeAdjustmentType(raw) {
  const s = String(raw || "")
    .toLowerCase()
    .trim();
  if (!s) return null;
  if (s === "exchanged" || s === "exchange") return "exchanged";
  if (s === "returned" || s === "return") return "returned";
  return null;
}

/**
 * @param {Array<{key: string, value: string}>} rawAttrs
 * @param {string} [metafieldAdjustmentType] - from order metafield product_N_adjustment_type
 */
export function readLineItemAdjustmentFields(rawAttrs, metafieldAdjustmentType) {
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
    normalizeAdjustmentType(metafieldAdjustmentType || "");

  return {
    itemAdjustmentType: merged,
    adjustmentRefundAmount: find([
      "adjustmentRefundAmount",
      "Adjustment Refund Amount",
      "adjustment_refund_amount",
    ]),
    additionalPaymentAmount: find([
      "additionalPaymentAmount",
      "Additional Payment Amount",
      "additional_payment_amount",
    ]),
  };
}

function parseMoneyString(value) {
  if (value == null || value === "") return 0;
  const n = parseFloat(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {object} order - normalized order from loader with lineItems and optional totals
 * @returns {{
 *   exchangeCount: number,
 *   returnCount: number,
 *   refundTotal: number,
 *   additionalPaymentTotal: number,
 *   currencyCode: string,
 * }}
 */
export function deriveOrderAdjustments(order) {
  const lineItems = order.lineItems || [];
  const currencyCode =
    order.totalRefundedCurrency ||
    lineItems[0]?.currencyCode ||
    order.currencyCode ||
    "USD";

  let exchangeCount = 0;
  let returnCount = 0;
  let itemRefundSum = 0;
  let itemAdditionalSum = 0;

  for (const item of lineItems) {
    const t = normalizeAdjustmentType(item.itemAdjustmentType);
    if (t === "exchanged") exchangeCount += 1;
    if (t === "returned") returnCount += 1;
    itemRefundSum += parseMoneyString(item.adjustmentRefundAmount);
    itemAdditionalSum += parseMoneyString(item.additionalPaymentAmount);
  }

  const shopifyRefunded = Number(order.totalRefundedAmount) || 0;
  const metafieldRefund = Number(order.orderAdjustmentsRefundTotalMetafield) || 0;
  const metafieldAdditional = Number(order.orderAdjustmentsAdditionalPaymentMetafield) || 0;

  let refundTotal = shopifyRefunded;
  if (refundTotal <= 0 && metafieldRefund > 0) refundTotal = metafieldRefund;
  if (refundTotal <= 0 && itemRefundSum > 0) refundTotal = itemRefundSum;

  let additionalPaymentTotal = itemAdditionalSum + metafieldAdditional;

  return {
    exchangeCount,
    returnCount,
    refundTotal,
    additionalPaymentTotal,
    currencyCode,
  };
}

export function formatAdjustmentMoney(amount, currencyCode) {
  if (amount == null || !(Number(amount) > 0)) return "";
  const amt = Number(amount).toFixed(2);
  return currencyCode === "USD" ? `$${amt}` : `${amt} ${currencyCode}`;
}
