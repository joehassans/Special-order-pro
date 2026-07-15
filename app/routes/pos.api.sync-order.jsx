import { authenticate, unauthenticated } from "../shopify.server";
import { fetchAndSyncSpecialOrderById } from "../lib/special-order-db-sync.server";

/**
 * POST /pos/api/sync-order
 * Body: { orderId: string (Order or DraftOrder GID) }
 *
 * Called by the POS extension after it writes special-order metafields so
 * the app database mirror is updated immediately (instead of waiting for
 * the next admin page load). Authenticated with the POS session token that
 * POS attaches automatically to app-domain fetches.
 */

const CORS_HEADERS = ["Content-Type"];

// Handles the CORS preflight (OPTIONS) that POS sends before the POST.
export async function loader({ request }) {
  const { cors } = await authenticate.pos(request, {
    corsHeaders: CORS_HEADERS,
  });
  return cors(new Response());
}

export async function action({ request }) {
  const { sessionToken, cors } = await authenticate.pos(request, {
    corsHeaders: CORS_HEADERS,
  });

  const respond = (body, status = 200) =>
    cors(Response.json(body, { status }));

  if (request.method !== "POST") {
    return respond({ error: "Method not allowed" }, 405);
  }

  // dest is the shop domain (may include protocol depending on token shape).
  const shop = String(sessionToken.dest || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  if (!shop) {
    return respond({ error: "Missing shop in session token" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return respond({ error: "Invalid JSON body" }, 400);
  }

  const orderId = body?.orderId;
  if (
    typeof orderId !== "string" ||
    !/^gid:\/\/shopify\/(Order|DraftOrder)\/\d+$/.test(orderId)
  ) {
    return respond({ error: "orderId must be an Order/DraftOrder GID" }, 400);
  }

  try {
    const { admin } = await unauthenticated.admin(shop);
    const record = await fetchAndSyncSpecialOrderById(
      admin.graphql,
      shop,
      orderId
    );
    return respond({ ok: true, synced: Boolean(record) });
  } catch (e) {
    console.error(`[pos-sync] failed for ${orderId} (${shop})`, e);
    return respond({ ok: false, error: "Sync failed" }, 500);
  }
}
