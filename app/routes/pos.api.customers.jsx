import { authenticate, unauthenticated } from "../shopify.server";

/**
 * POST /pos/api/customers
 *
 * Customer lookup/creation for the POS cart special-order flow, so staff
 * never have to leave the extension to attach a customer to the sale.
 *
 * Intents:
 *   search { firstName, lastName, email, phone }
 *     → { ok, matches: [{ id, legacyId, name, email, phone, ordersCount }] }
 *   create { firstName, lastName, email, phone }
 *     → { ok, customer } | { ok: false, userErrors: [{ message }] }
 *   get    { legacyId }
 *     → { ok, customer | null }
 */

const CORS_HEADERS = ["Content-Type"];

const SEARCH_QUERY = `#graphql
  query FindCustomers($query: String!) {
    customers(first: 5, query: $query) {
      edges {
        node {
          id
          firstName
          lastName
          displayName
          email
          phone
          numberOfOrders
        }
      }
    }
  }
`;

const GET_QUERY = `#graphql
  query GetCustomer($id: ID!) {
    customer(id: $id) {
      id
      firstName
      lastName
      displayName
      email
      phone
    }
  }
`;

const CREATE_MUTATION = `#graphql
  mutation CreateCustomer($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer {
        id
        firstName
        lastName
        displayName
        email
        phone
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/** Quote a value for the customers search syntax, stripping quote chars. */
function q(value) {
  return `"${String(value).replace(/["\\]/g, "").trim()}"`;
}

function legacyIdFromGid(gid) {
  const n = Number(String(gid || "").split("/").pop());
  return Number.isFinite(n) ? n : null;
}

function toClientCustomer(node) {
  if (!node) return null;
  return {
    id: node.id,
    legacyId: legacyIdFromGid(node.id),
    name:
      node.displayName ||
      [node.firstName, node.lastName].filter(Boolean).join(" "),
    firstName: node.firstName || "",
    lastName: node.lastName || "",
    email: node.email || "",
    phone: node.phone || "",
    ordersCount:
      node.numberOfOrders != null ? Number(node.numberOfOrders) : null,
  };
}

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

  const intent = String(body?.intent || "");
  const firstName = String(body?.firstName || "").trim();
  const lastName = String(body?.lastName || "").trim();
  const email = String(body?.email || "").trim();
  const phone = String(body?.phone || "").trim();

  try {
    const { admin } = await unauthenticated.admin(shop);

    if (intent === "get") {
      const legacyId = Number(body?.legacyId);
      if (!Number.isFinite(legacyId) || legacyId <= 0) {
        return respond({ error: "legacyId required" }, 400);
      }
      const res = await admin.graphql(GET_QUERY, {
        variables: { id: `gid://shopify/Customer/${legacyId}` },
      });
      const json = await res.json();
      return respond({
        ok: true,
        customer: toClientCustomer(json.data?.customer),
      });
    }

    if (intent === "search") {
      const clauses = [];
      if (firstName && lastName) {
        clauses.push(`(first_name:${q(firstName)} AND last_name:${q(lastName)})`);
      } else if (lastName) {
        clauses.push(`last_name:${q(lastName)}`);
      } else if (firstName) {
        clauses.push(`first_name:${q(firstName)}`);
      }
      if (email) clauses.push(`email:${q(email)}`);
      const phoneDigits = phone.replace(/\D/g, "");
      if (phoneDigits.length >= 7) clauses.push(`phone:${q(phone)}`);

      if (clauses.length === 0) {
        return respond({ ok: true, matches: [] });
      }

      const res = await admin.graphql(SEARCH_QUERY, {
        variables: { query: clauses.join(" OR ") },
      });
      const json = await res.json();
      const seen = new Set();
      const matches = (json.data?.customers?.edges || [])
        .map((edge) => toClientCustomer(edge.node))
        .filter((c) => {
          if (!c || !c.legacyId || seen.has(c.legacyId)) return false;
          seen.add(c.legacyId);
          return true;
        });
      return respond({ ok: true, matches });
    }

    if (intent === "create") {
      if (!firstName || !lastName) {
        return respond(
          { ok: false, userErrors: [{ message: "First and last name are required." }] },
          400
        );
      }
      if (!email && !phone) {
        return respond(
          { ok: false, userErrors: [{ message: "A phone number or email is required." }] },
          400
        );
      }
      const input = { firstName, lastName };
      if (email) input.email = email;
      if (phone) input.phone = phone;

      const res = await admin.graphql(CREATE_MUTATION, {
        variables: { input },
      });
      const json = await res.json();
      const payload = json.data?.customerCreate;
      const userErrors = payload?.userErrors || [];
      if (userErrors.length > 0) {
        return respond({ ok: false, userErrors }, 422);
      }
      const customer = toClientCustomer(payload?.customer);
      if (!customer?.legacyId) {
        return respond(
          { ok: false, userErrors: [{ message: "Customer creation failed." }] },
          500
        );
      }
      return respond({ ok: true, customer });
    }

    return respond({ error: `Unknown intent: ${intent}` }, 400);
  } catch (e) {
    console.error(`[pos-customers] ${intent} failed for ${shop}:`, e);
    return respond({ error: "Customer request failed" }, 500);
  }
}
