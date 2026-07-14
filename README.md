# ShipStation → Printful Bridge v2.6

This version imports ShipStation orders into Printful as unconfirmed drafts.

## Matching rules

An order is imported only when:

- It belongs to `SHIPSTATION_STORE_ID`
- Its status matches `SHIPSTATION_ORDER_STATUS`
- Custom Field 1 equals `SHIPSTATION_CUSTOM_FIELD_VALUE`

## Important Printful order ID behavior

Each Printful external order ID is unique:

```text
{ShipStation order number}-{ShipStation order ID}{optional suffix}
```

Example:

```text
AEW167693-1430365419-TEST4
AEW167693-1430365424-TEST4
```

This prevents split ShipStation records with the same order number from colliding in Printful.

The original ShipStation order number still appears in the Printful gift subject and notes.

## Railway variables for immediate testing

```env
PORT=8080

SHIPSTATION_API_KEY=...
SHIPSTATION_API_SECRET=...
SHIPSTATION_STORE_ID=441983
SHIPSTATION_ORDER_STATUS=awaiting_shipment
SHIPSTATION_CUSTOM_FIELD_VALUE=Printful

PRINTFUL_API_TOKEN=...
PRINTFUL_PLACEHOLDER_SYNC_VARIANT_ID=5394157268
PRINTFUL_MODE=draft

PRINTFUL_ORDER_SUFFIX=-TEST4
STATE_FILE=./data/state-test4.json

RUN_ON_START=true
POLL_INTERVAL_MINUTES=10
ADMIN_TOKEN=choose-a-private-password
```

Use a new suffix and a new state filename each time you intentionally re-import the same old ShipStation orders during testing.

## After testing

For future production orders, remove the suffix:

```env
PRINTFUL_ORDER_SUFFIX=
STATE_FILE=./data/state.json
```

Keep:

```env
PRINTFUL_MODE=draft
```

unless you intentionally want Printful to confirm and charge orders automatically.

## Draft information

Each real ShipStation item becomes one Printful placeholder line.

The external item reference includes:

```text
Product title | SKU | Size | Color
```

The Printful gift message includes:

- Original ShipStation order number
- Internal ShipStation order ID
- Product title
- SKU
- Quantity
- Size
- Color
- Product image URL
- Backend Product Info
- Old SKU
- Type of Garment

Blank-SKU add-on lines such as `Shop10`, `AEW_89588`, or numeric-only references are ignored.


## v2.1 custom-item title/SKU test

Set these Railway variables:

```env
PRINTFUL_USE_CUSTOM_ITEMS=true
PRINTFUL_CUSTOM_CATALOG_VARIANT_ID=11548
PRINTFUL_CUSTOM_FILE_ID=318537690

PRINTFUL_ORDER_SUFFIX=-CUSTOMTEST1
STATE_FILE=./data/state-customtest1.json
PRINTFUL_MODE=draft
```

In this mode, each Printful order line is sent as a custom catalog item with:

- `name` = actual ShipStation product title
- `sku` = actual ShipStation SKU
- `external_id` = title, SKU, size and color
- `variant_id` = 11548
- print file ID = 318537690

This is a test. Keep orders in draft and inspect one before confirming. The file ID is the placeholder artwork already attached to the placeholder product. Do not confirm a draft until the displayed product and print file are verified.


## v2.2 correct visible size

Printful displays size and color from the selected catalog variant. Version 2.2 fetches all variants for the configured catalog product and chooses the matching size for each ShipStation item.

Use:

```env
PRINTFUL_USE_CUSTOM_ITEMS=true
PRINTFUL_CUSTOM_PRODUCT_ID=438
PRINTFUL_CUSTOM_COLOR=Black
PRINTFUL_CUSTOM_FILE_ID=318537690

PRINTFUL_ORDER_SUFFIX=-SIZETEST1
STATE_FILE=./data/state-sizetest1.json
PRINTFUL_MODE=draft
```

Supported ShipStation size forms include:

```text
Small → S
Medium → M
Large → L
X-Large → XL
XX-Large → 2XL
XXX-Large → 3XL
XXXX-Large → 4XL
XXXXX-Large → 5XL
```

The product title and SKU remain custom, while Printful's visible Size field now comes from the matching Gildan 5000 catalog variant.


## v2.3 legacy SKU display

Version 2.3 reads the ShipStation line-item option named `old sku`.

Recommended Railway settings:

```env
PRINTFUL_SKU_SOURCE=old_sku
PRINTFUL_PREFIX_TITLE_WITH_SKU=true

PRINTFUL_ORDER_SUFFIX=-SKUTEST1
STATE_FILE=./data/state-skutest1.json
PRINTFUL_MODE=draft
```

With those settings, a product appears in Printful like:

```text
AEW4226 • Darby Allin - X T-Shirt - X-Large
SKU: AEW4226
Size: XL
Color: Black
```

Supported SKU modes:

```text
old_sku  → AEW4226
shopify  → 7582314-4
both     → AEW4226 (7582314-4)
```

When `old sku` is missing, the bridge falls back to the current ShipStation SKU.


## v2.4 Shopify/ShipStation preview image test

Version 2.4 adds the ShipStation line item's `imageUrl` as a Printful file with:

```json
{
  "type": "preview",
  "url": "https://cdn.shopify.com/..."
}
```

The existing placeholder file remains the only `default` print file.

Recommended test variables:

```env
PRINTFUL_USE_SHIPSTATION_PREVIEW=true
PRINTFUL_ORDER_SUFFIX=-IMAGETEST1
STATE_FILE=./data/state-imagetest1.json
PRINTFUL_MODE=draft
```

Expected result:

- Actual ShipStation/Shopify mockup used as the draft preview image, if Printful honors custom preview files
- Actual title
- Old SKU
- Correct size
- Correct color
- Placeholder artwork retained as the printable file

Keep the order in draft and inspect **Print files** before confirming. The Shopify mockup must appear as `preview`, not `default`.


## v2.5 actual color + Shopify mockup thumbnail

Version 2.5:

- Reads the ordered `Color`/`Colour` from ShipStation
- Reads `Size` or `Size Property`
- Selects the matching Printful catalog variant by both color and size
- Uses the Shopify/ShipStation product image as the `default` print file when enabled
- Prefixes titles with `⚠ REVIEW REQUIRED -`
- Keeps orders as drafts

Recommended Railway variables:

```env
PRINTFUL_USE_CUSTOM_ITEMS=true
PRINTFUL_CUSTOM_PRODUCT_ID=438
PRINTFUL_FALLBACK_COLOR=Black

PRINTFUL_USE_PRODUCT_IMAGE_AS_PRINT_FILE=true
PRINTFUL_USE_SHIPSTATION_PREVIEW=false
PRINTFUL_REVIEW_PREFIX=⚠ REVIEW REQUIRED - 

PRINTFUL_SKU_SOURCE=old_sku
PRINTFUL_PREFIX_TITLE_WITH_SKU=true

PRINTFUL_ORDER_SUFFIX=-COLORIMAGETEST1
STATE_FILE=./data/state-colorimagetest1.json
PRINTFUL_MODE=draft
```

Example:

```text
ShipStation:
Color: Sapphire
Size Property: Small

Printful:
Color: Sapphire
Size: S
```

Important: the Shopify mockup is intentionally being sent as the actual default print file in this mode. Do not confirm an order until the correct production artwork replaces it.


## v2.6 Printful-safe external IDs

Printful rejected IDs such as:

```text
AEW166919-1429224596-COLORIMAGETEST1
```

Version 2.6 now creates short, safe IDs using the unique ShipStation order ID:

```text
SS1429224596T2
```

Recommended Railway variables:

```env
PRINTFUL_EXTERNAL_ID_PREFIX=SS
PRINTFUL_ORDER_SUFFIX=T2
STATE_FILE=./data/state-t2.json
PRINTFUL_MODE=draft
```

The original ShipStation order number remains visible in:

```text
Gift subject: ShipStation Order AEW166919
Gift message: ShipStation Order Number: AEW166919
```

The item title remains clean:

```text
AEW1198 • Young Bucks - Skull Kick T-Shirt - Small
```

Use:

```env
PRINTFUL_REVIEW_PREFIX=
```

to avoid adding warning text to the visible product title.
