import { normalizeSpecialOrderAttributeValue } from "./special-order-line-item-attributes";

/**
 * Shared Order Summary print layout. Used by both draft-order and order print routes.
 * Layout: Letter 8.5" x 11", max 9 items per page.
 * Rules: 1-7 items = items + bottom on one page. 8-9 items = items on page 1, bottom on page 2.
 * 10+ items = 9 per page, last page has remaining items + bottom below.
 */

export const STORE_CONFIG = {
  logoUrl: "/store-logo.png",
  address: "343 Lincoln Center, Stockton, CA 95207",
  hours: "Monday - Saturday: 10am-7pm | Sunday: 10am-5pm",
  phone: "(209) 323-4588",
  website: "joehassans.com",
  instagram: "@joehassans",
};

export const MAX_ITEMS_PER_PAGE = 9;

const ALWAYS_PRESENT_ATTRIBUTES = [
  "Brand",
  "Type",
  "Style #",
  "Size",
  "Color",
  "Date Ordered",
  "Order Confirmation Number",
];
const HIDDEN_ATTRIBUTES = new Set([
  "_shopify_item_type",
  "Order Status",
  "Initial Status",
  "Special Order",
]);

export function getAttributesForDisplay(attrs) {
  const map = new Map();
  for (const a of attrs || []) {
    if (!HIDDEN_ATTRIBUTES.has(a.key)) map.set(a.key, a.value || "");
  }
  const result = [];
  for (const key of ALWAYS_PRESENT_ATTRIBUTES) {
    result.push({
      key,
      value: normalizeSpecialOrderAttributeValue(key, map.get(key) || ""),
    });
  }
  return result;
}

export function extractItemStatus(metafields, index, customAttributes) {
  const key = `product_${index + 1}_order_status`;
  const edges = metafields?.edges || [];
  const mf = edges.find((e) => e?.node?.key === key);
  if (mf?.node?.value) return mf.node.value;
  const attrs = customAttributes || [];
  const os = attrs.find((a) => a.key === "Order Status" && a.value);
  if (os) return os.value;
  const is = attrs.find((a) => a.key === "Initial Status" && a.value);
  if (is) return is.value;
  return "Not Ordered";
}

export function getItemStatusBadgeClass(status) {
  const s = String(status || "").toLowerCase();
  if (s.includes("not ordered") || s.includes("canceled")) return "badge-red";
  if (s.includes("back ordered")) return "badge-blue";
  if (
    s.includes("ordered") ||
    s.includes("received") ||
    s.includes("delivered") ||
    s.includes("drop ship")
  )
    return "badge-green";
  return "badge-subdued";
}

export function formatUsPhone(phone) {
  if (!phone) return "";
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length === 10) {
    const area = digits.slice(0, 3);
    const prefix = digits.slice(3, 6);
    const line = digits.slice(6);
    return `(${area}) ${prefix}-${line}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    const area = digits.slice(1, 4);
    const prefix = digits.slice(4, 7);
    const line = digits.slice(7);
    return `(${area}) ${prefix}-${line}`;
  }
  return phone;
}

export function formatAddress(addr) {
  if (!addr) return "";
  const formattedLines = addr.formatted;
  if (Array.isArray(formattedLines) && formattedLines.length > 0) {
    const joined = formattedLines
      .map((s) => String(s ?? "").trim())
      .filter(Boolean)
      .join(", ");
    if (joined) return joined;
  }
  const parts = [
    addr.address1,
    addr.address2,
    [addr.city, addr.province].filter(Boolean).join(", "),
    addr.zip,
    addr.country,
  ].filter(Boolean);
  return parts.join(", ");
}

export function escapeHtml(str) {
  if (str == null || typeof str !== "string") return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Build Order Summary HTML from normalized data. Same layout for draft orders and orders.
 * @param {Object} data
 * @param {string} data.orderName
 * @param {string} data.dateCreated
 * @param {string} data.summaryDate
 * @param {string} data.docTitle
 * @param {Object} data.customer - { displayName, phone, email, defaultAddress }
 * @param {string} data.overallStatus
 * @param {string} data.paymentStatus
 * @param {Array} data.lineItems - [{ title, qty, price, detailsHtml }]
 * @param {number} data.totalItemQty
 * @param {string} data.subtotalFormatted
 * @param {string} data.taxFormatted
 * @param {string} data.totalFormatted
 * @param {string} data.amountPaidFormatted
 * @param {string} data.balanceDueFormatted
 * @param {Array} [data.paymentDetailsRows] - [{ label, amountFormatted }] for Card, Cash, Voucher breakdown
 * @param {string} data.logoUrl
 * @param {string} data.shopAddressStr
 * @param {string} data.metaContact
 */
export function buildOrderSummaryHtml(data) {
  const {
    orderName,
    dateCreated,
    summaryDate,
    docTitle,
    customer,
    overallStatus,
    paymentStatus,
    lineItems,
    totalItemQty,
    subtotalFormatted,
    taxFormatted,
    totalFormatted,
    amountPaidFormatted,
    balanceDueFormatted,
    paymentDetailsRows = [],
    logoUrl,
    shopAddressStr,
    metaContact,
  } = data;

  const customerName = customer?.displayName || "—";
  const customerPhone = customer?.phone ? formatUsPhone(customer.phone) : "";
  const customerEmail = customer?.email || "";
  const customerAddr = customer?.defaultAddress
    ? formatAddress(customer.defaultAddress)
    : "";

  const totalItems = lineItems.length;
  const pageConfigs = [];
  if (totalItems <= 7) {
    pageConfigs.push({ items: lineItems, showBottom: true });
  } else if (totalItems <= 9) {
    pageConfigs.push({ items: lineItems, showBottom: false });
    pageConfigs.push({ items: [], showBottom: true });
  } else {
    for (let start = 0; start < totalItems; start += MAX_ITEMS_PER_PAGE) {
      const pageItems = lineItems.slice(start, start + MAX_ITEMS_PER_PAGE);
      const isLastBatch = start + MAX_ITEMS_PER_PAGE >= totalItems;
      pageConfigs.push({ items: pageItems, showBottom: isLastBatch });
    }
  }

  /** Print-only: green only for success statuses; all others dark gray */
  function getOverallBadgeClass(s) {
    const t = String(s || "").toLowerCase();
    if (t.includes("picked up") && t.includes("sale complete")) return "badge-green";
    return "badge-print-neutral";
  }

  function getPaymentBadgeClass(s) {
    const t = String(s || "").toLowerCase();
    if (t.includes("paid in full")) return "badge-green";
    return "badge-print-neutral";
  }

  const paymentRowsHtml =
    paymentDetailsRows.length > 0
      ? paymentDetailsRows
          .map(
            (r) =>
              `<div class="footer-row"><span>${escapeHtml(r.label)}:</span><span>${escapeHtml(r.amountFormatted)}</span></div>`
          )
          .join("") + `<div class="footer-row total-row"><span>Total Paid:</span><span>${escapeHtml(amountPaidFormatted)}</span></div>`
      : `<div class="footer-row"><span>Total Paid:</span><span>${escapeHtml(amountPaidFormatted)}</span></div>`;

  const footerHtml = `
    <div class="footer-box">
      <div class="footer-header">Payment Details</div>
      ${paymentRowsHtml}
    </div>
    <div class="footer-box">
      <div class="footer-header">Order Totals</div>
      <div class="footer-row"><span>Subtotal</span><span>${escapeHtml(subtotalFormatted)}</span></div>
      <div class="footer-row"><span>Tax</span><span>${escapeHtml(taxFormatted)}</span></div>
      <div class="footer-row total-row"><span>Total</span><span>${escapeHtml(totalFormatted)}</span></div>
      <div class="footer-row"><span>Amount Paid</span><span>${escapeHtml(amountPaidFormatted)}</span></div>
      <div class="footer-row total-row"><span>Balance Due</span><span>${escapeHtml(balanceDueFormatted)}</span></div>
    </div>`;

  const pages = [];
  for (let p = 0; p < pageConfigs.length; p++) {
    const pageNum = p + 1;
    const { items: pageItems, showBottom } = pageConfigs[p];
    const isLastPage = p === pageConfigs.length - 1;

    const itemRowsHtml = pageItems
      .map(
        (li) => `
        <tr class="item-row">
          <td class="col-item">${escapeHtml(li.title)}</td>
          <td class="col-qty">${li.qty}</td>
          <td class="col-price">${li.price}</td>
          <td class="col-details">${li.detailsHtml}</td>
        </tr>`
      )
      .join("");

    const bottomRowHtml = showBottom
      ? `<div class="bottom-row"><span class="total-qty">Total Item Qty: ${totalItemQty}</span><span></span></div>`
      : '<div class="bottom-row"><span></span><span class="arrow">→</span></div>';

    const tableHtml =
      pageItems.length > 0
        ? `
        <table class="items-table">
          <thead>
            <tr>
              <th class="col-item">Item</th>
              <th class="col-qty">Qty</th>
              <th class="col-price">Price</th>
              <th class="col-details">Details</th>
            </tr>
          </thead>
          <tbody>${itemRowsHtml}</tbody>
        </table>
        ${bottomRowHtml}`
        : bottomRowHtml;

    const headerHtml = `
      <div class="page-header">
        <div class="header-top">
          <span class="order-num">Order #${escapeHtml(orderName)}</span>
          <span class="title">Special Order Summary</span>
          <span class="page-num">Page ${pageNum}</span>
        </div>
        <div class="header-divider"></div>
        <div class="business-row">
          <div class="business-left">
            <img src="${escapeHtml(logoUrl)}" alt="Store logo" class="store-logo" />
          </div>
          <div class="business-right">
            <div class="business-address">${escapeHtml(shopAddressStr)}</div>
            <div class="business-hours">${escapeHtml(STORE_CONFIG.hours)}</div>
          </div>
        </div>
        <div class="meta-row">
          <span>Date Created: ${escapeHtml(dateCreated)} | Summary Date: ${escapeHtml(summaryDate)}</span>
          <span class="meta-right">${escapeHtml(metaContact)}</span>
        </div>
        <div class="header-divider thick"></div>
        <div class="customer-row">
          <div class="customer-info">
            <div class="customer-name">${escapeHtml(customerName)}</div>
            ${customerPhone ? `<div class="customer-phone">${escapeHtml(customerPhone)}</div>` : ""}
            ${customerEmail ? `<div>${escapeHtml(customerEmail)}</div>` : ""}
            ${customerAddr ? `<div>${escapeHtml(customerAddr)}</div>` : ""}
            <div class="customer-spacer"></div>
          </div>
          <div class="status-badges">
            <span class="badge ${getOverallBadgeClass(overallStatus)}">${escapeHtml(overallStatus)}</span>
            <span class="badge ${getPaymentBadgeClass(paymentStatus)}">${escapeHtml(paymentStatus)}</span>
          </div>
        </div>
        ${tableHtml}`;

    pages.push(
      `<div class="page ${showBottom ? "page-last" : ""}">
        ${headerHtml}
        ${showBottom ? `<div class="footer-wrap footer-flow">${footerHtml}</div>` : ""}
      </div>`
    );
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="user-scalable=no">
  <title>Special Order Summary - ${escapeHtml(docTitle)}</title>
  <style>
    @page { size: letter; margin: 0.5in; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
      font-size: 13px;
      line-height: 1.4;
      color: #222;
      background: white;
    }
    .page {
      width: 8.5in;
      min-height: 11in;
      padding: 0.35in;
      page-break-after: always;
      display: flex;
      flex-direction: column;
    }
    .page:last-child { page-break-after: auto; }
    .page.page-last {
      min-height: 0;
      height: auto;
    }

    .page-header { margin-bottom: 0.12in; }
    .header-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
      padding-bottom: 4px;
    }
    .order-num { font-weight: bold; font-size: 15px; }
    .title { font-size: 22px; font-weight: bold; letter-spacing: 0.03em; }
    .page-num { font-size: 15px; }
    .header-divider {
      border-bottom: 1px solid #ddd;
      margin: 6px 0;
    }
    .header-divider.thick { border-bottom: 2px solid #333; margin: 8px 0; }

    .business-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 6px;
      padding: 4px 0;
    }
    .store-logo {
      max-height: 72px;
      width: auto;
      display: block;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .business-right {
      text-align: right;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 4px;
    }
    .business-address {
      font-weight: bold;
      font-size: 15px;
      line-height: 1.4;
    }
    .business-hours {
      font-weight: normal;
      font-size: 12px;
      line-height: 1.35;
      color: #333;
    }

    .meta-row {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      color: #444;
      padding: 5px 0;
      border-top: 1px solid #e0e0e0;
    }

    .customer-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-top: 10px;
      margin-bottom: 10px;
      gap: 24px;
    }
    .customer-info { flex: 1; font-size: 14px; }
    .customer-name { font-weight: bold; font-size: 17px; margin-bottom: 6px; }
    .customer-phone { font-weight: bold; font-size: 15px; margin-bottom: 4px; }
    .customer-info > div { margin-bottom: 4px; }
    .customer-spacer { height: 8px; margin-top: 6px; border-bottom: 1px solid #e8e8e8; }
    .status-badges {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .status-badges .badge {
      padding: 8px 14px;
      font-size: 12px;
    }
    .badge {
      display: inline-block;
      padding: 8px 14px;
      border-radius: 8px;
      font-weight: bold;
      font-size: 13px;
      color: white !important;
      text-align: center;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .badge-green { background: #2e7d32 !important; }
    .badge-print-neutral { background: #9e9e9e !important; }
    .badge-orange { background: #f0ad4e !important; }
    .badge-red { background: #c62828 !important; }
    .badge-blue { background: #1976d2 !important; }
    .badge-subdued { background: #757575 !important; }

    .items-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 8px;
    }
    .items-table th {
      background: #e8e8e8;
      font-weight: bold;
      padding: 10px 12px;
      text-align: left;
      border-bottom: 1px solid #ccc;
      font-size: 13px;
    }
    .items-table .col-qty { text-align: center; width: 50px; padding-left: 12px; padding-right: 12px; }
    .items-table .col-price { text-align: center; width: 55px; padding-left: 12px; padding-right: 12px; }
    .items-table .col-details { width: auto; padding-right: 24px; }
    .item-row { height: 68px; }
    .item-row td {
      padding: 10px 12px;
      border-bottom: 1px solid #e0e0e0;
      vertical-align: top;
      font-size: 13px;
    }
    .item-row .col-item { font-size: 14px; font-weight: 600; }
    .item-row .col-details { padding-right: 24px; }
    .col-item { font-weight: 600; }

    .bottom-row {
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-top: 1px solid #e0e0e0;
      margin-top: -1px;
    }
    .bottom-row .total-qty { font-weight: bold; font-size: 15px; }
    .bottom-row .arrow {
      color: #666;
      font-size: 24px;
      font-weight: bold;
    }

    .footer-wrap {
      margin-top: auto;
      padding-top: 10px;
      display: flex;
      gap: 16px;
      flex-shrink: 0;
    }
    .footer-wrap.footer-flow {
      margin-top: 0;
      padding-top: 12px;
    }
    .footer-box {
      flex: 1;
      border: 1px solid #ddd;
      border-radius: 6px 6px 0 0;
      overflow: hidden;
    }
    .footer-header {
      background: #e8e8e8;
      font-weight: bold;
      padding: 6px 10px;
      font-size: 13px;
    }
    .footer-row {
      display: flex;
      justify-content: space-between;
      padding: 4px 10px;
      font-size: 13px;
    }
    .footer-row.total-row { font-weight: bold; }
    @media print {
      .page { page-break-after: always; }
      .page:last-child { page-break-after: auto; }
      .badge, .badge-green, .badge-print-neutral, .badge-orange, .badge-red, .badge-blue, .badge-subdued {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
    }
  </style>
</head>
<body>
  ${pages.join("\n")}
</body>
</html>`;
}
