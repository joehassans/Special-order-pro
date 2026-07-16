import { authenticate } from "../shopify.server";
import { buildOrderSummaryPrintHtml } from "../lib/order-summary-print-html.server";
import { getStoreProfile } from "../lib/store-profile.server";

/**
 * Unified print route for both draft orders and orders.
 * GET /print?id=gid://shopify/DraftOrder/123
 * GET /print?id=gid://shopify/Order/123
 */
export async function loader({ request }) {
  const { admin, cors, session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const id = url.searchParams.get("id")?.trim();

  try {
    const html = await buildOrderSummaryPrintHtml({
      admin,
      requestUrl: request.url,
      id,
      profile: await getStoreProfile(session.shop),
    });
    return cors(
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    );
  } catch (e) {
    const status = e.status ?? 500;
    return cors(new Response(e.message || "Error", { status }));
  }
}
