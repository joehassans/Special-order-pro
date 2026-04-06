import { authenticate } from "../shopify.server";
import { sendPickupReadyNotification } from "../lib/notify-customer-ready.server";

/**
 * POST /app/api/notify-customer-ready
 * Body: { orderId: string, employeeNote?: string, confirmResend?: boolean }
 */
export async function action({ request }) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const { admin } = await authenticate.admin(request);

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const orderId = body?.orderId;
  if (!orderId || typeof orderId !== "string") {
    return Response.json({ error: "orderId is required" }, { status: 400 });
  }

  const employeeNote =
    typeof body.employeeNote === "string" ? body.employeeNote : "";
  const confirmResend = Boolean(body.confirmResend);

  try {
    const result = await sendPickupReadyNotification({
      graphql: admin.graphql.bind(admin),
      rawOrderId: orderId,
      requestOrigin: new URL(request.url).origin,
      employeeNote,
      confirmResend,
    });

    if (!result.ok && result.code === "ALREADY_SENT") {
      return Response.json(
        {
          ok: false,
          code: "ALREADY_SENT",
          previous: result.previous,
          log: result.log,
        },
        { status: 409 }
      );
    }

    return Response.json({
      ok: true,
      sentAt: result.sentAt,
      recipientEmail: result.recipientEmail,
      orderName: result.orderName,
    });
  } catch (e) {
    const status = /** @type {{ status?: number }} */ (e).status ?? 500;
    const code = /** @type {{ code?: string }} */ (e).code;
    return Response.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        code: code ?? undefined,
      },
      { status }
    );
  }
}
