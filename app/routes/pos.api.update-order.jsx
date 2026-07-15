import { authenticate, unauthenticated } from "../shopify.server";
import {
  setContactStatus,
  setOverallStatus,
  setItemStatus,
  setItemAttributes,
  setNote,
} from "../lib/special-order-actions.server";

/**
 * POST /pos/api/update-order
 * Body: { orderId, intent, ...fields }
 *
 * Phase 2: POS writes go through the app backend instead of hitting the
 * Admin API from the device. The server resolves line items by stable GID
 * (immune to stale positions on the device), updates the app database, and
 * mirrors the position-keyed metafields for receipts/backward compatibility.
 *
 * Intents:
 *   contactStatus   { value }
 *   overallStatus   { value }
 *   itemStatus      { lineItemId, value }
 *   itemAttributes  { lineItemId, attributes: [{key, value}] }
 *   note            { value }
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

  const { orderId, intent } = body ?? {};
  if (
    typeof orderId !== "string" ||
    !/^gid:\/\/shopify\/(Order|DraftOrder)\/\d+$/.test(orderId)
  ) {
    return respond({ error: "orderId must be an Order/DraftOrder GID" }, 400);
  }

  try {
    const { admin } = await unauthenticated.admin(shop);
    const graphql = admin.graphql;

    switch (intent) {
      case "contactStatus": {
        await setContactStatus(graphql, shop, orderId, body.value ?? "");
        return respond({ ok: true });
      }
      case "overallStatus": {
        await setOverallStatus(graphql, shop, orderId, body.value ?? "");
        return respond({ ok: true });
      }
      case "itemStatus": {
        if (typeof body.lineItemId !== "string" || !body.lineItemId) {
          return respond({ error: "lineItemId is required" }, 400);
        }
        const result = await setItemStatus(
          graphql,
          shop,
          orderId,
          body.lineItemId,
          body.value ?? ""
        );
        return respond({ ok: true, ...result });
      }
      case "itemAttributes": {
        if (typeof body.lineItemId !== "string" || !body.lineItemId) {
          return respond({ error: "lineItemId is required" }, 400);
        }
        if (!Array.isArray(body.attributes)) {
          return respond({ error: "attributes must be an array" }, 400);
        }
        const result = await setItemAttributes(
          graphql,
          shop,
          orderId,
          body.lineItemId,
          body.attributes
        );
        return respond({ ok: true, ...result });
      }
      case "note": {
        await setNote(graphql, shop, orderId, body.value ?? "");
        return respond({ ok: true });
      }
      default:
        return respond({ error: `Unknown intent: ${String(intent)}` }, 400);
    }
  } catch (e) {
    const message =
      e instanceof Error && e.message ? e.message : "Update failed.";
    console.error(`[pos-update] ${intent} failed for ${orderId} (${shop}):`, e);
    return respond({ ok: false, error: message }, 500);
  }
}
