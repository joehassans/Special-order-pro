import prisma from "../db.server";
import { normalizeOverallOrderStatus } from "./order-status-helpers";
import {
  buildSpecialOrderRecord,
  syncSpecialOrder,
} from "./special-order-db-sync.server";

/**
 * Phase 1 step 2: the admin order list reads from the app database
 * (fast, no Shopify API round-trips) and refreshes the mirror from
 * Shopify in the background so external changes (e.g. from POS) are
 * picked up on the next load. Falls back to a live Shopify fetch when
 * the database has no rows yet for this shop.
 */

const SPECIAL_ORDER_TAG = "special-order";
const LIST_PAGE_SIZE = 50;
const LIST_MAX_PAGES = 5;
const REFRESH_MIN_INTERVAL_MS = 15_000;

const VALID_CONTACT_STATUSES = [
  "Not Contacted",
  "No Answer",
  "Left Message",
  "Spoke to Customer",
  "Notified — Ready for Pickup.",
];

const LIST_QUERY = `#graphql
  query GetSpecialOrdersAndDrafts(
    $query: String
    $ordersFirst: Int!
    $ordersAfter: String
    $draftsFirst: Int!
    $draftsAfter: String
  ) {
    orders(
      first: $ordersFirst
      after: $ordersAfter
      query: $query
      sortKey: CREATED_AT
      reverse: true
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          name
          createdAt
          note
          displayFinancialStatus
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalRefundedSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalOutstandingSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          customer {
            id
            displayName
            email
            phone
          }
          metafields(first: 250, namespace: "custom") {
            edges {
              node {
                key
                value
              }
            }
          }
          lineItems(first: 50) {
            edges {
              node {
                id
                title
                quantity
                variantTitle
                customAttributes {
                  key
                  value
                }
              }
            }
          }
        }
      }
    }
    draftOrders(
      first: $draftsFirst
      after: $draftsAfter
      query: $query
      sortKey: ID
      reverse: true
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          name
          status
          createdAt
          note2
          customer {
            id
            displayName
            email
            phone
          }
          metafields(first: 250, namespace: "custom") {
            edges {
              node {
                key
                value
              }
            }
          }
          lineItems(first: 50) {
            edges {
              node {
                id
                title
                quantity
                variant {
                  title
                }
                customAttributes {
                  key
                  value
                }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Page through special orders and open drafts on Shopify.
 * Pages of 50 keep per-query GraphQL cost identical to the original
 * single query; looping avoids silently dropping orders past 50.
 */
async function fetchSpecialOrdersFromShopify(admin) {
  const queryFilter = `tag:${SPECIAL_ORDER_TAG}`;

  const orders = [];
  const drafts = [];
  let ordersCursor = null;
  let draftsCursor = null;
  let ordersDone = false;
  let draftsDone = false;

  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    if (ordersDone && draftsDone) break;

    const response = await admin.graphql(LIST_QUERY, {
      variables: {
        query: queryFilter,
        // Request 1 (not 0) for an exhausted connection: `first` must be
        // positive. The extra row is already in our list, so skip its edges.
        ordersFirst: ordersDone ? 1 : LIST_PAGE_SIZE,
        ordersAfter: ordersCursor,
        draftsFirst: draftsDone ? 1 : LIST_PAGE_SIZE,
        draftsAfter: draftsCursor,
      },
    });
    const json = await response.json();

    if (!ordersDone) {
      const conn = json.data?.orders;
      orders.push(...(conn?.edges?.map((edge) => edge.node) ?? []));
      ordersCursor = conn?.pageInfo?.endCursor ?? null;
      ordersDone = !conn?.pageInfo?.hasNextPage;
    }
    if (!draftsDone) {
      const conn = json.data?.draftOrders;
      drafts.push(...(conn?.edges?.map((edge) => edge.node) ?? []));
      draftsCursor = conn?.pageInfo?.endCursor ?? null;
      draftsDone = !conn?.pageInfo?.hasNextPage;
    }
  }

  return { orders, drafts };
}

function itemStatusWithAttributeFallback(item) {
  if (item.status) return item.status;
  const attrs = Array.isArray(item.attributes) ? item.attributes : [];
  const orderStatus = attrs.find((a) => a?.key === "Order Status" && a?.value);
  if (orderStatus) return orderStatus.value;
  const initialStatus = attrs.find(
    (a) => a?.key === "Initial Status" && a?.value
  );
  if (initialStatus) return initialStatus.value;
  return "Not set";
}

/**
 * Map one record ({ ...SpecialOrder fields, items: [...] }) to the row
 * shape the list UI renders. Used identically for DB rows and for
 * freshly fetched Shopify records so both paths render the same.
 */
function toListRow(record) {
  const items = record.items || [];
  const orderStatuses = items.length
    ? items.map((item) => ({
        title: item.title || "Item",
        status: itemStatusWithAttributeFallback(item),
      }))
    : [{ title: "Item", status: "Not set" }];

  const contactStatus = VALID_CONTACT_STATUSES.includes(
    String(record.contactStatus ?? "").trim()
  )
    ? String(record.contactStatus).trim()
    : "Not Contacted";

  const createdAt = record.shopifyCreatedAt
    ? new Date(record.shopifyCreatedAt).toISOString()
    : new Date(0).toISOString();

  return {
    id: record.shopifyId,
    name: record.name,
    customerName: record.customerName || "No customer",
    customerPhone: record.customerPhone || "",
    customerEmail: record.customerEmail || "",
    orderStatuses,
    paymentStatus: record.paymentStatus || "Not Paid",
    contactStatus,
    overallOrderStatus: record.overallStatus
      ? normalizeOverallOrderStatus(record.overallStatus)
      : "Order Pending",
    createdAt,
    createdDateLabel: new Date(createdAt).toLocaleDateString(),
  };
}

/** Open orders first; Picked Up second; Canceled last; newest first within each group. */
function sortListRows(rows) {
  const tier = (row) => {
    if (row.overallOrderStatus === "Order Canceled") return 2;
    if (row.overallOrderStatus === "Picked Up - Sale Complete") return 1;
    return 0;
  };
  return rows.sort((a, b) => {
    const diff = tier(a) - tier(b);
    if (diff !== 0) return diff;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

async function loadListRowsFromDb(shop) {
  const records = await prisma.specialOrder.findMany({
    where: { shop },
    include: { items: { orderBy: { position: "asc" } } },
  });
  if (records.length === 0) return null;

  // Hide drafts that completed (converted to a real order): either linked
  // explicitly by the webhook or marked COMPLETED by the background refresh.
  const convertedDraftIds = new Set(
    records
      .map((r) => r.convertedFromDraftId)
      .filter((id) => typeof id === "string" && id.length > 0)
  );
  const visible = records.filter((r) => {
    if (r.kind !== "DRAFT_ORDER") return true;
    if (r.shopifyStatus === "COMPLETED") return false;
    if (convertedDraftIds.has(r.shopifyId)) return false;
    return true;
  });

  return sortListRows(visible.map(toListRow));
}

async function fetchSyncAndBuildRows(admin, shop) {
  const { orders, drafts } = await fetchSpecialOrdersFromShopify(admin);

  const records = [
    ...orders.map((node) => ({ node, kind: "ORDER" })),
    ...drafts.map((node) => ({ node, kind: "DRAFT_ORDER" })),
  ];

  // Sync everything (including COMPLETED drafts, so their status lands in
  // the DB and they stay hidden from future DB reads). Batched so a large
  // first-run seed doesn't flood the connection pool.
  const BATCH = 8;
  for (let i = 0; i < records.length; i += BATCH) {
    await Promise.all(
      records.slice(i, i + BATCH).map(({ node, kind }) =>
        syncSpecialOrder(shop, node, kind).catch((e) => {
          console.error(
            `[special-order-list] sync failed for ${node?.id}:`,
            e instanceof Error ? e.message : e
          );
        })
      )
    );
  }

  const rows = [
    ...orders.map((node) => {
      const rec = buildSpecialOrderRecord(node, "ORDER");
      return toListRow({ ...rec.order, items: rec.items });
    }),
    ...drafts
      .filter((node) => node.status !== "COMPLETED")
      .map((node) => {
        const rec = buildSpecialOrderRecord(node, "DRAFT_ORDER");
        return toListRow({ ...rec.order, items: rec.items });
      }),
  ];

  return sortListRows(rows);
}

/** Per-shop guard so overlapping page loads don't stack refreshes. */
const refreshState = new Map();

function refreshInBackground(admin, shop) {
  const state = refreshState.get(shop) || { running: false, lastRun: 0 };
  const now = Date.now();
  if (state.running || now - state.lastRun < REFRESH_MIN_INTERVAL_MS) return;

  refreshState.set(shop, { running: true, lastRun: now });
  fetchSyncAndBuildRows(admin, shop)
    .catch((e) => {
      console.error(
        `[special-order-list] background refresh failed for ${shop}:`,
        e instanceof Error ? e.message : e
      );
    })
    .finally(() => {
      refreshState.set(shop, { running: false, lastRun: Date.now() });
    });
}

/**
 * Rows for the admin order list. DB-first with stale-while-revalidate;
 * live Shopify fetch (which also seeds the DB) when the DB is empty.
 */
export async function getSpecialOrderListRows(admin, shop) {
  let rows = null;
  try {
    rows = await loadListRowsFromDb(shop);
  } catch (e) {
    console.error(
      `[special-order-list] DB read failed for ${shop}, falling back to Shopify:`,
      e instanceof Error ? e.message : e
    );
  }

  if (rows) {
    refreshInBackground(admin, shop);
    return { rows, source: "db" };
  }

  rows = await fetchSyncAndBuildRows(admin, shop);
  return { rows, source: "shopify" };
}
