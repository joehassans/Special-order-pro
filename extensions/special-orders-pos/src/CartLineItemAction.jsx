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

/** Read the numeric customer id already attached to the POS cart, if any. */
function getCartCustomerId() {
  try {
    const sig = shopify.cart?.current;
    const cart = sig?.value ?? sig;
    const id = cart?.customer?.id;
    return typeof id === "number" && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function CartLineItemAction() {
  const { i18n } = shopify;

  // Customer attached to the cart (or chosen/created in this modal).
  // A special order can't be saved without one — that's the whole point:
  // no more special orders with nobody to call.
  const [cartCustomer, setCartCustomer] = useState(null);
  const [custFirstName, setCustFirstName] = useState("");
  const [custLastName, setCustLastName] = useState("");
  const [custEmail, setCustEmail] = useState("");
  const [custPhone, setCustPhone] = useState("");
  // Possible existing customers found by name/email/phone before creating.
  const [customerMatches, setCustomerMatches] = useState(null);
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

  // If the cart already has a customer, the requirement is satisfied —
  // load their details so staff can see who the sale belongs to.
  useEffect(() => {
    const legacyId = getCartCustomerId();
    if (!legacyId) return;
    let cancelled = false;
    setCartCustomer({ legacyId, name: "" });
    (async () => {
      try {
        const res = await fetch("/pos/api/customers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ intent: "get", legacyId }),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && data?.customer) setCartCustomer(data.customer);
      } catch (err) {
        console.error("Cart customer lookup failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
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

  async function postCustomers(body) {
    const res = await fetch("/pos/api/customers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      // Non-JSON error responses are handled by the callers via data == null.
    }
    return { ok: res.ok, data };
  }

  /**
   * Attach a customer to the POS cart and reflect them in the form.
   * POS devices can silently drop a setCustomer for a customer created
   * moments ago (local cache not synced yet), so verify and retry once.
   * Even if the attach doesn't stick, the hidden `_Customer ID` line
   * property lets the backend link the customer when the order is created.
   */
  async function attachCustomer(customer) {
    await shopify.cart.setCustomer({ id: customer.legacyId });
    if (getCartCustomerId() !== customer.legacyId) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      if (getCartCustomerId() !== customer.legacyId) {
        try {
          await shopify.cart.setCustomer({ id: customer.legacyId });
        } catch (err) {
          console.error("Retry setCustomer failed:", err);
        }
      }
    }
    setCartCustomer(customer);
    setCustFirstName(customer.firstName || "");
    setCustLastName(customer.lastName || "");
    setCustEmail(customer.email || "");
    setCustPhone(customer.phone || "");
    setCustomerMatches(null);
  }

  /** Staff confirmed a duplicate match — use the existing Shopify customer. */
  async function chooseExistingCustomer(match) {
    try {
      setSaving(true);
      setError("");
      await attachCustomer(match);
      await saveLineItemProperties(match);
    } catch (err) {
      console.error("Error attaching existing customer", err);
      setError(i18n.translate("cart_line_item_save_error"));
      setSaving(false);
    }
  }

  /** Staff said the matches aren't the same person — create a new customer. */
  async function createNewCustomer() {
    try {
      setSaving(true);
      setError("");
      setCustomerMatches(null);
      const { data } = await postCustomers({
        intent: "create",
        firstName: custFirstName,
        lastName: custLastName,
        email: custEmail,
        phone: custPhone,
      });
      if (!data?.ok || !data?.customer?.legacyId) {
        const msg = (data?.userErrors || [])
          .map((e) => e.message)
          .join(" ");
        setError(
          msg || i18n.translate("cart_line_item_customer_create_failed")
        );
        setSaving(false);
        return;
      }
      await attachCustomer(data.customer);
      await saveLineItemProperties(data.customer);
    } catch (err) {
      console.error("Error creating customer", err);
      setError(i18n.translate("cart_line_item_customer_create_failed"));
      setSaving(false);
    }
  }

  async function handleSave() {
    try {
      setSaving(true);
      setError("");
      setCustomerMatches(null);

      // State updates inside this run aren't visible to the closure, so
      // track the customer to link in a local variable.
      let linkedCustomer = cartCustomer;

      // A special order must have a customer before it can be saved.
      if (!cartCustomer) {
        const first = custFirstName.trim();
        const last = custLastName.trim();
        const email = custEmail.trim();
        const phone = custPhone.trim();

        if (!first || !last || (!email && !phone)) {
          setError(i18n.translate("cart_line_item_customer_required_error"));
          setSaving(false);
          return;
        }

        // Duplicate check: same name, email, or phone already in Shopify.
        const { data } = await postCustomers({
          intent: "search",
          firstName: first,
          lastName: last,
          email,
          phone,
        });
        const matches = Array.isArray(data?.matches) ? data.matches : [];
        if (matches.length > 0) {
          setCustomerMatches(matches);
          setSaving(false);
          return;
        }

        const created = await postCustomers({
          intent: "create",
          firstName: first,
          lastName: last,
          email,
          phone,
        });
        if (!created.data?.ok || !created.data?.customer?.legacyId) {
          const msg = (created.data?.userErrors || [])
            .map((e) => e.message)
            .join(" ");
          setError(
            msg || i18n.translate("cart_line_item_customer_create_failed")
          );
          setSaving(false);
          return;
        }
        await attachCustomer(created.data.customer);
        linkedCustomer = created.data.customer;
      }

      await saveLineItemProperties(linkedCustomer);
    } catch (err) {
      console.error("Error saving line item properties", err);
      setError(i18n.translate("cart_line_item_save_error"));
      setSaving(false);
    }
  }

  async function saveLineItemProperties(customer = null) {
    try {
      const lineItem = shopify.cartLineItem;
      const uuid = lineItem?.uuid;
      if (!uuid) {
        setError(i18n.translate("cart_line_item_no_context"));
        setSaving(false);
        return;
      }

      const k = LINE_ITEM_PROPERTY_KEYS;
      /** @type {Record<string, string>} */
      // Filling out this modal always marks the line as a special order.
      const properties = {
        [k.SPECIAL_ORDER]: "Yes",
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

      // Hidden linkage (underscore keys never render anywhere): lets the
      // orders/create webhook attach the customer to the order even if the
      // POS device dropped the cart-level setCustomer.
      const linkedCustomer = customer || cartCustomer;
      if (linkedCustomer?.legacyId) {
        properties["_Customer ID"] = String(linkedCustomer.legacyId);
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
              <s-heading>
                {i18n.translate("cart_line_item_customer_heading")}
              </s-heading>
              <s-box paddingBlockStart="small">
                {cartCustomer ? (
                  <s-stack direction="vertical" gap="small-300">
                    <s-text type="strong">
                      {i18n.translate("cart_line_item_customer_on_cart", {
                        name:
                          cartCustomer.name ||
                          `#${cartCustomer.legacyId}`,
                      })}
                    </s-text>
                    {(cartCustomer.email || cartCustomer.phone) && (
                      <s-text tone="subdued">
                        {[cartCustomer.email, cartCustomer.phone]
                          .filter(Boolean)
                          .join(" · ")}
                      </s-text>
                    )}
                    <s-text tone="subdued">
                      {i18n.translate("cart_line_item_customer_change_note")}
                    </s-text>
                  </s-stack>
                ) : (
                  <s-stack direction="vertical" gap="base">
                    <s-stack
                      direction="inline"
                      gap="small"
                      alignItems="stretch"
                    >
                      <s-box minInlineSize={fieldMinWidth} inlineSize="auto">
                        <s-text-field
                          label={i18n.translate("first_name")}
                          value={custFirstName}
                          onInput={(e) =>
                            setCustFirstName(e.currentTarget.value)
                          }
                          disabled={!!saving}
                        />
                      </s-box>
                      <s-box minInlineSize={fieldMinWidth} inlineSize="auto">
                        <s-text-field
                          label={i18n.translate("last_name")}
                          value={custLastName}
                          onInput={(e) =>
                            setCustLastName(e.currentTarget.value)
                          }
                          disabled={!!saving}
                        />
                      </s-box>
                      <s-box minInlineSize={fieldMinWidth} inlineSize="auto">
                        <s-text-field
                          label={i18n.translate("phone_label")}
                          value={custPhone}
                          onInput={(e) => setCustPhone(e.currentTarget.value)}
                          disabled={!!saving}
                        />
                      </s-box>
                      <s-box minInlineSize={fieldMinWidth} inlineSize="auto">
                        <s-text-field
                          label={i18n.translate("email_label")}
                          value={custEmail}
                          onInput={(e) => setCustEmail(e.currentTarget.value)}
                          disabled={!!saving}
                        />
                      </s-box>
                    </s-stack>
                    {customerMatches && customerMatches.length > 0 && (
                      <s-stack direction="vertical" gap="small">
                        <s-text type="strong">
                          {i18n.translate(
                            "cart_line_item_customer_match_prompt"
                          )}
                        </s-text>
                        {customerMatches.map((match) => (
                          <s-box
                            key={match.legacyId}
                            padding="small"
                            border="base"
                            borderRadius="base"
                          >
                            <s-stack direction="vertical" gap="small-300">
                              <s-text type="strong">{match.name}</s-text>
                              {(match.email || match.phone) && (
                                <s-text tone="subdued">
                                  {[match.email, match.phone]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </s-text>
                              )}
                              <s-button
                                variant="primary"
                                disabled={!!saving}
                                onClick={() => chooseExistingCustomer(match)}
                              >
                                {i18n.translate(
                                  "cart_line_item_customer_use_existing"
                                )}
                              </s-button>
                            </s-stack>
                          </s-box>
                        ))}
                        <s-button
                          variant="secondary"
                          disabled={!!saving}
                          onClick={createNewCustomer}
                        >
                          {i18n.translate(
                            "cart_line_item_customer_create_new"
                          )}
                        </s-button>
                      </s-stack>
                    )}
                  </s-stack>
                )}
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
