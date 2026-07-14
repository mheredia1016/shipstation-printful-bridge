# ShipStation → Printful Bridge

This service scans ShipStation for orders whose **Custom Field 1** equals `Printful`, creates an unconfirmed Printful draft using a placeholder store variant in a selected Printful API store.

## Safety modes

- `PRINTFUL_MODE=preview` — reads and previews orders only. Nothing is created in Printful.
- `PRINTFUL_MODE=draft` — creates unconfirmed Printful orders.
- `PRINTFUL_MODE=live` — creates and confirms Printful orders. This can incur charges.

Start in `preview`.

## 1. Upload to GitHub

Upload every file in this repository, preserving the folders.

## 2. Deploy to Railway

Create a Railway project from this GitHub repository.

Add these variables:

```env
PORT=8080
SHIPSTATION_API_KEY=...
SHIPSTATION_API_SECRET=...
SHIPSTATION_ORDER_STATUS=awaiting_shipment
SHIPSTATION_STORE_ID=123456
SHIPSTATION_CUSTOM_FIELD_VALUE=Printful
SHIPSTATION_PAGE_SIZE=100
SHIPSTATION_MAX_PAGES=10

PRINTFUL_API_TOKEN=...
PRINTFUL_PLACEHOLDER_SYNC_VARIANT_ID=5394157268

PRINTFUL_MODE=preview
RUN_ON_START=true
POLL_INTERVAL_MINUTES=10

ADMIN_TOKEN=choose-a-private-password
STATE_FILE=./data/state.json
```

Do not put secrets in `.env.example` or commit a real `.env` file.

## 3. Add SKU mappings

Edit `data/mappings.csv`.

```csv
sku,printful_variant_id,front_art_url,back_art_url,active
MY-SKU-BLACK-S,4014,https://your-public-art-host.com/MY-SKU.png,,true
MY-SKU-BLACK-M,4015,https://your-public-art-host.com/MY-SKU.png,,true
```

Requirements:

- `sku` must exactly match the ShipStation item SKU, ignoring capitalization and surrounding spaces.
- `printful_variant_id` is the Printful catalog variant ID for the exact garment/color/size.
- `front_art_url` must be a publicly downloadable direct image URL.
- `back_art_url` is optional.
- `active` must be `true` for the mapping to be used.

## 4. Test

Open the Railway public URL.

The dashboard verifies the API token. If your token is store-scoped, no Store ID is required. Press **Run Now**. With `PRINTFUL_MODE=preview`, the importer only displays matching orders and mapping errors.

An order is eligible only when:

1. It belongs to `SHIPSTATION_STORE_ID`.
2. Its ShipStation status matches `SHIPSTATION_ORDER_STATUS`.
3. `advancedOptions.customField1` equals `Printful`.
4. Every item SKU has an active mapping.

## 5. Create Printful drafts

After preview results are correct, change:

```env
PRINTFUL_MODE=draft
```

Redeploy, then run one order. It will appear in Printful but remain unconfirmed.

## 6. Enable live submission

Only after draft testing:

```env
PRINTFUL_MODE=live
```

Live mode confirms orders and may charge the Printful billing method.

## Duplicate protection

Each Printful order uses:

```text
shipstation-{ShipStation order ID}
```

as its external ID. Before creating an order, the bridge checks Printful for that external ID and stores successful submissions in `data/state.json`.

For durable state on Railway, attach a persistent volume and point `STATE_FILE` to that mounted location, for example:

```env
STATE_FILE=/data/state.json
```

## Endpoints

- `GET /health`
- `GET /api/status`
- `GET /api/last-run`
- `POST /api/run`

When `ADMIN_TOKEN` is configured, send it as the `x-admin-token` header for `POST /api/run`.

## Current scope

Version 1:

- Reads ShipStation awaiting-shipment orders
- Filters Custom Field 1 = Printful
- Maps ShipStation SKUs
- Verifies the selected Printful store
- Supports preview, draft and live modes
- Prevents common duplicate submissions
- Provides a basic dashboard

Tracking updates from Printful back to ShipStation are not included in this first version. Add them only after order creation is verified.


## Finding the ShipStation Store ID

After deployment, open `/api/status`. The `shipstation.stores` section lists every connected ShipStation store with its `storeId` and `storeName`.

Set the selected value in Railway:

```env
SHIPSTATION_STORE_ID=123456
```

The importer passes this value as the ShipStation Orders API `storeId` filter, so orders from other ShipStation stores are ignored.


## Placeholder draft workflow

This version does not use SKU mappings.

Every matching ShipStation order is created in Printful with:

- The original customer shipping address
- One placeholder synced store variant
- The ShipStation order number and original line items in the gift message/notes
- `confirm=false` when `PRINTFUL_MODE=draft`

For the current ShopAEW UK placeholder:

```env
PRINTFUL_PLACEHOLDER_SYNC_VARIANT_ID=5394157268
```

The related values are:

- Store product ID: `446033521`
- Store/sync variant ID: `5394157268` — use this in the bridge
- Catalog variant ID: `11548` — do not use this for the synced placeholder workflow


## ShipStation order number matching

Printful draft orders now use the exact ShipStation `orderNumber` as the Printful `external_id`.

Example:

```text
ShipStation order number: 123456
Printful external order number: 123456
```

The internal ShipStation order ID is still retained in the notes for troubleshooting.


## Original ShipStation item details in drafts

Version 1.5 creates one placeholder line for every ShipStation line item.

Each Printful placeholder line receives an external item reference formatted as:

```text
SKU | Size | Color
```

The order gift message also includes:

- Original product title
- SKU
- Quantity
- Size
- Color
- Additional ShipStation options
- ShipStation product image URL, when available

Printful will still display the synced placeholder's own product title, mockup, Black color and Large size on the product card. Those fields belong to the synced variant and cannot be renamed without using actual synced Printful products.
