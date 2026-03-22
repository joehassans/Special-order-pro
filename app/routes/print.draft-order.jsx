import { authenticate } from "../shopify.server";

/** Store branding and contact info for Order Summary print (matches mockup) */
const STORE_CONFIG = {
  logoUrl: "/store-logo.png",
  address: "343 Lincoln Center, Stockton, CA 95207",
  phone: "(209) 323-4588",
  website: "joehassans.com",
  instagram: "@joehassans",
};

const ITEMS_PER_PAGE = 7;
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

function getAttributesForDisplay(attrs) {
  const map = new Map();
  for (const a of attrs || []) {
    if (!HIDDEN_ATTRIBUTES.has(a.key)) map.set(a.key, a.value || "");
  }
  const result = [];
  for (const key of ALWAYS_PRESENT_ATTRIBUTES) {
    result.push({ key, value: map.get(key) || "" });
  }
  return result;
}

function extractItemStatus(metafields, index, customAttributes) {
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

function getItemStatusBadgeClass(status) {
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

function formatUsPhone(phone) {
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

function formatAddress(addr) {
  if (!addr) return "";
  const parts = [
    addr.address1,
    addr.address2,
    [addr.city, addr.province].filter(Boolean).join(", "),
    addr.zip,
    addr.country,
  ].filter(Boolean);
  return parts.join(", ");
}

/**
 * Serves printable draft order summary HTML for POS Print API.
 * GET /print/draft-order?id=gid://shopify/DraftOrder/123
 * Layout: Letter 8.5" x 11", 7 items per page, header/footer on every page.
 */
export async function loader({ request }) {
  const { admin, cors } = await authenticate.admin(request);

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id || !id.includes("DraftOrder")) {
    return cors(
      new Response("Missing or invalid draft order id", { status: 400 })
    );
  }

  const origin = new URL(request.url).origin;
  const logoUrl = `${origin}${STORE_CONFIG.logoUrl}`;

  const response = await admin.graphql(
    `#graphql
    query GetDraftOrderForPrint($id: ID!) {
      draftOrder(id: $id) {
        id
        name
        createdAt
        note2
        subtotalPriceSet { shopMoney { amount currencyCode } }
        totalTaxSet { shopMoney { amount currencyCode } }
        totalPriceSet { shopMoney { amount currencyCode } }
        metafields(first: 250, namespace: "custom") {
          edges { node { key value } }
        }
        customer {
          displayName
          email
          phone
          defaultAddress {
            address1
            city
            province
            zip
            country
          }
        }
        lineItems(first: 100) {
          edges {
            node {
              title
              quantity
              variant { title }
              originalUnitPriceSet { shopMoney { amount currencyCode } }
              customAttributes { key value }
            }
          }
        }
      }
    }`,
    { variables: { id } }
  );

  const json = await response.json();
  const draft = json.data?.draftOrder;
  if (!draft) {
    return cors(new Response("Draft order not found", { status: 404 }));
  }

  const formatMoney = (money) => {
    if (!money) return "—";
    const amt = parseFloat(money.amount).toFixed(2);
    return money.currencyCode === "USD"
      ? `$${amt}`
      : `${money.currencyCode} ${amt}`;
  };

  const subtotal = draft.subtotalPriceSet?.shopMoney;
  const tax = draft.totalTaxSet?.shopMoney;
  const total = draft.totalPriceSet?.shopMoney;
  const customer = draft.customer;
  const metafields = draft.metafields || { edges: [] };

  // Parse lineitem_N_attributes overrides
  const attrsByIndex = {};
  metafields.edges.forEach((e) => {
    const k = e?.node?.key;
    if (k?.startsWith("lineitem_") && k?.endsWith("_attributes")) {
      const mid = k.slice(9, -11);
      const idx = parseInt(mid, 10) - 1;
      if (!isNaN(idx)) {
        try {
          const parsed = JSON.parse(e.node.value);
          if (Array.isArray(parsed)) attrsByIndex[idx] = parsed;
        } catch (_) {}
      }
    }
  });

  const overallStatus =
    metafields.edges.find((e) => e?.node?.key === "overall_order_status")
      ?.node?.value || "Order Pending";
  const paymentStatus = "Not Paid"; // Draft orders are unpaid by default

  const rawLineItems = draft.lineItems?.edges?.map((e) => e.node) ?? [];
  const lineItems = rawLineItems.map((li, idx) => {
    const overrides = attrsByIndex[idx];
    const attrs = getAttributesForDisplay(overrides || li.customAttributes || []);
    const itemStatus = extractItemStatus(
      metafields,
      idx,
      overrides || li.customAttributes
    );
    const priceSet = li.originalUnitPriceSet?.shopMoney;
    const price = priceSet ? formatMoney(priceSet) : "—";
    const variant = li.variant?.title ? ` (${li.variant.title})` : "";

    const brand = attrs.find((a) => a.key === "Brand")?.value || "";
    const type = attrs.find((a) => a.key === "Type")?.value || "";
    const styleNum = attrs.find((a) => a.key === "Style #")?.value || "";
    const size = attrs.find((a) => a.key === "Size")?.value || "";
    const color = attrs.find((a) => a.key === "Color")?.value || "";
    const dateOrdered = attrs.find((a) => a.key === "Date Ordered")?.value || "";
    const confNum = attrs.find((a) => a.key === "Order Confirmation Number")
      ?.value || "";

    const detailsLines = [];
    if (brand || type) detailsLines.push([brand, type].filter(Boolean).join(" | "));
    if (styleNum || size || color) detailsLines.push([styleNum, size, color].filter(Boolean).join(" | "));
    if (dateOrdered || confNum)
      detailsLines.push(
        [dateOrdered ? `Ordered: ${dateOrdered}` : "", confNum ? `Conf. #: ${confNum}` : ""]
          .filter(Boolean)
          .join(" | ")
      );
    const detailsHtml = detailsLines.length
      ? detailsLines.map((l) => escapeHtml(l)).join("<br>")
      : "—";

    return {
      title: li.title + variant,
      qty: li.quantity || 1,
      price,
      itemStatus,
      badgeClass: getItemStatusBadgeClass(itemStatus),
      detailsHtml,
    };
  });

  const totalItemQty = lineItems.reduce((sum, li) => sum + li.qty, 0);
  const orderName = draft.name?.replace(/^#/, "") || "—";
  const dateCreated = draft.createdAt
    ? new Date(draft.createdAt).toLocaleDateString(undefined, {
        month: "2-digit",
        day: "2-digit",
        year: "numeric",
      })
    : "—";
  const summaryDate = dateCreated;

  const shopAddressStr = STORE_CONFIG.address;
  const metaContact =
    [STORE_CONFIG.phone, STORE_CONFIG.website, `Instagram: ${STORE_CONFIG.instagram}`]
      .filter(Boolean)
      .join(" | ") || "";

  const customerName = customer?.displayName || "—";
  const customerPhone = customer?.phone ? formatUsPhone(customer.phone) : "";
  const customerEmail = customer?.email || "";
  const customerAddr = customer?.defaultAddress
    ? formatAddress(customer.defaultAddress)
    : "";

  const numPages = Math.max(
    1,
    Math.ceil(lineItems.length / ITEMS_PER_PAGE)
  );

  function getOverallBadgeClass(s) {
    const t = String(s || "").toLowerCase();
    if (t.includes("picked up") || t.includes("sale complete")) return "badge-green";
    if (t.includes("order canceled")) return "badge-red";
    return "badge-orange";
  }

  function getPaymentBadgeClass(s) {
    const t = String(s || "").toLowerCase();
    if (t.includes("paid in full") || t.includes("paid")) return "badge-green";
    if (t.includes("partially")) return "badge-orange";
    return "badge-red";
  }

  const footerHtml = `
    <div class="footer-box">
      <div class="footer-header">Payment Details</div>
      <div class="footer-row"><span>Total Paid:</span><span>—</span></div>
    </div>
    <div class="footer-box">
      <div class="footer-header">Order Totals</div>
      <div class="footer-row"><span>Subtotal</span><span>${subtotal ? escapeHtml(formatMoney(subtotal)) : "—"}</span></div>
      <div class="footer-row"><span>Tax</span><span>${tax ? escapeHtml(formatMoney(tax)) : "—"}</span></div>
      <div class="footer-row total-row"><span>Total</span><span>${total ? escapeHtml(formatMoney(total)) : "—"}</span></div>
      <div class="footer-row"><span>Amount Paid</span><span>—</span></div>
      <div class="footer-row total-row"><span>Balance Due</span><span>${total ? escapeHtml(formatMoney(total)) : "—"}</span></div>
    </div>`;

  const pages = [];
  for (let p = 0; p < numPages; p++) {
    const pageNum = p + 1;
    const start = p * ITEMS_PER_PAGE;
    const pageItems = lineItems.slice(start, start + ITEMS_PER_PAGE);
    const isLastPage = p === numPages - 1;

    const itemRowsHtml = pageItems
      .map(
        (li) => `
        <tr class="item-row">
          <td class="col-item">${escapeHtml(li.title)}</td>
          <td class="col-qty">${li.qty}</td>
          <td class="col-price">${li.price}</td>
          <td class="col-status"><span class="badge ${li.badgeClass}">${escapeHtml(li.itemStatus)}</span></td>
          <td class="col-details">${li.detailsHtml}</td>
        </tr>`
      )
      .join("");

    const emptyRows = ITEMS_PER_PAGE - pageItems.length;
    const emptyRowsHtml = Array(emptyRows)
      .fill(null)
      .map(
        () => `
        <tr class="item-row empty-row">
          <td class="col-item">&nbsp;</td>
          <td class="col-qty">&nbsp;</td>
          <td class="col-price">&nbsp;</td>
          <td class="col-status">&nbsp;</td>
          <td class="col-details">&nbsp;</td>
        </tr>`
      )
      .join("");

    const bottomRowHtml = isLastPage
      ? `<div class="bottom-row"><span class="total-qty">Total Item Qty: ${totalItemQty}</span><span></span></div>`
      : '<div class="bottom-row"><span></span><span class="arrow">→</span></div>';

    const headerHtml = `
      <div class="page-header">
        <div class="header-top">
          <span class="order-num">Order #${escapeHtml(orderName)}</span>
          <span class="title">ORDER SUMMARY</span>
          <span class="page-num">Page ${pageNum}</span>
        </div>
        <div class="header-divider"></div>
        <div class="business-row">
          <div class="business-left">
            <img src="${escapeHtml(logoUrl)}" alt="Store logo" class="store-logo" />
          </div>
          <div class="business-right">${escapeHtml(shopAddressStr)}</div>
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
        <table class="items-table">
          <thead>
            <tr>
              <th class="col-item">Item</th>
              <th class="col-qty">Qty</th>
              <th class="col-price">Price</th>
              <th class="col-status">Item Status</th>
              <th class="col-details">Details</th>
            </tr>
          </thead>
          <tbody>${itemRowsHtml}${emptyRowsHtml}</tbody>
        </table>
        ${bottomRowHtml}`;

    pages.push(
      `<div class="page">
        ${headerHtml}
        <div class="footer-wrap">${footerHtml}</div>
      </div>`
    );
  }

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="user-scalable=no">
  <title>Order Summary - ${escapeHtml(draft.name)}</title>
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
      align-items: center;
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
      font-weight: bold;
      font-size: 15px;
      line-height: 1.4;
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
    .items-table .col-status { width: 175px; white-space: nowrap; padding-left: 12px; padding-right: 12px; }
    .items-table .col-details { width: auto; padding-right: 24px; }
    .item-row { height: 68px; }
    .item-row td {
      padding: 10px 12px;
      border-bottom: 1px solid #e0e0e0;
      vertical-align: top;
      font-size: 13px;
    }
    .item-row .col-status .badge { font-size: 11px; padding: 6px 10px; white-space: nowrap; }
    .item-row .col-item { font-size: 14px; font-weight: 600; }
    .item-row .col-details { padding-right: 24px; }
    .item-row.empty-row td { border-bottom: 1px solid #e8e8e8; }
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
      .badge, .badge-green, .badge-orange, .badge-red, .badge-blue, .badge-subdued {
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

  return cors(
    new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })
  );
}

function escapeHtml(str) {
  if (str == null || typeof str !== "string") return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
