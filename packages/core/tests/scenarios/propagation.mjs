// Verify W3C trace context lands in outgoing fetch headers.
import "@astropods/adapter-core/instrument";
import { getOrCreateAstroTracerProvider } from "@astropods/adapter-core";

const target = process.env.TARGET_URL;
if (!target) throw new Error("TARGET_URL not set");

const res = await fetch(`${target}/headers`, {
  headers: { "x-user-header": "preserved" },
});
const data = await res.json();

process.stdout.write(
  JSON.stringify({
    ok: true,
    traceparent: data.headers.traceparent ?? null,
    userHeader: data.headers["x-user-header"] ?? null,
  }) + "\n",
);

const provider = getOrCreateAstroTracerProvider();
try { await provider?.forceFlush(); } catch {}
process.exit(0);
