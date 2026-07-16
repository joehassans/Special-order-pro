import { authenticate } from "../shopify.server";
import { getItemFields } from "../lib/item-fields.server";

/**
 * GET /pos/api/item-fields
 * Returns the shop's configured item detail fields (see app/settings) so
 * the POS cart editor renders store-specific fields at creation time.
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
    const fields = await getItemFields(shop);
    return cors(Response.json({ ok: true, fields }));
  } catch (e) {
    console.error(`[pos-item-fields] failed for ${shop}:`, e);
    // POS falls back to its built-in defaults.
    return cors(Response.json({ ok: false, fields: null }, { status: 500 }));
  }
}
