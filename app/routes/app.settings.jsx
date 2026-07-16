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

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const itemFields = await getItemFields(session.shop);
  return { itemFields, defaults: DEFAULT_ITEM_FIELDS };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  let labels;
  try {
    labels = JSON.parse(String(formData.get("fields") || "[]"));
  } catch {
    return { error: "Could not read the field list. Reload and try again." };
  }
  labels = (Array.isArray(labels) ? labels : []).map((l) => String(l).trim());

  const error = validateItemFieldLabels(labels);
  if (error) return { error };

  await saveItemFields(session.shop, labels);

  const url = new URL(request.url);
  return redirect(url.pathname + "?saved=1");
};

export default function Settings() {
  const { itemFields, defaults } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();

  const [fields, setFields] = useState(itemFields);
  const [saved, setSaved] = useState(
    typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("saved") === "1"
  );

  useEffect(() => {
    setFields(itemFields);
  }, [itemFields]);

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
    formData.set("fields", JSON.stringify(fields));
    submit(formData, { method: "post" });
  };

  return (
    <s-page heading="Settings" inlineSize="base">
      <s-section heading="Item detail fields">
        <s-paragraph>
          These fields appear for every special-order item — at the register
          when an item is marked as a special order, and in the order details
          here in the app. Name them for what your store sells (for example a
          bike shop might use Frame Color and Rim Size).
        </s-paragraph>

        {actionData?.error && (
          <s-banner tone="critical" heading="Couldn't save">
            {actionData.error}
          </s-banner>
        )}
        {saved && !actionData?.error && (
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
          Save
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
