// Side-effect import → single fetch → flush. Happy path end-to-end.
import "@astropods/adapter-core/instrument";
import { getOrCreateAstroTracerProvider } from "@astropods/adapter-core";

const target = process.env.TARGET_URL;
if (!target) throw new Error("TARGET_URL not set");

const res = await fetch(`${target}/status/200`);
const json = await res.json();

// Print before flushing so the OTel exporter's "Request timed out" warning
// (a Bun node:http shim quirk) can't bury the scenario's actual result.
process.stdout.write(JSON.stringify({ ok: true, status: res.status, requested: json.requested }) + "\n");

const provider = getOrCreateAstroTracerProvider();
try { await provider?.forceFlush(); } catch {}
process.exit(0);
