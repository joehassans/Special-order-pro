import prisma from "../db.server";

/**
 * Per-shop store identity for printed order summaries and customer emails.
 *
 * Shops that haven't saved a profile yet fall back to the legacy
 * hard-coded config so the original store's output is unchanged; the
 * Settings page prompts every shop to save its own details.
 */

export const LEGACY_STORE_PROFILE = {
  storeName: "Joe Hassan's",
  logoUrl: "/store-logo.png",
  address: "343 Lincoln Center, Stockton, CA 95207",
  hours: "Monday - Saturday: 10am-7pm | Sunday: 10am-5pm",
  phone: "(209) 323-4588",
  website: "joehassans.com",
  instagram: "@joehassans",
};

const FIELD_MAX = 200;

/**
 * @param {string} shop myshopify domain
 * @returns {Promise<{ storeName: string, logoUrl: string, address: string,
 *   hours: string, phone: string, website: string, instagram: string,
 *   isSaved: boolean }>}
 */
export async function getStoreProfile(shop) {
  const row = await prisma.shopProfile.findUnique({ where: { shop } });
  if (!row) return { ...LEGACY_STORE_PROFILE, isSaved: false };
  return {
    storeName: row.storeName || "",
    logoUrl: row.logoUrl || "",
    address: row.address || "",
    hours: row.hours || "",
    phone: row.phone || "",
    website: row.website || "",
    instagram: row.instagram || "",
    isSaved: true,
  };
}

/**
 * Validate a profile; returns a user-facing error string or null.
 * All fields are optional except the store name (used in email copy).
 */
export function validateStoreProfile(profile) {
  if (!String(profile.storeName || "").trim()) {
    return "Store name is required — it appears in customer emails.";
  }
  for (const [key, label] of [
    ["storeName", "Store name"],
    ["address", "Address"],
    ["hours", "Store hours"],
    ["phone", "Phone"],
    ["website", "Website"],
    ["instagram", "Instagram"],
    ["logoUrl", "Logo URL"],
  ]) {
    if (String(profile[key] || "").length > FIELD_MAX) {
      return `${label} is too long (max ${FIELD_MAX} characters).`;
    }
  }
  const logoUrl = String(profile.logoUrl || "").trim();
  if (logoUrl && !/^(https:\/\/|\/)/.test(logoUrl)) {
    return "Logo URL must start with https:// (or / for an app-hosted image).";
  }
  return null;
}

/**
 * Absolute logo URL for print/email HTML ("" when the shop has no logo).
 * App-hosted paths ("/store-logo.png") are prefixed with the app origin.
 */
export function resolveLogoUrl(profile, origin) {
  const logoUrl = String(profile?.logoUrl || "").trim();
  if (!logoUrl) return "";
  return logoUrl.startsWith("/") ? `${origin}${logoUrl}` : logoUrl;
}

/**
 * "phone | website | Instagram: @handle" line for the print header.
 */
export function buildContactLine(profile) {
  return [
    profile.phone,
    profile.website,
    profile.instagram ? `Instagram: ${profile.instagram}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

/** @param {string} shop @param {object} profile validated profile fields */
export async function saveStoreProfile(shop, profile) {
  const clean = (v) => String(v ?? "").trim() || null;
  const data = {
    storeName: clean(profile.storeName),
    address: clean(profile.address),
    hours: clean(profile.hours),
    phone: clean(profile.phone),
    website: clean(profile.website),
    instagram: clean(profile.instagram),
    logoUrl: clean(profile.logoUrl),
  };
  await prisma.shopProfile.upsert({
    where: { shop },
    create: { shop, ...data },
    update: data,
  });
}
