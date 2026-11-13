import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useEffect, useState} from 'preact/hooks';
import {
  useBuyerJourneyIntercept,
  useExtensionCapability,
  useShippingAddress,
} from '@shopify/ui-extensions/checkout/preact';

/**
 * Checkout decision matrix (matches theme gate):
 *
 * 1. No gated lines → allow
 * 2. Invalid / missing 6-digit ZIP → block
 * 3. One CSV URL (cart attr / line / block setting), columns = {collection-handle}_pincode
 * 4. ZIP must be allowed in EVERY gated line's column (mixed cart = intersection)
 * 5. Match stored delivery_pincode + CSV ok → allow (also updates attribute)
 * 6. CSV fetch fail + ZIP matches stored → allow
 * 7. CSV fetch fail + ZIP differs / missing stored → block
 * 8. No CSV configured + ZIP matches stored → allow
 * 9. No CSV + ZIP differs / missing → block
 */

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const canBlockProgress = useExtensionCapability('block_progress');
  const shippingAddress = useShippingAddress();
  const liveZip = normalizePin(shippingAddress?.zip);

  const settings = shopify.settings?.value ?? {};
  const defaultSheetUrl = asString(settings.default_pincode_sheet_url, '');
  const attributes = shopify.attributes?.value ?? [];
  const lines = shopify.lines?.value ?? [];
  const sheetUrl = resolveSheetUrl(attributes, lines, defaultSheetUrl);
  const storedPin = normalizePin(getAttribute(attributes, 'delivery_pincode'));
  const gatedLines = collectGatedLines(lines);

  const [columnPins, setColumnPins] = useState(
    /** @type {Record<string, Set<string>> | null} */ (null),
  );
  const [sheetError, setSheetError] = useState('');
  const [productTitles, setProductTitles] = useState(
    /** @type {Record<string, string>} */ ({}),
  );

  useEffect(() => {
    let cancelled = false;

    async function loadSheet() {
      if (!sheetUrl) {
        setColumnPins(null);
        setSheetError('');
        return;
      }
      try {
        const map = await fetchColumnPinMap(sheetUrl);
        if (cancelled) return;
        setColumnPins(map);
        setSheetError('');
      } catch (error) {
        console.error(error);
        if (!cancelled) {
          setColumnPins(null);
          setSheetError(String(error?.message || error));
        }
      }
    }

    loadSheet();
    return () => {
      cancelled = true;
    };
  }, [sheetUrl]);

  useEffect(() => {
    let cancelled = false;

    async function loadProductTitles() {
      const titles = await fetchProductTitlesByVariantId(lines);
      if (!cancelled) setProductTitles(titles);
    }

    loadProductTitles();
    return () => {
      cancelled = true;
    };
  }, [lines]);

  const gatedLinesWithTitles = gatedLines.map(function (line) {
    return {
      ...line,
      title: productTitles[line.variantId] || line.title,
    };
  });

  useBuyerJourneyIntercept(async ({canBlockProgress: canBlock}) => {
    const checkoutPin = normalizePin(shopify.shippingAddress?.value?.zip);
    const liveAttributes = shopify.attributes?.value ?? [];
    const liveLines = shopify.lines?.value ?? [];
    const liveSettings = shopify.settings?.value ?? {};
    const liveDefault = asString(liveSettings.default_pincode_sheet_url, '');
    const liveSheetUrl = resolveSheetUrl(liveAttributes, liveLines, liveDefault);
    const liveStoredPin = normalizePin(getAttribute(liveAttributes, 'delivery_pincode'));
    const liveGated = collectGatedLines(liveLines);
    const titleMap = await fetchProductTitlesByVariantId(liveLines);
    const liveGatedNamed = liveGated.map(function (line) {
      return {
        ...line,
        title: titleMap[line.variantId] || line.title,
      };
    });

    if (!canBlock) {
      return {behavior: 'allow'};
    }

    // No pincode-gated products in cart
    if (!liveGatedNamed.length) {
      return {behavior: 'allow'};
    }

    if (!checkoutPin || checkoutPin.length !== 6) {
      return {
        behavior: 'block',
        reason: 'Pincode required',
        errors: [
          {
            message: 'Enter a valid 6-digit pincode to continue.',
            target: '$.cart.deliveryGroups[0].deliveryAddress.zip',
          },
        ],
      };
    }

    // One CSV, per-line column check (appliances_pincode / room-heater_pincode / …)
    if (liveSheetUrl) {
      try {
        const map = await fetchColumnPinMap(liveSheetUrl);
        const failing = findFailingLines(map, liveGatedNamed, checkoutPin);
        if (failing.length) {
          return blockNotServiceable(failing, checkoutPin);
        }

        try {
          await shopify.applyAttributeChange({
            type: 'updateAttribute',
            key: 'delivery_pincode',
            value: checkoutPin,
          });
        } catch (e) {}

        return {behavior: 'allow'};
      } catch (e) {
        // Fetch fail: allow only if ZIP still matches cart-verified pin
        if (liveStoredPin && liveStoredPin === checkoutPin) {
          return {behavior: 'allow'};
        }
        return {
          behavior: 'block',
          reason: 'Pincode verification failed',
          errors: [
            {
              message:
                'Unable to verify delivery for this pincode right now. Please try again.',
              target: '$.cart.deliveryGroups[0].deliveryAddress.zip',
            },
          ],
        };
      }
    }

    // No CSV URL configured — fall back to cart attribute match only
    if (liveStoredPin && liveStoredPin === checkoutPin) {
      return {behavior: 'allow'};
    }

    if (liveStoredPin && liveStoredPin !== checkoutPin) {
      return {
        behavior: 'block',
        reason: 'Pincode mismatch',
        errors: [
          {
            message: `Shipping pincode must match verified delivery pincode (${liveStoredPin}).`,
            target: '$.cart.deliveryGroups[0].deliveryAddress.zip',
          },
        ],
      };
    }

    return {
      behavior: 'block',
      reason: 'Pincode verification unavailable',
      errors: [
        {
          message:
            'Pincode verification is not configured. Set Default pincode CSV URL in this app block.',
        },
      ],
    };
  });

  const banner = buildBanner({
    canBlockProgress,
    sheetUrl,
    sheetError,
    storedPin,
    liveZip,
    columnPins,
    gatedLines: gatedLinesWithTitles,
  });

  return (
    <s-banner heading="Delivery check" tone={banner.tone}>
      {banner.message}
    </s-banner>
  );
}

/**
 * @param {{
 *   canBlockProgress: boolean,
 *   sheetUrl: string,
 *   sheetError: string,
 *   storedPin: string,
 *   liveZip: string,
 *   columnPins: Record<string, Set<string>> | null,
 *   gatedLines: Array<{column: string, csvUrl: string}>,
 * }} args
 */
function buildBanner(args) {
  const {
    canBlockProgress,
    sheetUrl,
    sheetError,
    storedPin,
    liveZip,
    columnPins,
    gatedLines,
  } = args;

  if (!canBlockProgress) {
    return {
      tone: 'warning',
      message:
        'Turn ON “Allow this extension to block checkout” or wrong pincodes will not be stopped.',
    };
  }

  if (!gatedLines.length) {
    return {tone: 'info', message: 'No pincode-gated products in this cart.'};
  }

  if (!sheetUrl) {
    return {
      tone: 'warning',
      message: storedPin
        ? `Only cart-verified pin ${storedPin} is allowed until Default pincode CSV URL is set.`
        : 'Set Default pincode CSV URL in this app block settings.',
    };
  }

  if (sheetError) {
    return {tone: 'critical', message: `Could not load CSV: ${sheetError}`};
  }

  if (liveZip.length === 6 && columnPins) {
    const failing = findFailingLines(columnPins, gatedLines, liveZip);
    if (failing.length) {
      return {
        tone: 'critical',
        message: formatUnavailableMessage(failing, liveZip),
      };
    }
    return {tone: 'success', message: `Pincode ${liveZip} is OK to continue.`};
  }

  if (liveZip.length === 6 && storedPin && storedPin === liveZip) {
    return {tone: 'success', message: `Pincode ${liveZip} is OK to continue.`};
  }

  if (liveZip.length === 6 && storedPin && storedPin !== liveZip) {
    return {
      tone: 'warning',
      message: `Shipping pin differs from cart (${storedPin}). Waiting for CSV check…`,
    };
  }

  return {tone: 'info', message: 'Pincode validation is active.'};
}

/**
 * @param {Array<{title: string, column: string}>} failing
 * @param {string} pin
 */
function blockNotServiceable(failing, pin) {
  return {
    behavior: 'block',
    reason: 'Pincode not serviceable',
    errors: [
      {
        message: formatUnavailableMessage(failing, pin),
        target: '$.cart.deliveryGroups[0].deliveryAddress.zip',
      },
    ],
  };
}

/**
 * @param {Array<{title: string, column?: string}>} failing
 * @param {string} pin
 */
function formatUnavailableMessage(failing, pin) {
  const titles = uniqueTitles(failing);
  const pinLabel = pin ? ` pincode ${pin}` : ' this pincode';
  if (!titles.length) {
    return `Delivery is not available for${pinLabel}. Remove unavailable items or change your pincode.`;
  }
  if (titles.length === 1) {
    return `"${titles[0]}" is not available for${pinLabel}. Remove it or change your pincode to continue.`;
  }
  const listed = titles.map((t) => `"${t}"`).join(', ');
  return `These products are not available for${pinLabel}: ${listed}. Remove them or change your pincode to continue.`;
}

/** @param {Array<{title?: string}>} failing */
function uniqueTitles(failing) {
  const seen = {};
  const out = [];
  (failing || []).forEach(function (item) {
    const title = String(item && item.title ? item.title : '').trim();
    if (!title || seen[title]) return;
    seen[title] = true;
    out.push(title);
  });
  return out;
}

/**
 * @param {Record<string, Set<string>>} map
 * @param {Array<{column: string, csvUrl: string, title: string}>} gatedLines
 * @param {string} pin
 */
function findFailingLines(map, gatedLines, pin) {
  /** @type {Array<{title: string, column: string, csvUrl: string}>} */
  const failing = [];
  for (const line of gatedLines || []) {
    const pins = resolveColumnSet(map, line.column);
    if (!pins || !pins.has(pin)) {
      failing.push(line);
    }
  }
  return failing;
}

/** @param {any} line */
function getLineTitle(line) {
  // Prefer product title saved by theme line property
  for (const attr of (line && line.attributes) || []) {
    const key = String(attr.key || '');
    const value = String(attr.value || '').trim();
    if (!value) continue;
    if (key === '_product_title' || key === 'product_title') return value;
  }

  const merchandise = line && line.merchandise ? line.merchandise : {};
  const product = merchandise.product || {};
  const productTitle = String(product.title || '').trim();
  if (productTitle) return productTitle;

  // Never use merchandise.title here — that is the variant label (e.g. "3 litre")
  const subtitle = String(merchandise.subtitle || '').trim();
  if (subtitle && subtitle.toLowerCase() !== 'default title') return subtitle;

  return 'This product';
}

/**
 * Fetch parent product titles for cart variants (checkout API only has variant title).
 * @param {Array<{merchandise?: {id?: string}}>} lines
 * @returns {Promise<Record<string, string>>}
 */
async function fetchProductTitlesByVariantId(lines) {
  /** @type {Record<string, string>} */
  const titles = {};
  const ids = [];
  const seen = {};

  (lines || []).forEach(function (line) {
    const id = String((line && line.merchandise && line.merchandise.id) || '').trim();
    if (!id || seen[id]) return;
    seen[id] = true;
    ids.push(id);
  });

  if (!ids.length || typeof shopify.query !== 'function') return titles;

  try {
    const result = await shopify.query(
      `query ProductTitles($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            product {
              title
            }
          }
        }
      }`,
      {variables: {ids}},
    );

    const nodes = (result && result.data && result.data.nodes) || [];
    nodes.forEach(function (node) {
      if (!node || !node.id) return;
      const title = String((node.product && node.product.title) || '').trim();
      if (title) titles[node.id] = title;
    });
  } catch (e) {
    console.warn('[pincode-checkout] product title query failed', e);
  }

  return titles;
}

/** @param {Array<{key?: string, value?: string}>} attributes @param {Array<{attributes?: Array<{key?: string, value?: string}>}>} lines @param {string} defaultUrl */
function resolveSheetUrl(attributes, lines, defaultUrl) {
  return String(
    getAttribute(attributes, 'pincode_csv_url') ||
      getSheetUrlFromLines(lines) ||
      defaultUrl ||
      '',
  ).trim();
}

/** @param {Array<{attributes?: Array<{key?: string, value?: string}>, merchandise?: any}>} lines */
function collectGatedLines(lines) {
  /** @type {Array<{column: string, csvUrl: string, title: string, variantId: string}>} */
  const gated = [];

  for (const line of lines || []) {
    let csvUrl = '';
    let column = '';
    for (const attr of line.attributes || []) {
      const key = String(attr.key || '');
      const value = String(attr.value || '').trim();
      if (!value) continue;
      if (key === '_pincode_csv_url' || key === 'pincode_csv_url') csvUrl = value;
      if (key === '_pincode_column' || key === 'pincode_column') column = value;
    }
    if (!csvUrl && !column) continue;
    const variantId = String(
      (line && line.merchandise && line.merchandise.id) || '',
    ).trim();
    // Keep every gated line so mixed carts name each unavailable product
    gated.push({
      csvUrl,
      column,
      variantId,
      title: getLineTitle(line),
    });
  }

  return gated;
}

/** @param {string | undefined | null} value */
function normalizePin(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 6 ? digits.slice(0, 6) : digits;
}

/** @param {unknown} value @param {string} fallback */
function asString(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/** @param {Array<{key?: string, value?: string}>} attributes @param {string} key */
function getAttribute(attributes, key) {
  const match = (attributes || []).find((item) => item?.key === key);
  return match?.value ? String(match.value) : '';
}

/** @param {Array<{attributes?: Array<{key?: string, value?: string}>}>} lines */
function getSheetUrlFromLines(lines) {
  for (const line of lines || []) {
    for (const attr of line.attributes || []) {
      if (
        (attr.key === '_pincode_csv_url' || attr.key === 'pincode_csv_url') &&
        String(attr.value || '').trim() !== ''
      ) {
        return String(attr.value).trim();
      }
    }
  }
  return '';
}

/** @param {string} value */
function normalizeHeader(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

/**
 * @param {Record<string, Set<string>>} map
 * @param {string} column
 */
function resolveColumnSet(map, column) {
  if (!map) return null;

  // No column on line → do not use merged __all__ (would mix collections)
  if (!column) return null;

  const wanted = normalizeHeader(column);
  if (map[wanted] && map[wanted].size) return map[wanted];

  const withSuffix = wanted.endsWith('_pincode') ? wanted : `${wanted}_pincode`;
  if (map[withSuffix] && map[withSuffix].size) return map[withSuffix];

  // Fail closed if the collection column is missing from the CSV
  return null;
}

/** @param {string} sheetUrl */
async function fetchColumnPinMap(sheetUrl) {
  const response = await fetch(sheetUrl);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    throw new Error('Excel not supported. Use CSV URL.');
  }

  const text = new TextDecoder('utf-8').decode(buffer);
  const rows = String(text)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  if (!rows.length) throw new Error('CSV is empty');

  const headers = splitCsvLine(rows[0]).map((h) => normalizeHeader(h));
  /** @type {Record<string, Set<string>>} */
  const map = {__all__: new Set()};
  headers.forEach((h) => {
    if (h) map[h] = new Set();
  });

  for (let i = 1; i < rows.length; i++) {
    const cells = splitCsvLine(rows[i]);
    cells.forEach((cell, idx) => {
      const header = headers[idx] || '';
      const matches = String(cell).match(/\d{6}/g);
      if (!matches) return;
      matches.forEach((pin) => {
        map.__all__.add(pin);
        if (header && map[header]) map[header].add(pin);
      });
    });
  }

  const hasColumnData = Object.keys(map).some(
    (key) => key !== '__all__' && map[key] && map[key].size > 0,
  );
  if (!hasColumnData && !map.__all__.size) {
    throw new Error('No 6-digit pincodes found in file');
  }
  return map;
}

/** @param {string} line */
function splitCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  result.push(current.trim());
  return result;
}
