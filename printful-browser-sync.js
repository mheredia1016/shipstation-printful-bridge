(async () => {
  const DIRECTORY_ID = 4021854;
  const ENDPOINT =
    'https://www.printful.com/rpc/library-rpc/get-directory-files';
  const PAGE_SIZE = 24;
  const MAX_PAGES = 5000;
  const DELAY_MS = 250;

  const railwayUrl = window.prompt(
    'Enter your Railway bridge URL, for example:\\n' +
    'https://your-service.up.railway.app'
  )?.trim().replace(/\/+$/, '');

  if (!railwayUrl) throw new Error('Railway URL is required.');

  const adminToken = window.prompt(
    'Enter the Railway ADMIN_TOKEN used by your bridge:'
  )?.trim();

  if (!adminToken) throw new Error('ADMIN_TOKEN is required.');

  const csrfToken = window.prompt(
    'Paste the current x-csrf-token from the successful ' +
    'get-directory-files request:'
  )?.trim();

  if (!csrfToken) throw new Error('Printful CSRF token is required.');

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const best = new Map();

  function score(file) {
    return (
      Number(file.dpi || 0) * 1e12 +
      Number(file.width || 0) * Number(file.height || 0) +
      Number(file.createdAt || 0)
    );
  }

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    console.log(`Scanning Printful Library page ${page}...`);

    const response = await fetch(ENDPOINT, {
      method: 'POST',
      mode: 'cors',
      credentials: 'include',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-csrf-token': csrfToken,
        'x-pf-language': 'en',
        'x-requested-with': 'XMLHttpRequest'
      },
      body: JSON.stringify({
        directoryId: DIRECTORY_ID,
        page,
        sort: 'CREATED_DATE_DESC'
      })
    });

    if (!response.ok) {
      throw new Error(
        `Printful page ${page} failed: ${response.status} ` +
        `${(await response.text()).slice(0, 500)}`
      );
    }

    const data = await response.json();
    const files = Array.isArray(data?.result?.files)
      ? data.result.files
      : [];

    for (const file of files) {
      const filename = String(file.filename || '')
        .trim()
        .toLowerCase();

      // Keep exact production PNG names only.
      if (!filename.endsWith('.png')) continue;
      if (/mockup/i.test(filename)) continue;
      if (/-\d+\.png$/i.test(filename)) continue;
      if (String(file.status || '').toLowerCase() !== 'active') continue;
      if (String(file.type || '').toLowerCase() !== 'image/png') continue;

      const sku = filename.replace(/\.png$/i, '');
      const existing = best.get(sku);

      if (!existing || score(file) > score(existing)) {
        best.set(sku, file);
      }
    }

    console.log(
      `Page ${page}: ${files.length} files; ` +
      `${best.size} exact production mappings found.`
    );

    if (files.length < PAGE_SIZE) break;
    await sleep(DELAY_MS);
  }

  const mappings = {};

  for (const [sku, file] of best.entries()) {
    mappings[sku] = {
      fileId: Number(file.fileId),
      filename: file.filename,
      dpi: file.dpi ?? null,
      width: file.width ?? null,
      height: file.height ?? null,
      storeId: file.storeId ?? null
    };
  }

  console.log(
    `Sending ${Object.keys(mappings).length} mappings to Railway...`
  );

  const upload = await fetch(
    `${railwayUrl}/api/artwork-map/bulk`,
    {
      method: 'POST',
      mode: 'cors',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': adminToken
      },
      body: JSON.stringify({ mappings })
    }
  );

  const result = await upload.json();

  if (!upload.ok) {
    throw new Error(
      result?.error ||
      `Railway upload failed with status ${upload.status}.`
    );
  }

  console.log('Artwork sync complete:', result);
  console.table(
    Object.entries(mappings).slice(0, 50).map(([sku, value]) => ({
      sku,
      fileId: value.fileId,
      filename: value.filename,
      dpi: value.dpi
    }))
  );

  alert(
    `Artwork sync complete.\\n\\n` +
    `Imported: ${result.imported}\\n` +
    `Ignored: ${result.ignored}\\n` +
    `Total saved mappings: ${result.totalMappings}`
  );
})().catch(error => {
  console.error(error);
  alert(`Artwork sync failed:\\n\\n${error.message}`);
});