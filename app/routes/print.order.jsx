import { authenticate } from "../shopify.server";
import {
  STORE_CONFIG,
  getAttributesForDisplay,
  extractItemStatus,
  getItemStatusBadgeClass,
  escapeHtml,
  buildOrderSummaryHtml,
} from "../lib/print-order-summary.server";

function getPaymentStatusFromOrder(order) {
  const status = order.displayFinancialStatus;
  if (status === "PAID") return "Paid in Full";
  if (status === "PARTIALLY_PAID") return "Partially Paid";
  return "Not Paid";
}

/**
 * Serves printable order summary HTML for POS Print API.
 * GET /print/order?id=gid://shopify/Order/123
 * Same format as draft orders - statuses, details, totals from the actual order.
 */
export async function loader({ request }) {
  const { admin, cors } = await authenticate.admin(request);

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id || !id.includes("Order") || id.includes("DraftOrder")) {
    return cors(
      new Response("Missing or invalid order id", { status: 400 })
    );
  }

  const origin = new URL(request.url).origin;
  const logoUrl = `${origin}${STORE_CONFIG.logoUrl}`;

  const response = await admin.graphql(
    `#graphql
    query GetOrderForPrint($id: ID!) {
      order(id: $id) {
        id
        name
        createdAt
        displayFinancialStatus
        subtotalPriceSet { shopMoney { amount currencyCode } }
        totalTaxSet { shopMoney { amount currencyCode } }
        totalPriceSet { shopMoney { amount currencyCode } }
        totalOutstandingSet { shopMoney { amount currencyCode } }
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
              variantTitle
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
  const order = json.data?.order;
  if (!order) {
    return cors(new Response("Order not found", { status: 404 }));
  }

  const formatMoney = (money) => {
    if (!money) return "—";
    const amt = parseFloat(money.amount).toFixed(2);
    return money.currencyCode === "USD" ? `$${amt}` : `${money.currencyCode} ${amt}`;
  };

  const subtotal = order.subtotalPriceSet?.shopMoney;
  const tax = order.totalTaxSet?.shopMoney;
  const total = order.totalPriceSet?.shopMoney;
  const outstanding = order.totalOutstandingSet?.shopMoney;
  const customer = order.customer;
  const metafields = order.metafields || { edges: [] };

  let amountPaid = null;
  let balanceDue = outstanding;
  if (total && outstanding) {
    const totalAmt = parseFloat(total.amount);
    const outstandingAmt = parseFloat(outstanding.amount);
    amountPaid = {
      amount: (totalAmt - outstandingAmt).toFixed(2),
      currencyCode: total.currencyCode,
    };
  }

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
  const paymentStatus = getPaymentStatusFromOrder(order);

  const rawLineItems = order.lineItems?.edges?.map((e) => e.node) ?? [];
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
    const variantTitle = li.variantTitle;
    const variant = variantTitle ? ` (${variantTitle})` : "";

    const brand = attrs.find((a) => a.key === "Brand")?.value || "";
    const type = attrs.find((a) => a.key === "Type")?.value || "";
    const styleNum = attrs.find((a) => a.key === "Style #")?.value || "";
    const size = attrs.find((a) => a.key === "Size")?.value || "";
    const color = attrs.find((a) => a.key === "Color")?.value || "";
    const dateOrdered = attrs.find((a) => a.key === "Date Ordered")?.value || "";
    const confNum = attrs.find((a) => a.key === "Order Confirmation Number")?.value || "";

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

  const dateStr = order.createdAt
    ? new Date(order.createdAt).toLocaleDateString(undefined, {
        month: "2-digit",
        day: "2-digit",
        year: "numeric",
      })
    : "—";

  const data = {
    orderName: order.name?.replace(/^#/, "") || "—",
    dateCreated: dateStr,
    summaryDate: dateStr,
    docTitle: order.name || "Order",
    customer: customer
      ? {
          displayName: customer.displayName,
          phone: customer.phone,
          email: customer.email,
          defaultAddress: customer.defaultAddress,
        }
      : null,
    overallStatus,
    paymentStatus,
    lineItems,
    totalItemQty: lineItems.reduce((sum, li) => sum + li.qty, 0),
    subtotalFormatted: subtotal ? formatMoney(subtotal) : "—",
    taxFormatted: tax ? formatMoney(tax) : "—",
    totalFormatted: total ? formatMoney(total) : "—",
    amountPaidFormatted: amountPaid ? formatMoney(amountPaid) : "—",
    balanceDueFormatted: balanceDue ? formatMoney(balanceDue) : "—",
    logoUrl,
    shopAddressStr: STORE_CONFIG.address,
    metaContact: [STORE_CONFIG.phone, STORE_CONFIG.website, `Instagram: ${STORE_CONFIG.instagram}`]
      .filter(Boolean)
      .join(" | "),
  };

  const html = buildOrderSummaryHtml(data);

  return cors(
    new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })
  );
}
