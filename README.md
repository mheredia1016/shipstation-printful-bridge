# ShipStation → Printful Bridge v2.1

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
