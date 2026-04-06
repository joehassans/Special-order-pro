import {
  normalizePrintOrderId,
  buildLineItems,
  getPaymentStatusFromOrder,
  buildPaymentDetailsRows,
} from "./order-summary-print-html.server";
import { STORE_CONFIG } from "./print-order-summary.server";
import { createEmailTransport } from "./email-transport.server";
import { buildReadyPickupEmailHtml } from "./ready-pickup-email-html.server";

export const PICKUP_NOTIFICATION_LOG_KEY = "pickup_notification_log";
export const CONTACT_STATUS_NOTIFIED_READY =
  "Notified — Ready for Pickup.";
export const NOTIFICATION_TYPE_EMAIL_READY = "email_ready_pickup";

/**
 * @param {unknown} e
 */
function smtpFailureMessage(e) {
  const msg = e instanceof Error ? e.message : "Failed to send email.";
  const code = /** @type {{ code?: string }} */ (e)?.code;
  if (
    code === "ETIMEDOUT" ||
    code === "ESOCKETTIMEDOUT" ||
    code === "ECONNRESET" ||
    /timeout/i.test(msg)
  ) {
    return `${msg} Try setting GMAIL_SMTP_PORT=465 on the server, confirm the Gmail App Password, and check Railway logs.`;
  }
  if (code === "EAUTH" || /Invalid login|535|authentication/i.test(msg)) {
    return `${msg} Use a Gmail App Password (not your normal password) for GMAIL_APP_PASSWORD.`;
  }
  return msg;
}

const METAFIELDS_SET = `#graphql
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id key value }
      userErrors { field message }
    }
  }
`;

function parsePickupLog(metafields) {
  const e = metafields?.edges?.find(
    (x) => x?.node?.key === PICKUP_NOTIFICATION_LOG_KEY
  );
  if (!e?.node?.value) return [];
  try {
    const arr = JSON.parse(e.node.value);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function formatMoney(money) {
  if (!money) return "—";
  const amt = parseFloat(money.amount).toFixed(2);
  return money.currencyCode === "USD"
    ? `$${amt}`
    : `${money.currencyCode} ${amt}`;
}

const GET_ORDER = `#graphql
  query GetOrderForPickupEmail($id: ID!) {
    order(id: $id) {
      id
      name
      createdAt
      displayFinancialStatus
      subtotalPriceSet { shopMoney { amount currencyCode } }
      totalTaxSet { shopMoney { amount currencyCode } }
      totalPriceSet { shopMoney { amount currencyCode } }
      totalOutstandingSet { shopMoney { amount currencyCode } }
      transactions(first: 50) {
        edges {
          node {
            status
            kind
            gateway
            formattedGateway
            accountNumber
            manualPaymentGateway
            amountSet { shopMoney { amount currencyCode } }
          }
        }
      }
      metafields(first: 250, namespace: "custom") {
        edges { node { key value } }
      }
      customer {
        firstName
        displayName
        email
        phone
        defaultAddress {
          address1
          address2
          city
          province
          zip
          country
          formatted(withName: false, withCompany: false)
        }
      }
      lineItems(first: 100) {
        edges {
          node {
            title
            quantity
            variantTitle
            originalUnitPriceSet { shopMoney { amount currencyCode } }
            customAttributes { key value }
          }
        }
      }
    }
  }
`;

const GET_DRAFT = `#graphql
  query GetDraftOrderForPickupEmail($id: ID!) {
    draftOrder(id: $id) {
      id
      name
      createdAt
      subtotalPriceSet { shopMoney { amount currencyCode } }
      totalTaxSet { shopMoney { amount currencyCode } }
      totalPriceSet { shopMoney { amount currencyCode } }
      metafields(first: 250, namespace: "custom") {
        edges { node { key value } }
      }
      customer {
        firstName
        displayName
        email
        phone
        defaultAddress {
          address1
          address2
          city
          province
          zip
          country
          formatted(withName: false, withCompany: false)
        }
      }
      lineItems(first: 100) {
        edges {
          node {
            title
            quantity
            variant { title }
            originalUnitPriceSet { shopMoney { amount currencyCode } }
            customAttributes { key value }
          }
        }
      }
    }
  }
`;

/**
 * @param {import('@shopify/shopify-app-react-router/server').AdminApiContext['graphql']} graphql
 * @param {string} rawOrderId
 * @param {string} requestOrigin - e.g. https://xxx.ngrok.io for absolute logo URL
 * @param {string} [employeeNote]
 * @param {boolean} [confirmResend]
 */
export async function sendPickupReadyNotification({
  graphql,
  rawOrderId,
  requestOrigin,
  employeeNote = "",
  confirmResend = false,
}) {
  const id = normalizePrintOrderId(rawOrderId);
  if (!id) {
    const err = new Error("Missing or invalid order id");
    err.status = 400;
    throw err;
  }

  const origin = new URL(requestOrigin || "https://localhost").origin;
  const logoAbsoluteUrl = `${origin}${STORE_CONFIG.logoUrl}`;

  const isDraft = id.includes("DraftOrder");

  if (isDraft) {
    const res = await graphql(GET_DRAFT, { variables: { id } });
    const json = await res.json();
    if (json.errors?.length) {
      const err = new Error(json.errors.map((e) => e.message).join("; "));
      err.status = 500;
      throw err;
    }
    const draft = json.data?.draftOrder;
    if (!draft) {
      const err = new Error("Draft order not found");
      err.status = 404;
      throw err;
    }

    const metafields = draft.metafields || { edges: [] };
    const existingLog = parsePickupLog(metafields);
    if (existingLog.length > 0 && !confirmResend) {
      return {
        ok: false,
        code: "ALREADY_SENT",
        previous: existingLog[existingLog.length - 1],
        log: existingLog,
      };
    }

    const email = String(draft.customer?.email || "").trim();
    if (!email) {
      const err = new Error("No customer email on file for this order.");
      err.status = 400;
      err.code = "NO_EMAIL";
      throw err;
    }

    const attrsByIndex = {};
    metafields.edges.forEach((e) => {
      const k = e?.node?.key;
      if (k?.startsWith("lineitem_") && k?.endsWith("_attributes")) {
        const idx = parseInt(k.slice(9, -11), 10) - 1;
        if (!isNaN(idx)) {
          try {
            const parsed = JSON.parse(e.node.value);
            if (Array.isArray(parsed)) attrsByIndex[idx] = parsed;
          } catch {
            /* ignore */
          }
        }
      }
    });

    const rawLineItems = draft.lineItems?.edges?.map((e) => e.node) ?? [];
    const lineItems = buildLineItems(
      rawLineItems,
      attrsByIndex,
      (li) => li.variant?.title,
      formatMoney
    );

    const subtotal = draft.subtotalPriceSet?.shopMoney;
    const tax = draft.totalTaxSet?.shopMoney;
    const total = draft.totalPriceSet?.shopMoney;

    const orderDisplayName = draft.name || "—";
    const firstName =
      String(draft.customer?.firstName || "").trim() ||
      String(draft.customer?.displayName || "there").split(/\s+/)[0] ||
      "there";

    const html = buildReadyPickupEmailHtml({
      customerFirstName: firstName,
      orderDisplayName: orderDisplayName.replace(/^#/, ""),
      employeeNotePlain: employeeNote,
      lineItems,
      totalItemQty: lineItems.reduce((s, li) => s + li.qty, 0),
      subtotalFormatted: subtotal ? formatMoney(subtotal) : "—",
      taxFormatted: tax ? formatMoney(tax) : "—",
      totalFormatted: total ? formatMoney(total) : "—",
      amountPaidFormatted: "—",
      balanceDueFormatted: total ? formatMoney(total) : "—",
      paymentDetailsRows: [],
      logoAbsoluteUrl,
    });

    const subject = `Your special order is ready — ${orderDisplayName}`;

    const transport = createEmailTransport();
    const fromAddr = process.env.GMAIL_USER;
    try {
      await transport.sendMail({
        from: `"Joe Hassan's Special Orders" <${fromAddr}>`,
        to: email,
        subject,
        html,
      });
    } catch (e) {
      const err = new Error(smtpFailureMessage(e));
      err.status = 502;
      err.code = "SEND_FAILED";
      throw err;
    }

    const sentAt = new Date().toISOString();
    const entry = {
      sentAt,
      recipientEmail: email,
      type: NOTIFICATION_TYPE_EMAIL_READY,
      ...(String(employeeNote).trim()
        ? { employeeNote: String(employeeNote).trim() }
        : {}),
    };
    const newLog = [...existingLog, entry];

    const metaRes = await graphql(METAFIELDS_SET, {
      variables: {
        metafields: [
          {
            ownerId: id,
            namespace: "custom",
            key: PICKUP_NOTIFICATION_LOG_KEY,
            value: JSON.stringify(newLog),
            type: "json",
          },
          {
            ownerId: id,
            namespace: "custom",
            key: "contact_status",
            value: CONTACT_STATUS_NOTIFIED_READY,
            type: "single_line_text_field",
          },
        ],
      },
    });
    const metaJson = await metaRes.json();
    const uErr = metaJson.data?.metafieldsSet?.userErrors ?? [];
    if (uErr.length > 0) {
      const err = new Error(
        uErr.map((e) => e.message).join(", ") ||
          "Failed to save notification log."
      );
      err.status = 500;
      throw err;
    }

    return {
      ok: true,
      sentAt,
      recipientEmail: email,
      orderName: orderDisplayName,
    };
  }

  const res = await graphql(GET_ORDER, { variables: { id } });
  const json = await res.json();
  if (json.errors?.length) {
    const err = new Error(json.errors.map((e) => e.message).join("; "));
    err.status = 500;
    throw err;
  }
  const order = json.data?.order;
  if (!order) {
    const err = new Error("Order not found");
    err.status = 404;
    throw err;
  }

  const metafields = order.metafields || { edges: [] };
  const existingLog = parsePickupLog(metafields);
  if (existingLog.length > 0 && !confirmResend) {
    return {
      ok: false,
      code: "ALREADY_SENT",
      previous: existingLog[existingLog.length - 1],
      log: existingLog,
    };
  }

  const email = String(order.customer?.email || "").trim();
  if (!email) {
    const err = new Error("No customer email on file for this order.");
    err.status = 400;
    err.code = "NO_EMAIL";
    throw err;
  }

  const attrsByIndex = {};
  metafields.edges.forEach((e) => {
    const k = e?.node?.key;
    if (k?.startsWith("lineitem_") && k?.endsWith("_attributes")) {
      const idx = parseInt(k.slice(9, -11), 10) - 1;
      if (!isNaN(idx)) {
        try {
          const parsed = JSON.parse(e.node.value);
          if (Array.isArray(parsed)) attrsByIndex[idx] = parsed;
        } catch {
          /* ignore */
        }
      }
    }
  });

  const rawLineItems = order.lineItems?.edges?.map((e) => e.node) ?? [];
  const lineItems = buildLineItems(
    rawLineItems,
    attrsByIndex,
    (li) => li.variantTitle,
    formatMoney
  );

  const subtotal = order.subtotalPriceSet?.shopMoney;
  const tax = order.totalTaxSet?.shopMoney;
  const total = order.totalPriceSet?.shopMoney;
  const outstanding = order.totalOutstandingSet?.shopMoney;

  let amountPaid = null;
  if (total && outstanding) {
    const totalAmt = parseFloat(total.amount);
    const outstandingAmt = parseFloat(outstanding.amount);
    amountPaid = {
      amount: (totalAmt - outstandingAmt).toFixed(2),
      currencyCode: total.currencyCode,
    };
  }

  const paymentDetailsRows = buildPaymentDetailsRows(
    order.transactions,
    formatMoney
  );

  const orderDisplayName = order.name || "—";
  const firstName =
    String(order.customer?.firstName || "").trim() ||
    String(order.customer?.displayName || "there").split(/\s+/)[0] ||
    "there";

  const html = buildReadyPickupEmailHtml({
    customerFirstName: firstName,
    orderDisplayName: orderDisplayName.replace(/^#/, ""),
    employeeNotePlain: employeeNote,
    lineItems,
    totalItemQty: lineItems.reduce((s, li) => s + li.qty, 0),
    subtotalFormatted: subtotal ? formatMoney(subtotal) : "—",
    taxFormatted: tax ? formatMoney(tax) : "—",
    totalFormatted: total ? formatMoney(total) : "—",
    amountPaidFormatted: amountPaid ? formatMoney(amountPaid) : "—",
    balanceDueFormatted: outstanding ? formatMoney(outstanding) : "—",
    paymentDetailsRows,
    logoAbsoluteUrl,
  });

  const subject = `Your special order is ready — ${orderDisplayName}`;

  const transport = createEmailTransport();
  const fromAddr = process.env.GMAIL_USER;
  try {
    await transport.sendMail({
      from: `"Joe Hassan's Special Orders" <${fromAddr}>`,
      to: email,
      subject,
      html,
    });
  } catch (e) {
    const err = new Error(smtpFailureMessage(e));
    err.status = 502;
    err.code = "SEND_FAILED";
    throw err;
  }

  const sentAt = new Date().toISOString();
  const entry = {
    sentAt,
    recipientEmail: email,
    type: NOTIFICATION_TYPE_EMAIL_READY,
    ...(String(employeeNote).trim()
      ? { employeeNote: String(employeeNote).trim() }
      : {}),
  };
  const newLog = [...existingLog, entry];

  const metaRes = await graphql(METAFIELDS_SET, {
    variables: {
      metafields: [
        {
          ownerId: id,
          namespace: "custom",
          key: PICKUP_NOTIFICATION_LOG_KEY,
          value: JSON.stringify(newLog),
          type: "json",
        },
        {
          ownerId: id,
          namespace: "custom",
          key: "contact_status",
          value: CONTACT_STATUS_NOTIFIED_READY,
          type: "single_line_text_field",
        },
      ],
    },
  });
  const metaJson = await metaRes.json();
  const uErr = metaJson.data?.metafieldsSet?.userErrors ?? [];
  if (uErr.length > 0) {
    const err = new Error(
      uErr.map((e) => e.message).join(", ") || "Failed to save notification log."
    );
    err.status = 500;
    throw err;
  }

  return {
    ok: true,
    sentAt,
    recipientEmail: email,
    orderName: orderDisplayName,
  };
}
