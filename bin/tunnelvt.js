#!/usr/bin/env node
import { parseArgs } from "node:util";
import { TunnelVT } from "../lib/client.js";

const { values } = parseArgs({
  options: {
    app:  { type: "string", short: "a" },
    port: { type: "string", short: "p" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help || !values.app || !values.port) {
  console.error("Usage: tunnelvt -a <app> -p <port>");
  console.error("  -a, --app   app name  (required)");
  console.error("  -p, --port  local port (required)");
  process.exit(values.help ? 0 : 1);
}

const port = parseInt(values.port, 10);
if (isNaN(port) || port < 1 || port > 65535) {
  console.error("Error: port must be 1-65535");
  process.exit(1);
}

new TunnelVT(values.app, port)
  .connect()
  .catch((err) => { console.error("[tunnelvt] fatal:", err.message); process.exit(1); });
