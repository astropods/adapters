// Connection refused → span carries error.type, fetch re-throws.
import "@astropods/adapter-core/instrument";
import { getOrCreateAstroTracerProvider } from "@astropods/adapter-core";

let errorName = null;
let threw = false;
try {
  await fetch("http://127.0.0.1:1/will-fail");
} catch (err) {
  threw = true;
  errorName = err?.name ?? String(err);
}

process.stdout.write(JSON.stringify({ ok: true, threw, errorName }) + "\n");

const provider = getOrCreateAstroTracerProvider();
try { await provider?.forceFlush(); } catch {}
process.exit(0);
