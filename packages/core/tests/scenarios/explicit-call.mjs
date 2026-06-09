// Explicit instrumentHttp() form. Must behave identically to basic-fetch.mjs.
import { instrumentHttp, getOrCreateAstroTracerProvider } from "@astropods/adapter-core";

instrumentHttp();

const target = process.env.TARGET_URL;
if (!target) throw new Error("TARGET_URL not set");

const res = await fetch(`${target}/status/200`);

process.stdout.write(JSON.stringify({ ok: true, status: res.status }) + "\n");

const provider = getOrCreateAstroTracerProvider();
try { await provider?.forceFlush(); } catch {}
process.exit(0);
