import dns from "node:dns";
import nodemailer from "nodemailer";

/** Prefer IPv4 for smtp.gmail.com — some hosts hang on IPv6, tripping Railway's ~60s edge idle timeout. */
dns.setDefaultResultOrder?.("ipv4first");

/** Fail fast so the HTTP response returns before Railway/proxy idle limits (~60s). */
const SMTP_TIMEOUT_MS = 15_000;

/**
 * Gmail SMTP transporter (Nodemailer).
 * Requires GMAIL_USER and GMAIL_APP_PASSWORD in environment.
 *
 * Optional: GMAIL_SMTP_PORT=465 (implicit secure) or 587 (STARTTLS, default).
 */
export function createEmailTransport() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    const err = new Error(
      "Email is not configured: set GMAIL_USER and GMAIL_APP_PASSWORD."
    );
    err.code = "EMAIL_NOT_CONFIGURED";
    throw err;
  }

  const port = Number(process.env.GMAIL_SMTP_PORT || 587);
  const secure = port === 465;

  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port,
    secure,
    auth: { user, pass },
    tls: { rejectUnauthorized: true },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
    pool: true,
    maxConnections: 1,
    maxMessages: 5,
  });
}
