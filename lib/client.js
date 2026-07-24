/**
 * WebSocket tunnel client — auto-fetch JWT on first run, save to ~/.tunnelvt.json.
 *
 * No login. Trust-on-first-use identity. Version hash sent for server auditing.
 * @module tunnelvt/client
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import WebSocket from "ws";

const DEFAULT_SERVER = "https://gotunnel.vinstechid.com";
const VERSION = "1.0.0";
const BUILD_HASH = "dev"; // set at build time

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailers",
  "transfer-encoding", "upgrade",
]);
const MAX_BODY = 10 * 1024 * 1024;

function identityFile() {
  return path.join(os.homedir(), ".tunnelvt.json");
}

function generateDeviceId() {
  return randomBytes(8).toString("hex");
}

function buildWsUrl(serverUrl) {
  const u = new URL("/_tunnel/connect", serverUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.href;
}

/** Call /_tunnel/hello to get a JWT. */
function fetchJWT(serverUrl, device) {
  return new Promise((resolve, reject) => {
    const u = new URL("/_tunnel/hello", serverUrl);
    const body = JSON.stringify({ device });
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(u, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout: 10_000,
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`server returned ${res.statusCode}: ${data}`));
        try { resolve(JSON.parse(data).jwt); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

function localRequest(port, method, path, rawHeaders, body) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: "127.0.0.1", port, path, method, headers: rawHeaders ?? {}, timeout: 25_000 };
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
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
    if (body) req.write(Buffer.from(body, "base64"));
    req.end();
  });
}

export class TunnelVT {
  /**
   * @param {string}  app   App name.
   * @param {number}  port  Local port.
   */
  constructor(app, port) {
    this.app = app;
    this.port = port;
    this._device = "";
    this._jwt = "";
    this._ws = null;
  }

  async connect() {
    await this._loadOrFetchIdentity();
    const wsUrl = buildWsUrl(DEFAULT_SERVER);
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

  async _loadOrFetchIdentity() {
    try {
      const data = JSON.parse(fs.readFileSync(identityFile(), "utf-8"));
      if (data.jwt) {
        this._device = data.device;
        this._jwt = data.jwt;
        return;
      }
    } catch {}

    this._device = generateDeviceId();
    this._jwt = await fetchJWT(DEFAULT_SERVER, this._device);
    fs.writeFileSync(identityFile(), JSON.stringify({ device: this._device, jwt: this._jwt }));
  }

  _register() {
    return new Promise((resolve, reject) => {
      const onMsg = (data) => {
        const ack = JSON.parse(data.toString());
        this._ws.removeListener("message", onMsg);
        if (ack.type === "error") return reject(new Error(ack.error));
        this._device = ack.device;
        console.log(`https://gotunnel.vinstechid.com/${this._device}/${this.app}/`);
        console.error(`[tunnelvt] connected — ${this._device}/${this.app} -> localhost:${this.port}`);
        resolve();
      };
      this._ws.on("message", onMsg);
      this._send({
        type: "register", jwt: this._jwt, device: this._device,
        app: this.app, port: this.port, version: VERSION, vhash: BUILD_HASH,
      });
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
