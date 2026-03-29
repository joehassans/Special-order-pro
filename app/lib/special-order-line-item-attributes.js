/**
 * Item detail custom attributes (Brand, Type, etc.) are stored in uppercase
 * regardless of how they were typed (admin, POS modal, cart line item).
 */
export const UPPERCASE_VALUE_ATTRIBUTE_KEYS = [
  "Brand",
  "Type",
  "Style #",
  "Size",
  "Color",
  "Date Ordered",
  "Order Confirmation Number",
];

export function normalizeSpecialOrderAttributeValue(key, value) {
  if (value == null) return "";
  if (!UPPERCASE_VALUE_ATTRIBUTE_KEYS.includes(key)) {
    return String(value);
  }
  return String(value).trim().toUpperCase();
}

/** Call before persisting an array of { key, value } line item attributes. */
export function normalizeAttributesArrayForSave(attrs) {
  if (!Array.isArray(attrs)) return attrs;
  return attrs.map((a) => ({
    key: a.key,
    value: normalizeSpecialOrderAttributeValue(a.key, a.value),
  }));
}
