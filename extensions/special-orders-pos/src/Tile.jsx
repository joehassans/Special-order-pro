import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const { i18n } = shopify;
  // null = count unavailable (endpoint failed or DB not seeded yet);
  // the tile keeps its static subtitle in that case.
  const [openCount, setOpenCount] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/pos/api/open-count");
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && typeof data?.count === "number") {
          setOpenCount(data.count);
        }
      } catch {
        // Static subtitle is fine offline.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const subheading =
    openCount == null
      ? i18n.translate("tile_subheading")
      : openCount === 1
        ? i18n.translate("tile_subheading_open_one")
        : i18n.translate("tile_subheading_open", { count: openCount });

  return (
    <s-tile
      heading={i18n.translate("tile_heading")}
      subheading={subheading}
      onClick={() => shopify.action.presentModal()}
    />
  );
}
