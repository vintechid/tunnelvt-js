#!/usr/bin/env node
import { parseArgs } from "node:util";
import { TunnelVT } from "../lib/client.js";

const { values } = parseArgs({
  options: {
    server: { type: "string", short: "s", default: "http://localhost:8080" },
    token:  { type: "string", short: "t", default: "" },
    device: { type: "string", short: "d", default: "" },
    app:    { type: "string", short: "a" },
    port:   { type: "string", short: "p" },
    help:   { type: "boolean", short: "h" },
  },
});

if (values.help || !values.app || !values.port) {
  console.error("Usage: tunnelvt -s <url> -a <app> -p <port> [-t <token>] [-d <device>]");
  console.error("  -s, --server  server URL     (default: http://localhost:8080)");
  console.error("  -a, --app     app name       (required)");
  console.error("  -p, --port    local port     (required)");
  console.error("  -t, --token   auth token");
  console.error("  -d, --device  device ID");
  process.exit(values.help ? 0 : 1);
}

const port = parseInt(values.port, 10);
if (isNaN(port) || port < 1 || port > 65535) {
  console.error("Error: port must be 1-65535");
  process.exit(1);
}

new TunnelVT(values.server, values.app, port, values.token || undefined, values.device || undefined)
  .connect()
  .catch((err) => { console.error("[tunnelvt] fatal:", err.message); process.exit(1); });
