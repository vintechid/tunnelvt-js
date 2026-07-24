/**
 * WebSocket tunnel client — connect, register, forward requests to localhost.
 *
 * Works through Cloudflare — WebSocket upgrade over HTTPS, server IP hidden.
 *
 * @module tunnelvt/client
 */

import { randomBytes } from "node:crypto";
import http from "node:http";
import WebSocket from "ws";

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailers",
  "transfer-encoding", "upgrade",
]);

const MAX_BODY = 10 * 1024 * 1024;

function generateDeviceId() {
  return randomBytes(8).toString("hex");
}

function buildWsUrl(serverUrl) {
  const u = new URL("/_tunnel/connect", serverUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.href;
}

function localRequest(port, method, path, rawHeaders, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "127.0.0.1", port, path, method,
      headers: rawHeaders ?? {}, timeout: 25_000,
    };
    for (const k of Object.keys(opts.headers)) {
      if (HOP_BY_HOP.has(k.toLowerCase())) delete opts.headers[k];
    }
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (buf.length > MAX_BODY) return reject(new Error("response too large"));
        resolve({ status: res.statusCode, headers: res.headers, body: buf.toString("base64") });
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("local request timed out")); });
    req.on("error", reject);
    if (body) req.write(Buffer.from(body, "base64"));
    req.end();
  });
}

export class TunnelVT {
  /**
   * @param {string}  serverUrl  Server URL, e.g. "https://tunnel.example.com".
   * @param {string}  app        App name.
   * @param {number}  port       Local port.
   * @param {string} [token]     Pre-shared auth token.
   * @param {string} [device]    Device ID (random if omitted).
   */
  constructor(serverUrl, app, port, token, device) {
    this.serverUrl = serverUrl;
    this.app = app;
    this.port = port;
    this.token = token || "";
    this.device = device || generateDeviceId();
    this._ws = null;
  }

  connect() {
    const wsUrl = buildWsUrl(this.serverUrl);
    this._ws = new WebSocket(wsUrl);
    return new Promise((resolve, reject) => {
      this._ws.on("open", () => { this._register().then(resolve).catch(reject); });
      this._ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "request") this._handleRequest(msg);
      });
      this._ws.on("error", (err) => {
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) reject(err);
        else console.error("[tunnelvt] ws error:", err.message);
      });
      this._ws.on("close", () => console.error("[tunnelvt] disconnected"));
    });
  }

  _register() {
    return new Promise((resolve, reject) => {
      const onMsg = (data) => {
        const ack = JSON.parse(data.toString());
        this._ws.removeListener("message", onMsg);
        if (ack.type === "error") return reject(new Error(ack.error));
        this.device = ack.device;
        console.error(`[tunnelvt] connected — ${this.device}/${this.app} -> localhost:${this.port}`);
        resolve();
      };
      this._ws.on("message", onMsg);
      this._send({ type: "register", token: this.token, device: this.device, app: this.app, port: this.port });
    });
  }

  async _handleRequest(msg) { this._send(await this._doLocal(msg)); }

  async _doLocal(msg) {
    const reqId = msg.id ?? "";
    try {
      const { status, headers, body } = await localRequest(
        this.port, msg.method ?? "GET", msg.path ?? "/", msg.headers ?? {}, msg.body ?? "",
      );
      return { type: "response", id: reqId, status, headers, body };
    } catch (err) {
      return { type: "error", id: reqId, error: `local request failed: ${err.message}` };
    }
  }

  _send(msg) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) this._ws.send(JSON.stringify(msg));
  }
}
