import { authenticate, unauthenticated } from "../shopify.server";
import {
  getPosOrderNodes,
  refreshInBackground,
} from "../lib/special-order-list.server";

/**
 * GET /pos/api/orders
 *
 * Phase 2: the POS list reads from the app database instead of running a
 * heavy Admin API query (orders + drafts + 250 metafields each) from the
 * register. Returns node-shaped objects the POS Modal already renders.
 *
 * Responds { orders: null } when the DB has no rows yet — POS falls back
 * to its direct Shopify query while a background seed fills the DB.
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

  let nodes = null;
  try {
    nodes = await getPosOrderNodes(shop);
  } catch (e) {
    console.error(`[pos-orders] DB read failed for ${shop}:`, e);
  }

  // Keep the mirror fresh (throttled per shop) / seed it when empty.
  try {
    const { admin } = await unauthenticated.admin(shop);
    refreshInBackground(admin, shop);
  } catch (e) {
    console.error(`[pos-orders] background refresh failed for ${shop}:`, e);
  }

  return cors(Response.json({ ok: true, orders: nodes }));
}
