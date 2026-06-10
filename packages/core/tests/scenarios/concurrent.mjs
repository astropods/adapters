// Five concurrent fetches → five distinct spans, no attribute bleed.
import "@astropods/adapter-core/instrument";
import { getOrCreateAstroTracerProvider } from "@astropods/adapter-core";

const target = process.env.TARGET_URL;
if (!target) throw new Error("TARGET_URL not set");

const ids = [1, 2, 3, 4, 5];
await Promise.all(
  ids.map((id) => fetch(`${target}/status/200?id=${id}`).then((r) => r.text())),
);

process.stdout.write(JSON.stringify({ ok: true, count: ids.length }) + "\n");

const provider = getOrCreateAstroTracerProvider();
try { await provider?.forceFlush(); } catch {}
process.exit(0);
