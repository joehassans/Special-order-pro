import prisma from "../db.server";

/**
 * Per-shop item detail fields. These become the line-item attribute keys
 * employees fill in when marking an item as a special order (POS cart
 * editor) and the always-present editable fields in detail views.
 *
 * Stores that never customized get the original defaults.
 */

export const DEFAULT_ITEM_FIELDS = ["Brand", "Type", "Style #", "Size", "Color"];

/**
 * Keys with dedicated UI or workflow meaning — not customizable and not
 * allowed as custom field labels (case-insensitive).
 */
const RESERVED_LABELS = new Set(
  [
    "Special Order",
    "Initial Status",
    "Order Status",
    "Date Ordered",
    "Order Confirmation Number",
    "_shopify_item_type",
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
  ].map((s) => s.toLowerCase())
);

const MAX_FIELDS = 12;
const MAX_LABEL_LENGTH = 40;

/** @param {string} shop @returns {Promise<string[]>} ordered field labels */
export async function getItemFields(shop) {
  const rows = await prisma.shopItemField.findMany({
    where: { shop },
    orderBy: { position: "asc" },
    select: { label: true },
  });
  return rows.length > 0 ? rows.map((r) => r.label) : [...DEFAULT_ITEM_FIELDS];
}

/**
 * Validate labels; returns a user-facing error string or null when valid.
 * @param {string[]} labels
 */
export function validateItemFieldLabels(labels) {
  if (!Array.isArray(labels) || labels.length === 0) {
    return "Add at least one item field.";
  }
  if (labels.length > MAX_FIELDS) {
    return `Use at most ${MAX_FIELDS} fields.`;
  }
  const seen = new Set();
  for (const raw of labels) {
    const label = String(raw ?? "").trim();
    if (!label) return "Field names can't be empty.";
    if (label.length > MAX_LABEL_LENGTH) {
      return `"${label.slice(0, 20)}…" is too long (max ${MAX_LABEL_LENGTH} characters).`;
    }
    const lower = label.toLowerCase();
    if (RESERVED_LABELS.has(lower)) {
      return `"${label}" is a reserved name used by the app — pick a different name.`;
    }
    if (seen.has(lower)) return `"${label}" is listed twice.`;
    seen.add(lower);
  }
  return null;
}

/**
 * Replace the shop's field list (order = array order). Caller validates
 * first with validateItemFieldLabels.
 * @param {string} shop @param {string[]} labels
 */
export async function saveItemFields(shop, labels) {
  const cleaned = labels.map((l) => String(l).trim());
  await prisma.$transaction([
    prisma.shopItemField.deleteMany({ where: { shop } }),
    prisma.shopItemField.createMany({
      data: cleaned.map((label, index) => ({
        shop,
        label,
        position: index + 1,
      })),
    }),
  ]);
}
