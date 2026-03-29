import "@shopify/ui-extensions/preact";
import { render } from "preact";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const { i18n } = shopify;
  return (
    <s-button onClick={() => shopify.action.presentModal()}>
      {i18n.translate("cart_line_item_menu_label")}
    </s-button>
  );
}
