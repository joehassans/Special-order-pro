import { authenticate } from "../shopify.server";

/**
 * Serves printable draft order summary HTML for POS Print API.
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
      const variant = li.variant?.title ? ` (${li.variant.title})` : "";
      return `
        <tr>
          <td>${escapeHtml(li.title)}${escapeHtml(variant)}</td>
          <td class="num">${li.quantity || 1}</td>
          <td class="num">${price}</td>
          <td class="num">${lineTotal}</td>
        </tr>`;
    })
    .join("");

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="user-scalable=no">
  <title>Order Summary - ${escapeHtml(draft.name)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 1.5rem;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 14px;
      line-height: 1.4;
      color: #333;
      background: white;
    }
    h1 { font-size: 1.5rem; margin: 0 0 0.5rem 0; border-bottom: 2px solid #333; padding-bottom: 0.5rem; }
    h2 { font-size: 1rem; margin: 1.25rem 0 0.5rem 0; color: #555; }
    p { margin: 0 0 0.35rem 0; }
    table { width: 100%; border-collapse: collapse; margin: 0.5rem 0; }
    th, td { padding: 0.4rem 0.5rem; text-align: left; border-bottom: 1px solid #ddd; }
    th { font-weight: 600; background: #f5f5f5; }
    td.num { text-align: right; }
    .summary-row { display: flex; justify-content: space-between; padding: 0.3rem 0; }
    .summary-row.total { font-weight: bold; font-size: 1.1rem; margin-top: 0.5rem; padding-top: 0.5rem; border-top: 2px solid #333; }
    .meta { font-size: 0.85rem; color: #666; margin-top: 1.5rem; }
    @media print { body { margin: 0.75rem; } }
  </style>
</head>
<body>
  <h1>Order Summary</h1>
  <p><strong>${escapeHtml(draft.name)}</strong></p>
  <p class="meta">${escapeHtml(new Date(draft.createdAt).toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" }))}</p>

  ${customer ? `
  <h2>Customer</h2>
  <p>${escapeHtml(customer.displayName || "—")}</p>
  ${customer.email ? `<p class="meta">${escapeHtml(customer.email)}</p>` : ""}
  ${customer.phone ? `<p class="meta">${escapeHtml(customer.phone)}</p>` : ""}
  ` : ""}

  <h2>Items</h2>
  <table>
    <thead>
      <tr>
        <th>Item</th>
        <th class="num">Qty</th>
        <th class="num">Unit</th>
        <th class="num">Total</th>
      </tr>
    </thead>
    <tbody>${lineItemsHtml}
    </tbody>
  </table>

  <h2>Totals</h2>
  <div class="summary-row"><span>Subtotal</span><span>${subtotal ? escapeHtml(formatMoney(subtotal)) : "—"}</span></div>
  <div class="summary-row"><span>Tax</span><span>${tax ? escapeHtml(formatMoney(tax)) : "—"}</span></div>
  <div class="summary-row total"><span>Total</span><span>${total ? escapeHtml(formatMoney(total)) : "—"}</span></div>

  ${draft.note2 ? `
  <h2>Note</h2>
  <p>${escapeHtml(draft.note2)}</p>
  ` : ""}

  <p class="meta" style="margin-top: 2rem;">Special Orders Pro · ${escapeHtml(new Date().toLocaleString())}</p>
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
