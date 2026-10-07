# ShipStation → Printful Bridge v3.10

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


## v3.4 fix for removed Printful `/files` endpoint

Printful permanently removed the endpoint that listed the entire File Library.

Version 3.4 no longer calls `/files`.

Artwork resolution now works in this order:

1. Read `/data/artwork-map.json`.
2. Scan files attached to existing Printful store products and match `old-sku.png`.
3. Use the configured missing-artwork behavior.

Recommended variables:

```env
ARTWORK_MAP_FILE=/data/artwork-map.json
PRINTFUL_PRODUCT_SCAN_MAX_PAGES=100
PRINTFUL_MISSING_ARTWORK_BEHAVIOR=fail
```

### Manually add an artwork file ID

Send:

```http
POST /api/artwork-map
Content-Type: application/json
x-admin-token: YOUR_ADMIN_TOKEN
```

```json
{
  "sku": "aew3507",
  "fileId": 318537690
}
```

The mapping is saved on the Railway volume and survives redeployments.

View mappings at:

```text
/api/artwork-map
```

Files that exist only as unattached File Library items cannot be discovered through the current Printful API. Attach them to a store product once, or add their file IDs to the persistent artwork map.


## v3.5 rollback to Shopify mockup workflow

This version disables Printful File Library artwork mapping.

It uses the Shopify/ShipStation product image as the Printful default file again.

Recommended Railway variables:

```env
PRINTFUL_USE_LIBRARY_ARTWORK=false
PRINTFUL_USE_PRODUCT_IMAGE_AS_PRINT_FILE=true
PRINTFUL_MISSING_ARTWORK_BEHAVIOR=mockup
```

All other production features remain:

- Exact visible ShipStation order number in Printful
- Grouping split ShipStation records by order number
- Actual title
- Old SKU
- Correct size
- Correct color
- `Printful,PWT` Custom Field support
- Persistent Railway volume state
- Printful tracking back to ShipStation
- ShipStation sales-channel notification back to Shopify
- ShipStation and Printful 429 retry handling


## v3.6 browser-synced Printful artwork map

The Printful dashboard requires your browser cookie and CSRF token, so the
library scan runs inside your logged-in browser.

The included browser helper:

1. Scans `get-directory-files` page by page.
2. Keeps exact active production PNG filenames only.
3. Ignores `-1`, `-2`, mockup, JPG, and inactive files.
4. Sends the finished map directly to Railway.
5. Saves it to `/data/artwork-map.json`.

Railway variables:

```env
ADMIN_TOKEN=choose-a-long-private-value
PRINTFUL_USE_ARTWORK_MAP=true
ARTWORK_MAP_FILE=/data/artwork-map.json

# Keep the mockup as a fallback when a SKU is not yet mapped.
PRINTFUL_USE_LIBRARY_ARTWORK=false
PRINTFUL_USE_PRODUCT_IMAGE_AS_PRINT_FILE=true
```

Run `printful-browser-sync.txt` from the Console while logged into the
Printful Library page.

The bridge uses the synced production file ID first. When no mapping exists,
it falls back to the Shopify mockup.


## v3.7 dedicated Printful shipment tracking

The tracking sync now calls Printful's dedicated shipment endpoint:

```text
GET /v2/orders/{printfulOrderId}/shipments
```

It reads:

```text
tracking_number
carrier
service
shipment_status
shipped_at
tracking_url
```

and sends the shipment to ShipStation using:

```text
POST /orders/markasshipped
```

with:

```text
notifyCustomer = SHIPSTATION_NOTIFY_CUSTOMER
notifySalesChannel = SHIPSTATION_NOTIFY_SALES_CHANNEL
```

The old embedded `order.shipments` logic remains as a fallback.

No new state file is required. Keep using the existing Railway volume state file.


## v3.8 shipment_sent webhook

Polling did not expose shipments for the legacy-created Printful orders, so
v3.8 uses Printful's shipment webhook as the primary tracking path.

Flow:

```text
Printful shipment_sent
→ POST /webhooks/printful
→ order.external_id matches ShipStation order number
→ bridge loads /data state mapping
→ ShipStation /orders/markasshipped
→ notifySalesChannel=true
→ Shopify receives fulfillment/tracking
```

### Railway variables

```env
PRINTFUL_STORE_ID=18450657
PRINTFUL_WEBHOOK_BASE_URL=https://YOUR-RAILWAY-URL
PRINTFUL_WEBHOOK_SECRET=
PRINTFUL_WEBHOOK_PUBLIC_KEY=
```

### Setup

After deploying v3.8, call:

```text
POST /api/setup-printful-webhook
```

with the normal `x-admin-token` header.

You may also send:

```json
{
  "baseUrl": "https://YOUR-RAILWAY-URL"
}
```

Printful returns a `public_key` and `secret_key`.

Save them in Railway:

```env
PRINTFUL_WEBHOOK_PUBLIC_KEY=...
PRINTFUL_WEBHOOK_SECRET=...
```

Then redeploy. The secret is used to verify the
`x-pf-webhook-signature` HMAC-SHA256 signature against the raw request body.

The old scheduled tracking sync remains available as a fallback, but new
shipments should reach ShipStation immediately through the webhook.


## v3.9 self-healing tracking webhooks

If a Printful shipment webhook arrives for an order missing from
`/data/bridge-state.json`, the bridge now searches ShipStation directly
using the exact Printful external order number, rebuilds the state mapping,
then marks the recovered ShipStation order record(s) shipped and notifies
the sales channel.

ShipStation's order-number filter is starts-with, so v3.9 performs an exact
comparison before updating anything.


## v3.10 multiple Custom Field 1 values

Use:

```env
SHIPSTATION_CUSTOM_FIELD_VALUE=Printful,PrintfulEU
```

Accepted examples:

```text
Printful
PrintfulEU
Printful,PWT
PrintfulEU,PWT
PWT,Printful
PWT,PrintfulEU
```

The same multi-token matching is also used by webhook state recovery.
\n\n## Synced Printful product pilot (v3.9.0)\n\nThis build can test one SKU against an existing configured product in the Printful store.\nThe matching item is created with `sync_variant_id`, so Printful reuses the product's saved garment and print files. Other SKUs continue through the existing custom-item flow.\n\nRailway variables for the first test:\n\n```env\nPRINTFUL_SYNCED_PRODUCT_TEST_SKU=aew6099\nPRINTFUL_SYNCED_PRODUCT_TEST_NAME=New Level Basic Tee\nPRINTFUL_SYNCED_PRODUCT_FALLBACK=true\n```\n\nKeep `PRINTFUL_MODE=draft`. After deployment, open `/api/synced-product-test` (with the admin token if configured). The endpoint should list the Printful sync product ID and each resolved Black/size sync variant.\n\nIf the synced product cannot be found or the ordered size cannot be matched, `PRINTFUL_SYNCED_PRODUCT_FALLBACK=true` keeps the existing custom-item behavior instead of failing the order.\n

## v3.11 targeted existing-draft reprocess test

Adds a manual admin-only endpoint that updates one existing Printful draft in place from the current ShipStation order and current synced-product pilot logic.

POST `/api/reprocess-order` with JSON:

```json
{"orderNumber":"AEW178603"}
```

If ADMIN_TOKEN is configured, include `x-admin-token` as usual. The endpoint refuses to create a new Printful order and refuses to modify an order unless its current Printful status is `draft` or `failed`.


## v3.12 automatic synced-product matching

Create new products in the connected Printful store with this name:

`OLD-SKU | PRODUCT NAME`

Example:

`aew6099 | The New Level - Level Up T-Shirt`

Matching priority is Old SKU first, then current ShipStation SKU. After the
product is found, the bridge matches the order's color and size and uses the
existing Printful `sync_variant_id`, so the saved garment and artwork are reused.

If there is no exact SKU-prefix product match, the existing custom unsynced
draft behavior remains unchanged. Ambiguous or missing variants also fall back
instead of guessing.

The old aew6099 pilot remains enabled for backward compatibility until its
existing Printful product is renamed to the new convention.


## v3.13 automatic Printful catalog refresh

The synced-product catalog is cached for 10 minutes by default.

Set:

`PRINTFUL_PRODUCT_CACHE_MINUTES=10`

When an incoming Old SKU is not found in the cached product list, the bridge now
forces an immediate fresh `/store/products` read from Printful and retries once.
This means newly-created products named `OLD-SKU | PRODUCT NAME` can be used
without restarting or redeploying Railway.


## v3.11 — auto-confirm fully synced Printful orders

Optional Railway variable:

```env
PRINTFUL_AUTO_CONFIRM_SYNCED=true
```

When enabled, the bridge confirms a Printful Draft/Failed order only when
**every line item** in the generated payload uses an existing
`sync_variant_id`.

- 100% synced items -> confirm automatically and submit for fulfillment.
- Any custom/catalog/artwork fallback item -> leave the whole order as Draft.
- Existing Printful drafts found by `external_id` are also eligible for
  auto-confirm if every generated item is synced.
- The switch defaults to `false`.

Confirming a Printful order can charge the configured Printful billing method.


## v3.15 — newest-first catch-up fix

The uploaded live source was scanning `awaiting_shipment` orders by
`OrderDate ASC` and stopping at `SHIPSTATION_MAX_PAGES`. With a large backlog,
newer Printful orders could therefore sit beyond the scanned pages.

v3.15 changes the normal scan to newest-first by default:

```env
SHIPSTATION_SCAN_NEWEST_FIRST=true
SHIPSTATION_PAGE_DELAY_MS=1500
```

Keep a sufficiently large page size/max-page window, for example:

```env
SHIPSTATION_PAGE_SIZE=500
SHIPSTATION_MAX_PAGES=20
API_MAX_RETRIES=8
```

The newest orders are now examined on page 1 instead of after the oldest
Awaiting Shipment backlog. Page requests are spaced by 1.5 seconds, and 429
backoff can wait up to 120 seconds.

A single-order endpoint is also available:

```text
POST /api/import-order
{"orderNumber":"AEW203891"}
```

It uses an exact ShipStation order-number lookup and still enforces Awaiting
Shipment plus the configured Printful Custom Field 1 values.


## v3.16 — safe size-only synced variant matching

Some synced Printful products, including youth products, expose their store
variant names as only `XS`, `S`, `M`, `L`, `XL` even when ShipStation contains
a color such as `Black`.

The matcher still tries strict color + size first. If that fails, it may use
a size-only synced match only when:

1. the Printful synced product's variant descriptors contain no attributes
   beyond recognized size tokens; and
2. exactly one synced variant matches the requested normalized size.

Products whose Printful variant descriptors expose color or another attribute
do not use this fallback.

Expected example:

```text
[SYNCED PRODUCT SIZE-ONLY MATCH] aew6180 | black / M -> M |
Product variants expose size only; color safely ignored.
```

This produces a `sync_variant_id`, so an otherwise fully synced order remains
eligible for `PRINTFUL_AUTO_CONFIRM_SYNCED=true`.


## v3.17 — full descriptor size-only fix

Printful store variants may be returned as full descriptors such as:

```text
aew6180 | Death Riders - Professionals Youth T-Shirt / XS
aew6180 | Death Riders - Professionals Youth T-Shirt / S
aew6180 | Death Riders - Professionals Youth T-Shirt / M
```

v3.16 incorrectly treated the product-title words as variant attributes.
v3.17 evaluates only the portion after the final `/` when determining whether
the synced product is size-only.

A size-only fallback is still allowed only when every synced variant suffix is
a recognized size and exactly one variant matches the ordered normalized size.
A product with suffixes such as `Black / M` or `White / M` will not use this
fallback.


## v3.18 — state-file recovery and atomic persistence

This release addresses startup failures such as:

```text
SyntaxError: Unexpected non-whitespace character after JSON
at JSON.parse
at loadState
```

The Railway volume is not deleted.

On load, if `bridge-state.json` contains valid JSON followed by accidental
extra data, the bridge:

1. preserves the original bytes as a timestamped `.corrupt-...bak` file;
2. extracts the first complete valid JSON object;
3. validates it;
4. atomically rewrites the live state file; and
5. continues using the recovered Printful/ShipStation mappings.

Future saves are serialized inside the Node process and written to a temporary
file first. The temporary file is re-read and JSON-validated before an atomic
rename replaces the live state file.

If no complete valid JSON object can be recovered, the bridge deliberately
does not replace the live state with an empty state. The corrupted backup is
preserved and the error remains visible for manual recovery.


## v3.19 — verified production artwork for automatically matched products

For an automatic old-SKU match, the bridge no longer submits only
`sync_variant_id`, because that makes Printful inherit whatever files are
currently attached to that sync variant.

Instead:

1. the synced Printful product identifies the correct catalog/blank variant;
2. the exact old SKU is looked up in `/data/artwork-map.json`;
3. the order item is created with that catalog `variant_id`;
4. its `files` array contains only the mapped Printful File Library ID as the
   default production file;
5. the item is marked internally as production-ready and may auto-confirm.

The internal production-ready marker is non-enumerable and is not included in
the JSON sent to Printful.

If an automatically matched product has no verified artwork-map entry, the
order is rejected rather than falling back to a ShipStation/mockup image.
This is deliberate production safety behavior.


## v3.20 — bounded automatic catch-up

This release is designed to recover older eligible ShipStation orders without
trying to process the whole backlog in one burst.

Recommended variables:

```env
CATCHUP_ENABLED=true
CATCHUP_BATCH_SIZE=25
SHIPSTATION_GLOBAL_DELAY_MS=1500
SHIPSTATION_PAGE_DELAY_MS=3000
POLL_INTERVAL_MINUTES=15
API_MAX_RETRIES=10
SHIPSTATION_PAGE_SIZE=500
SHIPSTATION_MAX_PAGES=20
```

Each scheduled run scans eligible orders newest-first, removes orders already
recorded as submitted/shipped in bridge state, and attempts at most 25
unresolved orders. Because successful/error results are persisted after each
order, subsequent scheduled runs naturally continue through the remaining
unresolved backlog rather than re-creating completed orders.

Before creating an order the bridge still performs the Printful external-ID
lookup. Existing Printful orders produce a `[DUPLICATE GUARD]` log and are not
created again.

ShipStation requests now share a serialized minimum-delay throttle in addition
to page delay and 429 Retry-After/backoff handling.

Printful automatic product discovery may force-refresh the store product
catalog at most once per import run. SKUs still absent after that refresh are
negative-cached for the rest of the run, preventing repeated full catalog
refreshes from one catch-up batch.

Exact single-order imports remain available and are not subject to the catch-up
batch size.


## v3.21 — early-stopping ShipStation pagination

Catch-up no longer fetches every configured ShipStation page before applying the
25-order batch limit. After each page, eligible records are grouped by order
number and compared with persisted bridge state. As soon as at least
`CATCHUP_BATCH_SIZE` unresolved groups are visible, pagination stops.

This keeps the existing duplicate guard and state-based recovery while avoiding
page 14/page 18 requests when the next batch is already available on an earlier
page.

Every failed order now emits `[IMPORT FAILED] ORDER | reason` to make a
zero-submission batch diagnosable directly from Railway logs.

Scheduled imports use a self-scheduling timeout rather than `setInterval`, so a
slow import cannot cause another scheduled import to start before its own
interval has elapsed after completion.

## v3.22 — automatic verified artwork mapping

If a matched synced product has no existing artwork-map entry, the bridge now
inspects that exact Printful product and persists an attached file only when its
filename exactly equals the old/current SKU plus `.png`. Generated names such
as `aew6180-1.png` do not match `aew6180` and are rejected.

Successful discoveries log `[ARTWORK AUTO-MAP]`. The created order still uses
catalog `variant_id` plus the verified file ID rather than `sync_variant_id`.
If no exact file is discoverable, the order safely remains unresolved and will
retry in catch-up.


## v3.24 — Printful* routing + duplicate persistence + canceled replacement

- ShipStation eligibility now accepts any comma-delimited Custom Field 1 token whose value begins with `Printful` (case-insensitive), including `Printful`, `PrintfulEU`, and `PrintfulCanada`.
- Existing non-canceled Printful orders remain duplicate-protected and are persisted as submitted/accounted-for state so future catch-up runs skip them.
- If the original Printful order is canceled/cancelled, it no longer blocks fulfillment. The bridge creates or reuses a deterministic `-R1` replacement external ID, preserving retry idempotency and the ShipStation mapping.
- All v3.23 newest + backlog scanning, throttling, verified artwork mapping, and auto-confirm behavior remain in place.


## v3.25 — 30-day reconciliation

The bridge now performs a progressive date-bounded audit of eligible ShipStation orders from the last 30 days. It scans a small number of pages per normal import cycle, remembers its page cursor in the persistent state file, and feeds unresolved orders through the same duplicate/artwork/canceled-order protections as normal imports.

Recommended Railway variables:

```env
RECONCILE_30_DAY_ENABLED=true
RECONCILE_30_DAY_DAYS=30
RECONCILE_30_DAY_BATCH_SIZE=25
RECONCILE_30_DAY_PAGES_PER_RUN=2
```

Tracking scheduling is also recursive in v3.25, so a slow tracking run cannot overlap the next scheduled tracking run.


## v3.26 — duplicate ShipStation record protection

The NEWEST, BACKLOG, and 30-DAY discovery passes can overlap. v3.26 deduplicates
ShipStation records by `orderId` inside each grouped order before the Printful
payload is built. This prevents the same ShipStation line items from being added
twice and avoids Printful `Duplicate item external ID` 400 errors while preserving
legitimate item quantities and separate ShipStation split records.


## v3.27 — 30-day reconciliation oldest-first

The independent 30-day reconciliation pass now explicitly requests ShipStation orders with `sortDir=ASC` inside the rolling date window. Page 1 therefore begins at the oldest orders in the window (about 30 days ago) and advances toward today over successive runs. NEWEST and BACKLOG behavior is unchanged.

Expected log prefix:

```text
[SHIPSTATION SCAN] [30-DAY OLDEST-FIRST] page 1: ...
[30-DAY RECONCILE OLDEST-FIRST] 2026-09-07 through 2026-10-07 | ...
```


## v3.28 — verified synced variant preserves saved placement

- For automatic synced products, the bridge now verifies the expected old/current SKU artwork on the exact matched Printful sync variant.
- When verified, orders use `sync_variant_id`, preserving the existing Printful product's saved placement, scale and print-area configuration.
- If the exact matched sync variant cannot be verified, the bridge retains the v3.27 catalog-variant + verified artwork fallback.
- No Railway environment variable changes are required.
