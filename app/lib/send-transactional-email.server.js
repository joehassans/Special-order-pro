import { createEmailTransport } from "./email-transport.server";

const RESEND_API = "https://api.resend.com/emails";

/**
 * Send HTML email. Prefer Resend (HTTPS) on Railway — Hobby/Free block outbound SMTP.
 * Fallback: Gmail via Nodemailer (works locally; needs Pro+ on Railway for SMTP).
 *
 * @param {{ to: string; subject: string; html: string }} params
 */
export async function sendTransactionalEmail({ to, subject, html }) {
  const resendKey = process.env.RESEND_API_KEY?.trim();
  if (resendKey) {
    const from = process.env.EMAIL_FROM?.trim();
    if (!from) {
      const err = new Error(
        "EMAIL_FROM is required with RESEND_API_KEY (e.g. \"Joe Hassan's Special Orders <orders@yourdomain.com>\"). Verify the domain in Resend."
      );
      err.status = 400;
      err.code = "EMAIL_FROM_REQUIRED";
      throw err;
    }
    const res = await fetch(RESEND_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], subject, html }),
      signal: AbortSignal.timeout(25_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        typeof data.message === "string"
          ? data.message
          : JSON.stringify(data) || res.statusText;
      const err = new Error(`Resend: ${msg}`);
      err.status = 502;
      err.code = "SEND_FAILED";
      throw err;
    }
    return;
  }

  const transport = createEmailTransport();
  const fromAddr = process.env.GMAIL_USER;
  try {
    await transport.sendMail({
      from: `"Joe Hassan's Special Orders" <${fromAddr}>`,
      to,
      subject,
      html,
    });
  } catch (e) {
    throw smtpFailureAsError(e);
  }
}

/**
 * @param {unknown} e
 */
function smtpFailureAsError(e) {
  const msg = e instanceof Error ? e.message : "Failed to send email.";
  const code = /** @type {{ code?: string }} */ (e)?.code;
  if (
    code === "ETIMEDOUT" ||
    code === "ESOCKETTIMEDOUT" ||
    code === "ECONNRESET" ||
    /timeout/i.test(msg)
  ) {
    return new Error(
      `${msg} Railway blocks outbound SMTP on Hobby/Free — add RESEND_API_KEY and EMAIL_FROM (HTTPS). See .env.example. Or use Railway Pro+ for SMTP.`
    );
  }
  if (code === "EAUTH" || /Invalid login|535|authentication/i.test(msg)) {
    return new Error(
      `${msg} Use a Gmail App Password (not your normal password) for GMAIL_APP_PASSWORD.`
    );
  }
  return new Error(msg);
}
