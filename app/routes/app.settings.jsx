import { useEffect, useState } from "react";
import {
  redirect,
  useActionData,
  useLoaderData,
  useRouteError,
  useSubmit,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  DEFAULT_ITEM_FIELDS,
  getItemFields,
  saveItemFields,
  validateItemFieldLabels,
} from "../lib/item-fields.server";
import {
  getStoreProfile,
  saveStoreProfile,
  validateStoreProfile,
} from "../lib/store-profile.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const [itemFields, profile] = await Promise.all([
    getItemFields(session.shop),
    getStoreProfile(session.shop),
  ]);
  return { itemFields, defaults: DEFAULT_ITEM_FIELDS, profile };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const section = String(formData.get("section") || "fields");
  const url = new URL(request.url);

  if (section === "profile") {
    let profile;
    try {
      profile = JSON.parse(String(formData.get("profile") || "{}"));
    } catch {
      return { error: "Could not read the form. Reload and try again.", section };
    }
    const error = validateStoreProfile(profile);
    if (error) return { error, section };
    await saveStoreProfile(session.shop, profile);
    return redirect(url.pathname + "?saved=profile");
  }

  let labels;
  try {
    labels = JSON.parse(String(formData.get("fields") || "[]"));
  } catch {
    return { error: "Could not read the field list. Reload and try again.", section };
  }
  labels = (Array.isArray(labels) ? labels : []).map((l) => String(l).trim());

  const error = validateItemFieldLabels(labels);
  if (error) return { error, section };

  await saveItemFields(session.shop, labels);
  return redirect(url.pathname + "?saved=fields");
};

const PROFILE_FIELDS = [
  { key: "storeName", label: "Store name", placeholder: "e.g. Joe Hassan's" },
  { key: "address", label: "Address", placeholder: "e.g. 343 Lincoln Center, Stockton, CA 95207" },
  { key: "hours", label: "Store hours", placeholder: "e.g. Mon - Sat: 10am-7pm | Sun: 10am-5pm" },
  { key: "phone", label: "Phone", placeholder: "e.g. (209) 555-0100" },
  { key: "website", label: "Website", placeholder: "e.g. mystore.com" },
  { key: "instagram", label: "Instagram", placeholder: "e.g. @mystore" },
  { key: "logoUrl", label: "Logo image URL", placeholder: "https://... (leave blank to print the store name instead)" },
];

export default function Settings() {
  const { itemFields, defaults, profile } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();

  const savedParam =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("saved")
      : null;

  const [fields, setFields] = useState(itemFields);
  const [saved, setSaved] = useState(savedParam === "fields" || savedParam === "1");
  const [profileForm, setProfileForm] = useState(profile);
  const [profileSaved, setProfileSaved] = useState(savedParam === "profile");

  useEffect(() => {
    setFields(itemFields);
  }, [itemFields]);

  useEffect(() => {
    setProfileForm(profile);
  }, [profile]);

  const setProfileValue = (key, value) => {
    setProfileSaved(false);
    setProfileForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSaveProfile = () => {
    const formData = new FormData();
    formData.set("section", "profile");
    formData.set("profile", JSON.stringify(profileForm));
    submit(formData, { method: "post" });
  };

  const fieldsError = actionData?.error && actionData.section !== "profile";
  const profileError = actionData?.error && actionData.section === "profile";

  const setFieldAt = (index, value) => {
    setSaved(false);
    setFields((prev) => prev.map((f, i) => (i === index ? value : f)));
  };
  const removeFieldAt = (index) => {
    setSaved(false);
    setFields((prev) => prev.filter((_, i) => i !== index));
  };
  const moveField = (index, delta) => {
    setSaved(false);
    setFields((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };
  const addField = () => {
    setSaved(false);
    setFields((prev) => [...prev, ""]);
  };

  const handleSave = () => {
    const formData = new FormData();
    formData.set("section", "fields");
    formData.set("fields", JSON.stringify(fields));
    submit(formData, { method: "post" });
  };

  return (
    <s-page heading="Settings" inlineSize="base">
      <s-section heading="Store information">
        <s-paragraph>
          This appears on printed order summaries and in the emails customers
          receive when their order is ready for pickup.
        </s-paragraph>

        {!profile.isSaved && (
          <s-banner tone="warning" heading="Review your store details">
            These are starter values — check them and save so your printouts
            and customer emails show your own store information.
          </s-banner>
        )}
        {profileError && (
          <s-banner tone="critical" heading="Couldn't save">
            {actionData.error}
          </s-banner>
        )}
        {profileSaved && !profileError && (
          <s-banner tone="success" heading="Saved">
            Store information updated. All printouts and customer emails use
            it from now on.
          </s-banner>
        )}

        <s-stack direction="block" gap="base">
          {PROFILE_FIELDS.map(({ key, label, placeholder }) => (
            <s-text-field
              key={key}
              label={label}
              value={profileForm[key] || ""}
              placeholder={placeholder}
              onInput={(e) => setProfileValue(key, e.target?.value ?? "")}
            />
          ))}
          <s-box>
            <s-button variant="primary" onClick={handleSaveProfile}>
              Save store information
            </s-button>
          </s-box>
        </s-stack>
      </s-section>

      <s-section heading="Item detail fields">
        <s-paragraph>
          These fields appear for every special-order item — at the register
          when an item is marked as a special order, and in the order details
          here in the app. Name them for what your store sells (for example a
          bike shop might use Frame Color and Rim Size).
        </s-paragraph>

        {fieldsError && (
          <s-banner tone="critical" heading="Couldn't save">
            {actionData.error}
          </s-banner>
        )}
        {saved && !fieldsError && (
          <s-banner tone="success" heading="Saved">
            Item fields updated. New POS special orders will use them right
            away; items created earlier keep the fields they were saved with.
          </s-banner>
        )}

        <s-stack direction="block" gap="base">
          {fields.map((label, index) => (
            <s-stack
              key={index}
              direction="inline"
              gap="small"
              alignItems="end"
            >
              <s-text-field
                label={`Field ${index + 1}`}
                value={label}
                placeholder="e.g. Frame Color"
                onInput={(e) => setFieldAt(index, e.target?.value ?? "")}
              />
              <s-button
                variant="tertiary"
                disabled={index === 0}
                onClick={() => moveField(index, -1)}
                accessibilityLabel={`Move ${label || "field"} up`}
              >
                ↑
              </s-button>
              <s-button
                variant="tertiary"
                disabled={index === fields.length - 1}
                onClick={() => moveField(index, 1)}
                accessibilityLabel={`Move ${label || "field"} down`}
              >
                ↓
              </s-button>
              <s-button
                variant="tertiary"
                tone="critical"
                disabled={fields.length <= 1}
                onClick={() => removeFieldAt(index)}
                accessibilityLabel={`Remove ${label || "field"}`}
              >
                Remove
              </s-button>
            </s-stack>
          ))}

          <s-stack direction="inline" gap="base">
            <s-button onClick={addField} disabled={fields.length >= 12}>
              Add field
            </s-button>
            <s-button
              variant="tertiary"
              onClick={() => {
                setSaved(false);
                setFields([...defaults]);
              }}
            >
              Reset to defaults
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Always included">
        <s-paragraph>
          Item Order Date and Order Confirmation Number are part of the
          ordering workflow and always appear alongside your custom fields.
        </s-paragraph>
      </s-section>

      <s-box padding="base">
        <s-button variant="primary" onClick={handleSave}>
          Save item fields
        </s-button>
      </s-box>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
