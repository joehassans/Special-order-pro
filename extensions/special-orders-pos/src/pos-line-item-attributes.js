/**
 * Cart line item custom properties (POS cart → order line custom attributes).
 * Keep in sync with extensions/special-orders-pos/src/Modal.jsx (ORDER_STATUS_OPTIONS + attribute keys).
 */
export const LINE_ITEM_PROPERTY_KEYS = {
  SPECIAL_ORDER: "Special Order",
  INITIAL_STATUS: "Initial Status",
  BRAND: "Brand",
  TYPE: "Type",
  STYLE: "Style #",
  SIZE: "Size",
  COLOR: "Color",
  /** Stored as "Date Ordered" on line properties; label in UI is "Item Order Date" */
  DATE_ORDERED: "Date Ordered",
  ORDER_CONFIRMATION_NUMBER: "Order Confirmation Number",
};

/** Cart-level custom properties (shared across all line items until checkout). */
export const CART_PROPERTY_KEYS = {
  SPECIAL_ORDER_NOTES: "Special Order Notes",
};

/**
 * Cart line item modal only — subset of Modal.jsx ORDER_STATUS_OPTIONS
 * (excludes Drop Ship - Delivered, Received, Canceled for POS cart entry).
 */
export const ORDER_STATUS_OPTIONS_FOR_LINE_ITEM = [
  "Not Ordered",
  "Ordered",
  "Back Ordered",
  "Drop Ship - Ordered",
];
