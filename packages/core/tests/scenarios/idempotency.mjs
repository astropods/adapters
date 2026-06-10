// Side-effect import + explicit call ×2 → one fetch → one span.
import "@astropods/adapter-core/instrument";
import { instrumentHttp, getOrCreateAstroTracerProvider } from "@astropods/adapter-core";

instrumentHttp();
instrumentHttp();

const target = process.env.TARGET_URL;
if (!target) throw new Error("TARGET_URL not set");

await fetch(`${target}/status/200`);

process.stdout.write(JSON.stringify({ ok: true }) + "\n");

const provider = getOrCreateAstroTracerProvider();
try { await provider?.forceFlush(); } catch {}
process.exit(0);
