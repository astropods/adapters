// Common HTTP methods × varied status codes.
import "@astropods/adapter-core/instrument";
import { getOrCreateAstroTracerProvider } from "@astropods/adapter-core";

const target = process.env.TARGET_URL;
if (!target) throw new Error("TARGET_URL not set");

const calls = [
  { method: "GET", path: "/status/200" },
  { method: "POST", path: "/echo", body: "hello" },
  { method: "PUT", path: "/echo", body: "world" },
  { method: "DELETE", path: "/status/204" },
  { method: "GET", path: "/status/404" },
  { method: "GET", path: "/status/503" },
];

for (const c of calls) {
  await fetch(`${target}${c.path}`, {
    method: c.method,
    body: c.body,
  }).catch(() => {});
}

process.stdout.write(JSON.stringify({ ok: true, count: calls.length }) + "\n");

const provider = getOrCreateAstroTracerProvider();
try { await provider?.forceFlush(); } catch {}
process.exit(0);
