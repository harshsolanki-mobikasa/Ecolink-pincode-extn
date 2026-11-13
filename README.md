# ecolink-checkout-pincode

Checkout UI extension for EcoLinks pincode delivery gating (Shopify Plus).

## Sheet format (one file, many collections)

```csv
appliances_pincode,room-heater_pincode
848201,110094
848202,110095
```

- Column name = `{collection-handle}_pincode`
- Same CDN URL on each collection metafield `custom.pincode_sheet_url`
- Theme stores line properties `_pincode_csv_url` + `_pincode_column`

## Decision matrix

| Case | Result |
| --- | --- |
| No gated lines | Allow |
| ZIP missing / not 6 digits | Block |
| ZIP allowed in **every** gated line column | Allow |
| ZIP missing from any gated line column | Block |
| CSV fetch fail + ZIP matches `delivery_pincode` | Allow |
| CSV fetch fail + ZIP differs / missing stored | Block |
| No CSV URL + ZIP matches stored | Allow |
| No CSV URL + ZIP differs / missing | Block |

## Setup

1. Partner Dashboard: approve **network access** for checkout UI extensions
2. Upload combined CSV to Shopify Files
3. Set collection metafield `custom.pincode_sheet_url` (same URL on appliances + room-heater)
4. Checkout editor → Pincode block → paste **Default pincode CSV URL**
5. Enable **Allow this extension to block checkout**

## Deploy

```bash
cd ~/Desktop/ecolink-pincode-checkout
shopify app deploy --allow-updates
```
