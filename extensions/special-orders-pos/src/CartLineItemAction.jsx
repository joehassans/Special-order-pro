import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState, useEffect } from "preact/hooks";
import {
  LINE_ITEM_PROPERTY_KEYS,
  ORDER_STATUS_OPTIONS_FOR_LINE_ITEM,
} from "./pos-line-item-attributes.js";

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
  const [brand, setBrand] = useState("");
  const [type, setType] = useState("");
  const [styleNumber, setStyleNumber] = useState("");
  const [size, setSize] = useState("");
  const [color, setColor] = useState("");
  const [dateOrdered, setDateOrdered] = useState("");
  const [orderConfirmationNumber, setOrderConfirmationNumber] = useState("");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

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

      setBrand(getProperty(lineItem, k.BRAND));
      setType(getProperty(lineItem, k.TYPE));
      setStyleNumber(getProperty(lineItem, k.STYLE));
      setSize(getProperty(lineItem, k.SIZE));
      setColor(getProperty(lineItem, k.COLOR));
      setDateOrdered(getProperty(lineItem, k.DATE_ORDERED));
      setOrderConfirmationNumber(getProperty(lineItem, k.ORDER_CONFIRMATION_NUMBER));
    } catch (err) {
      console.error("Error loading line item properties", err);
      setError(i18n.translate("cart_line_item_load_error"));
    }
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
        [k.BRAND]: brand,
        [k.TYPE]: type,
        [k.STYLE]: styleNumber,
        [k.SIZE]: size,
        [k.COLOR]: color,
        [k.DATE_ORDERED]: dateOrdered,
        [k.ORDER_CONFIRMATION_NUMBER]: orderConfirmationNumber,
      };

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
                  {/* Row 1: Brand, Type, Style #, Size */}
                  <s-stack direction="inline" gap="small" alignItems="stretch">
                    <s-box minInlineSize="23%" inlineSize="auto">
                      <s-text-field
                        label={i18n.translate("cart_line_item_brand")}
                        value={brand}
                        onInput={(e) => setBrand(e.currentTarget.value)}
                      />
                    </s-box>
                    <s-box minInlineSize="23%" inlineSize="auto">
                      <s-text-field
                        label={i18n.translate("cart_line_item_type")}
                        value={type}
                        onInput={(e) => setType(e.currentTarget.value)}
                      />
                    </s-box>
                    <s-box minInlineSize="23%" inlineSize="auto">
                      <s-text-field
                        label={i18n.translate("cart_line_item_style")}
                        value={styleNumber}
                        onInput={(e) => setStyleNumber(e.currentTarget.value)}
                      />
                    </s-box>
                    <s-box minInlineSize="23%" inlineSize="auto">
                      <s-text-field
                        label={i18n.translate("cart_line_item_size")}
                        value={size}
                        onInput={(e) => setSize(e.currentTarget.value)}
                      />
                    </s-box>
                  </s-stack>
                  {/* Row 2: Color, Item Order Date, Order Confirmation Number */}
                  <s-stack direction="inline" gap="small" alignItems="stretch">
                    <s-box minInlineSize="23%" inlineSize="auto">
                      <s-text-field
                        label={i18n.translate("cart_line_item_color")}
                        value={color}
                        onInput={(e) => setColor(e.currentTarget.value)}
                      />
                    </s-box>
                    <s-box minInlineSize="23%" inlineSize="auto">
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
                          disabled={!!saving}
                        />
                      </s-stack>
                    </s-box>
                    <s-box minInlineSize="46%" inlineSize="auto">
                      <s-text-field
                        label={i18n.translate("cart_line_item_order_confirmation")}
                        value={orderConfirmationNumber}
                        onInput={(e) =>
                          setOrderConfirmationNumber(e.currentTarget.value)
                        }
                      />
                    </s-box>
                  </s-stack>
                </s-stack>
              </s-box>
            </s-section>

            <s-section>
              <s-heading>{i18n.translate("cart_line_item_order_status_heading")}</s-heading>
              <s-box paddingBlockStart="small">
                <s-choice-list
                  values={[orderStatus]}
                  onChange={(event) => {
                    const el = /** @type {any} */ (event.currentTarget);
                    const vals = el.values ?? [];
                    const [value] = vals;
                    setOrderStatus(value ?? "Not Ordered");
                  }}
                >
                  {ORDER_STATUS_OPTIONS_FOR_LINE_ITEM.map((status) => (
                    <s-choice key={status} value={status}>
                      {status}
                    </s-choice>
                  ))}
                </s-choice-list>
              </s-box>
            </s-section>

            <s-section>
              <s-button onClick={handleSave} disabled={saving}>
                {saving
                  ? i18n.translate("cart_line_item_saving")
                  : i18n.translate("cart_line_item_save")}
              </s-button>
            </s-section>
          </s-stack>
        </s-box>
      </s-scroll-box>
    </s-page>
  );
}
