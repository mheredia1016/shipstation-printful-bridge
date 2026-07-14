# ShipStation → Printful Bridge v3.3

Production workflow:

```text
ShipStation order (Custom Field 1 = Printful)
→ Printful draft
→ Printful ships
→ Bridge reads tracking
→ ShipStation marks the order shipped
→ ShipStation notifies the connected Shopify sales channel
→ Shopify receives fulfillment and tracking
```

## Important final behavior

### Visible order number

Printful `external_id` now matches the ShipStation order number exactly:

```text
ShipStation: AEW167693
Printful: AEW167693
```

When ShipStation has multiple split records with the same order number, v3 groups them into one Printful order and remembers every underlying ShipStation order ID.

### Tracking flow

The bridge checks submitted Printful orders every `TRACKING_POLL_MINUTES`.

When tracking appears, it calls ShipStation:

```text
POST /orders/markasshipped
```

with:

```json
{
  "orderId": 123456789,
  "carrierCode": "royal_mail",
  "shipDate": "2026-07-14",
  "trackingNumber": "TRACKING",
  "notifyCustomer": false,
  "notifySalesChannel": true
}
```

`notifySalesChannel=true` is what sends the shipment/tracking from ShipStation to the connected Shopify store.

## Railway variables

```env
SHIPSTATION_API_KEY=...
SHIPSTATION_API_SECRET=...
SHIPSTATION_STORE_ID=441983
SHIPSTATION_ORDER_STATUS=awaiting_shipment
SHIPSTATION_CUSTOM_FIELD_VALUE=Printful

SHIPSTATION_NOTIFY_CUSTOMER=false
SHIPSTATION_NOTIFY_SALES_CHANNEL=true
SHIPSTATION_FALLBACK_CARRIER_CODE=other

PRINTFUL_API_TOKEN=...
PRINTFUL_MODE=draft

PRINTFUL_USE_CUSTOM_ITEMS=true
PRINTFUL_CUSTOM_PRODUCT_ID=438
PRINTFUL_FALLBACK_COLOR=Black
PRINTFUL_USE_PRODUCT_IMAGE_AS_PRINT_FILE=true
PRINTFUL_CUSTOM_FILE_ID=318537690
PRINTFUL_SKU_SOURCE=old_sku
PRINTFUL_PREFIX_TITLE_WITH_SKU=true

PRINTFUL_ORDER_SUFFIX=

PRINTFUL_REQUEST_DELAY_MS=1200
API_MAX_RETRIES=6

RUN_ON_START=true
POLL_INTERVAL_MINUTES=10
TRACKING_POLL_MINUTES=10

STATE_FILE=/data/state.json
```

## Railway persistent volume

Add a Railway volume and mount it at:

```text
/data
```

This is required so the Printful ↔ ShipStation order mapping survives deployments and restarts.

## Testing tracking

Keep `PRINTFUL_MODE=draft`.

1. Import one test order.
2. In Printful, prepare and manually confirm it.
3. When it ships, wait for the scheduled tracking poll or click **Sync Tracking** on the dashboard.
4. Check ShipStation: the order should be marked shipped with tracking.
5. Check Shopify: the fulfillment and tracking should appear through the ShipStation sales-channel notification.

Do not enable this for every order until one full tracking test reaches Shopify correctly.


## v3.1 ShipStation 429 protection

Version 3.1 adds:

- Automatic retry for ShipStation HTTP 429 responses
- `Retry-After` support
- Exponential backoff
- 15-minute cache for the ShipStation store list
- 60-second cache for `/api/status`

This reduces unnecessary API calls when refreshing the browser dashboard.

The same `API_MAX_RETRIES` variable controls retry attempts for both Printful and ShipStation:

```env
API_MAX_RETRIES=6
```

No new state file or order suffix is needed when upgrading from v3.0.


## v3.2 Printful file-library artwork

The bridge now looks up the ShipStation `old sku` in Printful's File Library.

Example:

```text
old sku: aew3507
Printful filename: aew3507.png
```

Recommended Railway variables:

```env
PRINTFUL_USE_LIBRARY_ARTWORK=true
PRINTFUL_ARTWORK_EXTENSION=.png
PRINTFUL_USE_PRODUCT_IMAGE_AS_PRINT_FILE=false
PRINTFUL_MISSING_ARTWORK_BEHAVIOR=fail
PRINTFUL_FILE_PAGE_SIZE=100
PRINTFUL_FILE_MAX_PAGES=100
```


## v3.3 comma-separated Custom Field 1 support

The importer now recognizes `Printful` as one value inside a comma-separated field.

Examples that import:

```text
Printful
Printful,PWT
PWT,Printful
PWT, Printful, UK
```

The logs also show how many orders were skipped because they were already recorded.
