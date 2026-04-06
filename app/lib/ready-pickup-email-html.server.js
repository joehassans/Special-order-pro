import { STORE_CONFIG, escapeHtml } from "./print-order-summary.server";

/**
 * Table-based HTML email (inline styles) for "ready for pickup" notification.
 */
export function buildReadyPickupEmailHtml({
  customerFirstName,
  orderDisplayName,
  employeeNotePlain,
  lineItems,
  totalItemQty,
  subtotalFormatted,
  taxFormatted,
  totalFormatted,
  amountPaidFormatted,
  balanceDueFormatted,
  paymentDetailsRows = [],
  logoAbsoluteUrl,
}) {
  const greetingName = escapeHtml(customerFirstName || "there");
  const orderNum = escapeHtml(orderDisplayName);
  const noteBlock =
    employeeNotePlain && String(employeeNotePlain).trim()
      ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:16px 0;border:1px solid #e0e0e0;border-radius:8px;background:#fafafa;">
          <tr><td style="padding:12px 16px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#333;">
            <strong>Message from our team</strong><br/><br/>
            ${escapeHtml(String(employeeNotePlain).trim()).replace(/\n/g, "<br/>")}
          </td></tr>
        </table>`
      : "";

  const itemRows = (lineItems || [])
    .map(
      (li) => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #e8e8e8;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#222;">${escapeHtml(li.title)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e8e8e8;text-align:center;font-family:Arial,Helvetica,sans-serif;font-size:14px;">${li.qty}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e8e8e8;text-align:right;font-family:Arial,Helvetica,sans-serif;font-size:14px;">${escapeHtml(String(li.price))}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e8e8e8;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#444;line-height:1.4;">${li.detailsHtml || "—"}</td>
    </tr>`
    )
    .join("");

  const paymentBreakdown =
    paymentDetailsRows.length > 0
      ? paymentDetailsRows
          .map(
            (r) => `
    <tr>
      <td style="padding:4px 10px;font-family:Arial,Helvetica,sans-serif;font-size:13px;">${escapeHtml(r.label)}</td>
      <td style="padding:4px 10px;text-align:right;font-family:Arial,Helvetica,sans-serif;font-size:13px;">${escapeHtml(r.amountFormatted)}</td>
    </tr>`
          )
          .join("") +
        `<tr>
      <td style="padding:6px 10px;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;">Total paid</td>
      <td style="padding:6px 10px;text-align:right;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;">${escapeHtml(amountPaidFormatted)}</td>
    </tr>`
      : `<tr>
      <td style="padding:4px 10px;font-family:Arial,Helvetica,sans-serif;font-size:13px;">Amount paid</td>
      <td style="padding:4px 10px;text-align:right;font-family:Arial,Helvetica,sans-serif;font-size:13px;">${escapeHtml(amountPaidFormatted)}</td>
    </tr>`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your order is ready</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f4;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f4f4f4;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e0e0e0;">
          <tr>
            <td style="padding:20px 24px;border-bottom:1px solid #eee;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="vertical-align:middle;">
                    <img src="${escapeHtml(logoAbsoluteUrl)}" alt="Joe Hassan's" width="180" style="display:block;max-width:180px;height:auto;border:0;" />
                  </td>
                  <td style="text-align:right;vertical-align:middle;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#555;line-height:1.5;">
                    ${escapeHtml(STORE_CONFIG.address)}<br/>
                    ${escapeHtml(STORE_CONFIG.hours)}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222;">
              <p style="margin:0 0 12px 0;">Hi ${greetingName},</p>
              <p style="margin:0 0 16px 0;font-size:16px;font-weight:bold;color:#1a1a1a;">
                Your special order is ready for pickup at Joe Hassan's Stockton!
              </p>
              <p style="margin:0 0 8px 0;">Order <strong>#${orderNum}</strong></p>
              ${noteBlock}
            </td>
          </tr>
          <tr>
            <td style="padding:0 24px 16px 24px;">
              <p style="margin:0 0 8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:#333;">Items</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #ddd;border-radius:6px;overflow:hidden;">
                <thead>
                  <tr style="background:#ececec;">
                    <th style="padding:10px 12px;text-align:left;font-family:Arial,Helvetica,sans-serif;font-size:12px;">Product</th>
                    <th style="padding:10px 12px;text-align:center;width:48px;font-family:Arial,Helvetica,sans-serif;font-size:12px;">Qty</th>
                    <th style="padding:10px 12px;text-align:right;width:72px;font-family:Arial,Helvetica,sans-serif;font-size:12px;">Price</th>
                    <th style="padding:10px 12px;text-align:left;font-family:Arial,Helvetica,sans-serif;font-size:12px;">Details</th>
                  </tr>
                </thead>
                <tbody>${itemRows}</tbody>
              </table>
              <p style="margin:12px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#444;">Total item qty: <strong>${totalItemQty}</strong></p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 24px 24px 24px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #ddd;border-radius:6px;">
                <tr>
                  <td style="padding:12px 14px;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;">Payment summary</td>
                </tr>
                <tr>
                  <td style="padding:12px 14px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                      ${paymentBreakdown}
                      <tr>
                        <td style="padding:4px 10px;font-family:Arial,Helvetica,sans-serif;font-size:13px;">Subtotal</td>
                        <td style="padding:4px 10px;text-align:right;font-family:Arial,Helvetica,sans-serif;font-size:13px;">${escapeHtml(subtotalFormatted)}</td>
                      </tr>
                      <tr>
                        <td style="padding:4px 10px;font-family:Arial,Helvetica,sans-serif;font-size:13px;">Tax</td>
                        <td style="padding:4px 10px;text-align:right;font-family:Arial,Helvetica,sans-serif;font-size:13px;">${escapeHtml(taxFormatted)}</td>
                      </tr>
                      <tr>
                        <td style="padding:8px 10px 4px 10px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;border-top:1px solid #ddd;">Total</td>
                        <td style="padding:8px 10px 4px 10px;text-align:right;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;border-top:1px solid #ddd;">${escapeHtml(totalFormatted)}</td>
                      </tr>
                      <tr>
                        <td style="padding:4px 10px;font-family:Arial,Helvetica,sans-serif;font-size:13px;">Balance due</td>
                        <td style="padding:4px 10px;text-align:right;font-family:Arial,Helvetica,sans-serif;font-size:13px;">${escapeHtml(balanceDueFormatted)}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 24px 24px 24px;border-top:1px solid #eee;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#333;text-align:center;">
              Questions? Call us at <strong>${escapeHtml(STORE_CONFIG.phone)}</strong><br/>
              <span style="font-size:12px;color:#666;">${escapeHtml(STORE_CONFIG.website)}</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
