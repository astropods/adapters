// Endpoint unset → side-effect import must not patch fetch.
const originalFetch = globalThis.fetch;
await import("@astropods/adapter-core/instrument");
const afterImport = globalThis.fetch;

const target = process.env.TARGET_URL;
if (!target) throw new Error("TARGET_URL not set");

const res = await fetch(`${target}/status/200`);

process.stdout.write(
  JSON.stringify({
    ok: true,
    status: res.status,
    fetchUnchanged: originalFetch === afterImport,
  }) + "\n",
);
