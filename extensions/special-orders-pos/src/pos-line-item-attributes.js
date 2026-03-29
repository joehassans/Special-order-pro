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
};

/** Same values as Modal.jsx ORDER_STATUS_OPTIONS */
export const ORDER_STATUS_OPTIONS_FOR_LINE_ITEM = [
  "Not Ordered",
  "Ordered",
  "Back Ordered",
  "Drop Ship - Ordered",
  "Drop Ship - Delivered",
  "Received",
  "Canceled",
];
