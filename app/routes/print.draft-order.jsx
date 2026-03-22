import { authenticate } from "../shopify.server";

/**
 * Serves printable draft order receipt HTML for POS Print API.
 * GET /print/draft-order?id=gid://shopify/DraftOrder/123
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
        customer {
          displayName
          email
          phone
        }
        lineItems(first: 50) {
          edges {
            node {
              title
              quantity
              variant { title }
              originalUnitPriceSet { shopMoney { amount currencyCode } }
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
    return money.currencyCode === "USD" ? `$${amt}` : `${money.currencyCode} ${amt}`;
  };

  const subtotal = draft.subtotalPriceSet?.shopMoney;
  const tax = draft.totalTaxSet?.shopMoney;
  const total = draft.totalPriceSet?.shopMoney;
  const customer = draft.customer;
  const lineItems = draft.lineItems?.edges?.map((e) => e.node) ?? [];

  const lineItemsHtml = lineItems
    .map((li) => {
      const priceSet = li.originalUnitPriceSet?.shopMoney;
      const price = priceSet ? formatMoney(priceSet) : "";
      const lineTotal = priceSet
        ? formatMoney({
            amount: (parseFloat(priceSet.amount) * (li.quantity || 1)).toString(),
            currencyCode: priceSet.currencyCode,
          })
        : "";
      const variant = li.variant?.title ? ` - ${li.variant.title}` : "";
      return `
        <div class="line-item">
          <p><strong>${escapeHtml(li.title)}${escapeHtml(variant)}</strong></p>
          <p class="line-meta">Qty: ${li.quantity || 1} @ ${price} = ${lineTotal}</p>
        </div>`;
    })
    .join("");

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="user-scalable=no">
  <style>
    :root {
      --font-smallest: 0.6875rem;
      --font-small: 0.875rem;
      --font-medium: 1rem;
      --font-large: 1.5rem;
      --font-largest: 3rem;
      --font-family: system-ui;
    }
    * { box-sizing: border-box; }
    body {
      margin: 2rem 1rem 2.5rem 1rem;
      font-family: var(--font-family);
      font-weight: 400;
      font-size: var(--font-large);
      background: white;
    }
    p { margin: 0 0 0.5rem 0; }
    .price-box {
      border-radius: 0.7rem;
      border: 0.3rem solid black;
      margin: 2.5rem 0.3125rem;
      padding: 1.75rem 1.25rem;
      text-align: center;
      font-weight: bold;
      font-size: var(--font-large);
    }
    .price-box .total { font-size: var(--font-largest); }
    .line-item { margin: 1rem 0; padding-bottom: 0.5rem; border-bottom: 1px solid #eee; }
    .line-meta { font-size: var(--font-small); color: #666; }
    .header { text-align: center; margin-bottom: 1.5rem; }
    .footer { margin-top: 2rem; font-size: var(--font-small); color: #666; text-align: center; }
    .draft-badge { background: #ff9800; color: white; padding: 0.25rem 0.5rem; border-radius: 4px; font-size: var(--font-small); }
    @media print {
      body { margin: 0.5rem; }
      .page-break { page-break-after: always; }
    }
  </style>
</head>
<body>
  <div class="header">
    <p><span class="draft-badge">DRAFT ORDER</span></p>
    <p><strong>${escapeHtml(draft.name)}</strong></p>
    <p style="font-size: var(--font-small);">${escapeHtml(new Date(draft.createdAt).toLocaleDateString())}</p>
  </div>
  <div class="price-box">
    <p>Total</p>
    <p class="total">${total ? escapeHtml(formatMoney(total)) : "—"}</p>
  </div>
  ${customer ? `
  <div style="margin: 1rem 0;">
    <p><strong>Customer:</strong> ${escapeHtml(customer.displayName || "—")}</p>
    ${customer.email ? `<p><strong>Email:</strong> ${escapeHtml(customer.email)}</p>` : ""}
    ${customer.phone ? `<p><strong>Phone:</strong> ${escapeHtml(customer.phone)}</p>` : ""}
  </div>
  ` : ""}
  <div style="margin: 1rem 0;">
    <p><strong>Subtotal:</strong> ${subtotal ? escapeHtml(formatMoney(subtotal)) : "—"}</p>
    <p><strong>Tax:</strong> ${tax ? escapeHtml(formatMoney(tax)) : "—"}</p>
  </div>
  <div style="margin-top: 1.5rem;">
    <p><strong>Line Items</strong></p>
    ${lineItemsHtml}
  </div>
  ${draft.note2 ? `<div style="margin-top: 1.5rem;"><p><strong>Note:</strong></p><p>${escapeHtml(draft.note2)}</p></div>` : ""}
  <div class="footer">
    <p>Printed from Special Orders Pro</p>
    <p>${escapeHtml(new Date().toLocaleString())}</p>
  </div>
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
