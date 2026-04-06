import nodemailer from "nodemailer";

/**
 * Gmail SMTP transporter (Nodemailer).
 * Requires GMAIL_USER and GMAIL_APP_PASSWORD in environment.
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

  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: { user, pass },
    tls: { rejectUnauthorized: true },
  });
}
