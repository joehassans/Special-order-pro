import { authenticate } from "../shopify.server";
import { buildOrderSummaryPrintHtml } from "../lib/order-summary-print-html.server";

/**
 * JSON API for embedded admin: same HTML as /print, for in-app preview modal.
 * GET /app/print-order-summary?id=...
 */
export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const id = url.searchParams.get("id")?.trim();

  try {
    const html = await buildOrderSummaryPrintHtml({
      admin,
      requestUrl: request.url,
      id,
    });
    return Response.json({ html });
  } catch (e) {
    const status = e.status ?? 500;
    return Response.json({ error: e.message || "Error" }, { status });
  }
}
