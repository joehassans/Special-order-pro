import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState, useEffect } from "preact/hooks";

export default async () => {
  render(<Extension />, document.body);
};

const SPECIAL_ORDER_TAG = "special-order";

function Extension() {
  const { i18n } = shopify;
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchSpecialOrders() {
      try {
        const query = `
          query GetSpecialOrders($query: String) {
            orders(first: 50, query: $query, sortKey: CREATED_AT, reverse: true) {
              edges { node { id name createdAt customer { displayName } } }
            }
            draftOrders(first: 50, query: $query, sortKey: ID, reverse: true) {
              edges {
                node {
                  id name status createdAt customer { displayName }
                }
              }
            }
          }
        `;
        const response = await fetch("shopify:admin/api/graphql.json", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query,
            variables: { query: `tag:${SPECIAL_ORDER_TAG}` },
          }),
        });
        const data = await response.json();
        const orderNodes =
          data?.data?.orders?.edges?.map((e) => e.node) ?? [];
        let draftNodes =
          data?.data?.draftOrders?.edges?.map((e) => e.node) ?? [];
        draftNodes = draftNodes.filter((d) => d.status !== "COMPLETED");
        const combined = [...orderNodes, ...draftNodes].sort(
          (a, b) =>
            new Date(b.createdAt).getTime() -
            new Date(a.createdAt).getTime()
        );
        setOrders(combined);
      } catch (err) {
        console.error("Failed to fetch special orders:", err);
        setOrders([]);
      } finally {
        setLoading(false);
      }
    }
    fetchSpecialOrders();
  }, []);

  return (
    <s-page heading={i18n.translate("modal_heading")}>
      <s-scroll-box>
        <s-box padding="base">
          {loading ? (
            <s-text>{i18n.translate("loading")}</s-text>
          ) : orders.length === 0 ? (
            <s-text color="subdued">{i18n.translate("empty")}</s-text>
          ) : (
            <s-stack gap="base">
              {orders.map((order) => (
                <s-box
                  key={order.id}
                  padding="base"
                  borderRadius="base"
                  borderWidth="base"
                  background="subdued"
                >
                  <s-stack gap="small">
                    <s-text type="strong">{order.name}</s-text>
                    <s-text color="subdued">
                      {order.customer?.displayName || "No customer"}
                    </s-text>
                  </s-stack>
                </s-box>
              ))}
              <s-text color="subdued" type="bodySmall">
                {i18n.translate("view_admin")}
              </s-text>
            </s-stack>
          )}
        </s-box>
      </s-scroll-box>
    </s-page>
  );
}
