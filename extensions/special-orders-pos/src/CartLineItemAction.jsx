import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState, useEffect, useMemo } from "preact/hooks";
import {
  DEFAULT_ITEM_DETAIL_FIELDS,
  LINE_ITEM_PROPERTY_KEYS,
  ORDER_STATUS_OPTIONS_FOR_LINE_ITEM,
} from "./pos-line-item-attributes.js";
import { normalizeSpecialOrderAttributeValue } from "./special-order-line-item-attributes.js";

export default async () => {
  render(<CartLineItemAction />, document.body);
};

function getProperty(lineItem, key) {
  try {
    if (!lineItem?.properties) return "";
    return lineItem.properties[key] ?? "";
  } catch {
    return "";
  }
}

function dismissModal() {
  try {
    if (typeof window !== "undefined" && typeof window.close === "function") {
      window.close();
      return;
    }
  } catch (_) {}
  const a = shopify.action;
  if (a?.closeModal) a.closeModal();
  else if (typeof a?.close === "function") a.close();
}

function CartLineItemAction() {
  const { i18n } = shopify;

  const [specialOrder, setSpecialOrder] = useState("Yes");
  const [orderStatus, setOrderStatus] = useState("Not Ordered");
  // Shop-configured item detail fields (Settings in the admin app); the
  // defaults render immediately, then swap once the shop's list loads.
  const [detailFields, setDetailFields] = useState(DEFAULT_ITEM_DETAIL_FIELDS);
  const [detailValues, setDetailValues] = useState({});
  const [dateOrdered, setDateOrdered] = useState("");
  const [orderConfirmationNumber, setOrderConfirmationNumber] = useState("");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // null until the device resolves; phone layout is the safe default.
  const [isTablet, setIsTablet] = useState(null);

  useEffect(() => {
    shopify.device
      ?.isTablet?.()
      .then(setIsTablet)
      .catch(() => setIsTablet(false));
  }, []);

  // Phone: two fields per row so inputs stay finger-sized; iPad: four.
  const fieldMinWidth = isTablet === true ? "23%" : "45%";

  /** Show 4 standard choices; if saved status is legacy (removed from modal), keep it selectable */
  const orderStatusChoices = useMemo(() => {
    const base = [...ORDER_STATUS_OPTIONS_FOR_LINE_ITEM];
    if (
      orderStatus &&
      !ORDER_STATUS_OPTIONS_FOR_LINE_ITEM.includes(orderStatus)
    ) {
      base.push(orderStatus);
    }
    return base;
  }, [orderStatus]);

  const readDetailValuesFromLineItem = (fields) => {
    const lineItem = shopify.cartLineItem;
    const values = {};
    for (const field of fields) {
      values[field] = normalizeSpecialOrderAttributeValue(
        field,
        getProperty(lineItem, field)
      );
    }
    return values;
  };

  useEffect(() => {
    try {
      const lineItem = shopify.cartLineItem;
      const k = LINE_ITEM_PROPERTY_KEYS;

      const so = getProperty(lineItem, k.SPECIAL_ORDER);
      if (so === "Yes" || so === "No") {
        setSpecialOrder(so);
      }

      const status = getProperty(lineItem, k.INITIAL_STATUS);
      if (ORDER_STATUS_OPTIONS_FOR_LINE_ITEM.includes(status)) {
        setOrderStatus(status);
      }

      setDetailValues(readDetailValuesFromLineItem(DEFAULT_ITEM_DETAIL_FIELDS));
      setDateOrdered(
        normalizeSpecialOrderAttributeValue(
          k.DATE_ORDERED,
          getProperty(lineItem, k.DATE_ORDERED)
        )
      );
      setOrderConfirmationNumber(
        normalizeSpecialOrderAttributeValue(
          k.ORDER_CONFIRMATION_NUMBER,
          getProperty(lineItem, k.ORDER_CONFIRMATION_NUMBER)
        )
      );
    } catch (err) {
      console.error("Error loading line item properties", err);
      setError(i18n.translate("cart_line_item_load_error"));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/pos/api/item-fields");
        if (!res.ok) return;
        const data = await res.json();
        const fields = Array.isArray(data?.fields)
          ? data.fields.filter((f) => typeof f === "string" && f.trim())
          : null;
        if (!cancelled && fields && fields.length > 0) {
          setDetailFields(fields);
          setDetailValues((prev) => {
            const fromItem = readDetailValuesFromLineItem(fields);
            const merged = {};
            for (const field of fields) {
              merged[field] = prev[field] || fromItem[field] || "";
            }
            return merged;
          });
        }
      } catch (err) {
        console.error("Item fields fetch failed, using defaults:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave() {
    try {
      setSaving(true);
      setError("");

      const lineItem = shopify.cartLineItem;
      const uuid = lineItem?.uuid;
      if (!uuid) {
        setError(i18n.translate("cart_line_item_no_context"));
        setSaving(false);
        return;
      }

      const k = LINE_ITEM_PROPERTY_KEYS;
      /** @type {Record<string, string>} */
      const properties = {
        [k.SPECIAL_ORDER]: specialOrder,
        [k.INITIAL_STATUS]: orderStatus,
        [k.DATE_ORDERED]: normalizeSpecialOrderAttributeValue(
          k.DATE_ORDERED,
          dateOrdered
        ),
        [k.ORDER_CONFIRMATION_NUMBER]: normalizeSpecialOrderAttributeValue(
          k.ORDER_CONFIRMATION_NUMBER,
          orderConfirmationNumber
        ),
      };
      for (const field of detailFields) {
        properties[field] = normalizeSpecialOrderAttributeValue(
          field,
          detailValues[field] ?? ""
        );
      }

      await shopify.cart.addLineItemProperties(uuid, properties);

      shopify.toast.show(i18n.translate("cart_line_item_saved_toast"));

      dismissModal();
    } catch (err) {
      console.error("Error saving line item properties", err);
      setError(i18n.translate("cart_line_item_save_error"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <s-page heading={i18n.translate("cart_line_item_page_heading")}>
      <s-scroll-box>
        <s-box padding="base">
          <s-stack direction="vertical" gap="base">
            {error && (
              <s-section>
                <s-text tone="critical">{error}</s-text>
              </s-section>
            )}

            <s-section>
              <s-heading>{i18n.translate("cart_line_item_special_order_heading")}</s-heading>
              <s-box paddingBlockStart="small">
                <s-stack direction="inline" gap="base" alignItems="center">
                  <s-switch
                    checked={specialOrder === "Yes"}
                    onChange={(event) => {
                      const t = /** @type {any} */ (event.currentTarget);
                      const checked = t.checked ?? false;
                      setSpecialOrder(checked ? "Yes" : "No");
                    }}
                  >
                    {i18n.translate("cart_line_item_special_order_switch")}
                  </s-switch>
                  <s-text tone="subdued">
                    {specialOrder === "Yes"
                      ? i18n.translate("cart_line_item_special_order_yes")
                      : i18n.translate("cart_line_item_special_order_no")}
                  </s-text>
                </s-stack>
              </s-box>
            </s-section>

            <s-section>
              <s-heading>{i18n.translate("cart_line_item_details_heading")}</s-heading>
              <s-box paddingBlockStart="small">
                <s-stack direction="vertical" gap="base">
                  {/* Store-configured detail fields; row density follows device */}
                  <s-stack direction="inline" gap="small" alignItems="stretch">
                    {detailFields.map((field) => (
                      <s-box
                        key={field}
                        minInlineSize={fieldMinWidth}
                        inlineSize="auto"
                      >
                        <s-text-field
                          label={field}
                          value={detailValues[field] ?? ""}
                          onInput={(e) =>
                            setDetailValues((prev) => ({
                              ...prev,
                              [field]: e.currentTarget.value,
                            }))
                          }
                        />
                      </s-box>
                    ))}
                  </s-stack>
                  {/* Workflow fields: matching title-above-field so both columns align */}
                  <s-stack
                    direction="inline"
                    gap="small"
                    alignItems="start"
                    inlineSize="100%"
                  >
                    <s-box
                      minInlineSize={isTablet === true ? "31%" : "45%"}
                      inlineSize="auto"
                    >
                      <s-stack gap="small-300">
                        <s-text type="strong">
                          {i18n.translate("cart_line_item_order_date")}
                        </s-text>
                        <s-date-field
                          value={dateOrdered || ""}
                          onBlur={(e) => {
                            const newVal = e.currentTarget?.value ?? "";
                            setDateOrdered(newVal);
                          }}
                          onInput={(e) => {
                            const v = e.currentTarget?.value ?? "";
                            if (v === "") setDateOrdered("");
                          }}
                          disabled={!!saving}
                        />
                        <s-button
                          variant="secondary"
                          disabled={
                            !!saving ||
                            !(dateOrdered && String(dateOrdered).trim())
                          }
                          onClick={() => setDateOrdered("")}
                        >
                          {i18n.translate("cart_line_item_clear_date")}
                        </s-button>
                      </s-stack>
                    </s-box>
                    <s-box
                      minInlineSize={isTablet === true ? "31%" : "45%"}
                      inlineSize="auto"
                    >
                      <s-stack gap="small-300">
                        <s-text type="strong">
                          {i18n.translate("cart_line_item_order_confirmation")}
                        </s-text>
                        <s-text-field
                          value={orderConfirmationNumber}
                          onInput={(e) =>
                            setOrderConfirmationNumber(e.currentTarget.value)
                          }
                        />
                      </s-stack>
                    </s-box>
                  </s-stack>
                </s-stack>
              </s-box>
            </s-section>

            <s-section>
              <s-heading>{i18n.translate("cart_line_item_order_status_heading")}</s-heading>
              <s-box paddingBlockStart="small" inlineSize="100%">
                <s-choice-list
                  values={[orderStatus]}
                  onChange={(event) => {
                    const el = /** @type {any} */ (event.currentTarget);
                    const vals = el.values ?? [];
                    const [value] = vals;
                    setOrderStatus(value ?? "Not Ordered");
                  }}
                >
                  {orderStatusChoices.map((status) => (
                    <s-choice key={status} value={status}>
                      {status}
                    </s-choice>
                  ))}
                </s-choice-list>
              </s-box>
            </s-section>

            <s-box paddingBlockStart="base" inlineSize="100%">
              <s-stack
                direction="inline"
                gap="small"
                inlineSize="100%"
                justifyContent="start"
                alignItems="stretch"
              >
                <s-box inlineSize="70%" minBlockSize="52px">
                  <s-button
                    variant="primary"
                    inlineSize="fill"
                    onClick={handleSave}
                    disabled={saving}
                  >
                    {saving
                      ? i18n.translate("cart_line_item_saving")
                      : i18n.translate("cart_line_item_save")}
                  </s-button>
                </s-box>
                <s-box inlineSize="28%" minBlockSize="52px">
                  <s-button
                    variant="secondary"
                    inlineSize="fill"
                    onClick={dismissModal}
                    disabled={saving}
                  >
                    {i18n.translate("cart_line_item_cancel")}
                  </s-button>
                </s-box>
              </s-stack>
            </s-box>
          </s-stack>
        </s-box>
      </s-scroll-box>
    </s-page>
  );
}
