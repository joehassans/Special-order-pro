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

function buildPaymentDetailsRows(transactions, formatMoney) {
  const rows = [];
  const edges = transactions?.edges ?? [];
  const paymentKinds = new Set(["SALE", "CAPTURE"]);

  for (const { node: tx } of edges) {
    if (tx.status !== "SUCCESS") continue;
    if (!paymentKinds.has(tx.kind)) continue;

    const money = tx.amountSet?.shopMoney;
    if (!money || parseFloat(money.amount) <= 0) continue;

    let label = "Other";

    if (tx.manualPaymentGateway || /cash|manual/i.test(tx.formattedGateway || tx.gateway || "")) {
      label = "Cash";
    } else if (tx.accountNumber || (tx.formattedGateway && !/gift|voucher/i.test(tx.formattedGateway))) {
      const company = tx.formattedGateway || tx.gateway || "Card";
      const last4 = tx.accountNumber?.replace(/\D/g, "").slice(-4) || "";
      const suffix = last4 ? ` .... ${last4}` : "";
      label = `Card (${company}${suffix})`;
    } else if (/gift|voucher|store.?credit/i.test(tx.formattedGateway || tx.gateway || "")) {
      label = "Voucher";
    } else if (tx.formattedGateway || tx.gateway) {
      label = tx.formattedGateway || tx.gateway;
    }

    rows.push({ label, amountFormatted: formatMoney(money) });
  }

  return rows;
}

function buildLineItems(rawItems, metafields, attrsByIndex, getVariantTitle, formatMoney) {
  return rawItems.map((li, idx) => {
    const overrides = attrsByIndex[idx];
    const attrs = getAttributesForDisplay(overrides || li.customAttributes || []);
    const itemStatus = extractItemStatus(metafields, idx, overrides || li.customAttributes);
    const priceSet = li.originalUnitPriceSet?.shopMoney;
    const price = priceSet ? formatMoney(priceSet) : "—";
    const variantTitle = getVariantTitle(li);
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
}

/**
 * Unified print route for both draft orders and orders.
 * GET /print?id=gid://shopify/DraftOrder/123
 * GET /print?id=gid://shopify/Order/123
 */
export async function loader({ request }) {
  const { admin, cors } = await authenticate.admin(request);

  const url = new URL(request.url);
  let id = url.searchParams.get("id");
  if (!id) {
    return cors(new Response("Missing id parameter", { status: 400 }));
  }

  // Normalize ID: ensure we have a proper GID for the order query
  if (!id.startsWith("gid://") && /^\d+$/.test(id)) {
    id = `gid://shopify/Order/${id}`;
  }

  const origin = new URL(request.url).origin;
  const logoUrl = `${origin}${STORE_CONFIG.logoUrl}`;
  const formatMoney = (money) => {
    if (!money) return "—";
    const amt = parseFloat(money.amount).toFixed(2);
    return money.currencyCode === "USD" ? `$${amt}` : `${money.currencyCode} ${amt}`;
  };

  const isDraft = id.includes("DraftOrder");

  if (isDraft) {
    const response = await admin.graphql(
      `#graphql
      query GetDraftOrderForPrint($id: ID!) {
        draftOrder(id: $id) {
          id name createdAt note2
          subtotalPriceSet { shopMoney { amount currencyCode } }
          totalTaxSet { shopMoney { amount currencyCode } }
          totalPriceSet { shopMoney { amount currencyCode } }
          metafields(first: 250, namespace: "custom") { edges { node { key value } } }
          customer { displayName email phone defaultAddress { address1 city province zip country } }
          lineItems(first: 100) {
            edges {
              node {
                title quantity variant { title }
                originalUnitPriceSet { shopMoney { amount currencyCode } }
                customAttributes { key value }
              }
            }
          }
        }
      }`,
      { variables: { id } }
    );

    const draft = (await response.json()).data?.draftOrder;
    if (!draft) return cors(new Response("Draft order not found", { status: 404 }));

    const metafields = draft.metafields || { edges: [] };
    const attrsByIndex = {};
    metafields.edges.forEach((e) => {
      const k = e?.node?.key;
      if (k?.startsWith("lineitem_") && k?.endsWith("_attributes")) {
        const idx = parseInt(k.slice(9, -11), 10) - 1;
        if (!isNaN(idx)) {
          try {
            const parsed = JSON.parse(e.node.value);
            if (Array.isArray(parsed)) attrsByIndex[idx] = parsed;
          } catch (_) {}
        }
      }
    });

    const overallStatus = metafields.edges.find((e) => e?.node?.key === "overall_order_status")?.node?.value || "Order Pending";
    const rawLineItems = draft.lineItems?.edges?.map((e) => e.node) ?? [];
    const lineItems = buildLineItems(rawLineItems, metafields, attrsByIndex, (li) => li.variant?.title, formatMoney);

    const dateStr = draft.createdAt ? new Date(draft.createdAt).toLocaleDateString(undefined, { month: "2-digit", day: "2-digit", year: "numeric" }) : "—";
    const subtotal = draft.subtotalPriceSet?.shopMoney;
    const tax = draft.totalTaxSet?.shopMoney;
    const total = draft.totalPriceSet?.shopMoney;

    const data = {
      orderName: draft.name?.replace(/^#/, "") || "—",
      dateCreated: dateStr,
      summaryDate: dateStr,
      docTitle: draft.name || "Order",
      customer: draft.customer ? { displayName: draft.customer.displayName, phone: draft.customer.phone, email: draft.customer.email, defaultAddress: draft.customer.defaultAddress } : null,
      overallStatus,
      paymentStatus: "Not Paid",
      lineItems,
      totalItemQty: lineItems.reduce((s, li) => s + li.qty, 0),
      subtotalFormatted: subtotal ? formatMoney(subtotal) : "—",
      taxFormatted: tax ? formatMoney(tax) : "—",
      totalFormatted: total ? formatMoney(total) : "—",
      amountPaidFormatted: "—",
      balanceDueFormatted: total ? formatMoney(total) : "—",
      paymentDetailsRows: [],
      logoUrl,
      shopAddressStr: STORE_CONFIG.address,
      metaContact: [STORE_CONFIG.phone, STORE_CONFIG.website, `Instagram: ${STORE_CONFIG.instagram}`].filter(Boolean).join(" | "),
    };

    const html = buildOrderSummaryHtml(data);
    return cors(new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }));
  }

  // Order (not draft)
  const response = await admin.graphql(
    `#graphql
    query GetOrderForPrint($id: ID!) {
      order(id: $id) {
        id name createdAt displayFinancialStatus
        subtotalPriceSet { shopMoney { amount currencyCode } }
        totalTaxSet { shopMoney { amount currencyCode } }
        totalPriceSet { shopMoney { amount currencyCode } }
        totalOutstandingSet { shopMoney { amount currencyCode } }
        metafields(first: 250, namespace: "custom") { edges { node { key value } } }
        customer { displayName email phone defaultAddress { address1 city province zip country } }
        transactions(first: 25) {
          edges {
            node {
              kind status
              amountSet { shopMoney { amount currencyCode } }
              formattedGateway gateway accountNumber manualPaymentGateway
            }
          }
        }
        lineItems(first: 100) {
          edges {
            node {
              title quantity variantTitle
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

  if (json.errors?.length) {
    return cors(
      new Response(
        `Order fetch failed: ${json.errors.map((e) => e.message).join("; ")}`,
        { status: 500 }
      )
    );
  }

  const order = json.data?.order;
  if (!order) {
    return cors(
      new Response("Order not found. The order may be older than 60 days or the ID may be invalid.", {
        status: 404,
      })
    );
  }

  const subtotal = order.subtotalPriceSet?.shopMoney;
  const tax = order.totalTaxSet?.shopMoney;
  const total = order.totalPriceSet?.shopMoney;
  const outstanding = order.totalOutstandingSet?.shopMoney;
  const metafields = order.metafields || { edges: [] };

  let amountPaid = null;
  if (total && outstanding) {
    const totalAmt = parseFloat(total.amount);
    const outstandingAmt = parseFloat(outstanding.amount);
    amountPaid = { amount: (totalAmt - outstandingAmt).toFixed(2), currencyCode: total.currencyCode };
  }

  const attrsByIndex = {};
  metafields.edges.forEach((e) => {
    const k = e?.node?.key;
    if (k?.startsWith("lineitem_") && k?.endsWith("_attributes")) {
      const idx = parseInt(k.slice(9, -11), 10) - 1;
      if (!isNaN(idx)) {
        try {
          const parsed = JSON.parse(e.node.value);
          if (Array.isArray(parsed)) attrsByIndex[idx] = parsed;
        } catch (_) {}
      }
    }
  });

  const overallStatus = metafields.edges.find((e) => e?.node?.key === "overall_order_status")?.node?.value || "Order Pending";
  const paymentStatus = getPaymentStatusFromOrder(order);

  const rawLineItems = order.lineItems?.edges?.map((e) => e.node) ?? [];
  const lineItems = buildLineItems(rawLineItems, metafields, attrsByIndex, (li) => li.variantTitle, formatMoney);

  const dateStr = order.createdAt ? new Date(order.createdAt).toLocaleDateString(undefined, { month: "2-digit", day: "2-digit", year: "numeric" }) : "—";

  const data = {
    orderName: order.name?.replace(/^#/, "") || "—",
    dateCreated: dateStr,
    summaryDate: dateStr,
    docTitle: order.name || "Order",
    customer: order.customer ? { displayName: order.customer.displayName, phone: order.customer.phone, email: order.customer.email, defaultAddress: order.customer.defaultAddress } : null,
    overallStatus,
    paymentStatus,
    lineItems,
    totalItemQty: lineItems.reduce((s, li) => s + li.qty, 0),
    subtotalFormatted: subtotal ? formatMoney(subtotal) : "—",
    taxFormatted: tax ? formatMoney(tax) : "—",
    totalFormatted: total ? formatMoney(total) : "—",
    amountPaidFormatted: amountPaid ? formatMoney(amountPaid) : "—",
    balanceDueFormatted: outstanding ? formatMoney(outstanding) : "—",
    paymentDetailsRows: buildPaymentDetailsRows(order.transactions, formatMoney),
    logoUrl,
    shopAddressStr: STORE_CONFIG.address,
    metaContact: [STORE_CONFIG.phone, STORE_CONFIG.website, `Instagram: ${STORE_CONFIG.instagram}`].filter(Boolean).join(" | "),
  };

  const html = buildOrderSummaryHtml(data);
  return cors(new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }));
}
