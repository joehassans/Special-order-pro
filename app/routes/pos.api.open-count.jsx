import { authenticate } from "../shopify.server";
import { countOpenSpecialOrders } from "../lib/special-order-list.server";

/**
 * GET /pos/api/open-count
 * Lightweight count of open (not picked up / not canceled) special orders
 * for the POS home-screen tile subtitle. Returns { count: null } when the
 * DB hasn't been seeded yet — the tile keeps its static subtitle.
 */

const CORS_HEADERS = ["Content-Type"];

export async function loader({ request }) {
  const { sessionToken, cors } = await authenticate.pos(request, {
    corsHeaders: CORS_HEADERS,
  });

  const shop = String(sessionToken.dest || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  if (!shop) {
    return cors(Response.json({ error: "Missing shop" }, { status: 401 }));
  }

  try {
    const count = await countOpenSpecialOrders(shop);
    return cors(Response.json({ ok: true, count }));
  } catch (e) {
    console.error(`[pos-open-count] failed for ${shop}:`, e);
    return cors(Response.json({ ok: false, count: null }, { status: 500 }));
  }
}
