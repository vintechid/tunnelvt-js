/**
 * WebSocket tunnel client — username+password → JWT, auto-refresh.
 * First run prompts for credentials. JWT expires 7 days — auto-refreshes.
 * @module tunnelvt/client
 */

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { URL } from "node:url";
import WebSocket from "ws";

const DEFAULT_SERVER = "https://gotunnel.vinstechid.com";
const VERSION = "1.0.0";
const BUILD_HASH = "dev";

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailers",
  "transfer-encoding", "upgrade",
]);
const MAX_BODY = 10 * 1024 * 1024;

function identityFile() { return path.join(os.homedir(), ".tunnelvt.json"); }

function buildWsUrl(u) {
  const p = new URL("/_tunnel/connect", u);
  p.protocol = p.protocol === "https:" ? "wss:" : "ws:";
  return p.href;
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

function prompt(question, hidden) {
  return new Promise((resolve) => {
    if (hidden) {
      const stdin = process.stdin;
      const stdout = process.stdout;
      const wasRaw = stdin.isRaw;
      stdin.setRawMode(true);
      stdout.write(question);
      let pass = "";
      const onData = (buf) => {
        const c = buf.toString("utf-8");
        for (const ch of c) {
          if (ch === "\r" || ch === "\n") {
            stdin.setRawMode(wasRaw);
            stdin.off("data", onData);
            stdout.write("\n");
            resolve(pass);
            return;
          }
          if (ch === "\x03") { process.exit(1); }
          if (ch === "\x7f" || ch === "\b") {
            if (pass.length > 0) pass = pass.slice(0, -1);
          } else if (ch >= " ") {
            pass += ch;
          }
        }
      };
      stdin.on("data", onData);
    } else {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
    }
  });
}

function fetchJWT(serverUrl, username, password) {
  return new Promise((resolve, reject) => {
    const u = new URL("/_tunnel/auth", serverUrl);
    const body = JSON.stringify({ username, password });
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(u, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout: 10_000,
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(data));
        try { resolve(JSON.parse(data).jwt); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

export class TunnelVT {
  constructor(app, port) {
    this.app = app;
    this.port = port;
    this._username = "";
    this._password = "";
    this._jwt = "";
    this._ws = null;
  }

  async connect() {
    await this._ensureJWT();
    let backoff = 1;
    while (true) {
      try {
        await this._connectWS();
        backoff = 1;
      } catch (e) {
        if (e.message.includes("invalid or expired")) {
          this._jwt = "";
          await this._ensureJWT();
          backoff = 1;
          continue;
        }
        const jitter = backoff * 0.25 * (Math.random() * 2 - 1);
        const wait = (backoff + jitter) * 1000;
        console.error(`[tunnelvt] reconnecting in ${(wait/1000).toFixed(1)}s`);
        await new Promise(r => setTimeout(r, wait));
        backoff = Math.min(backoff * 2, 60);
      }
    }
  }

  async _connectWS() {
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

  async _ensureJWT() {
    try {
      const data = JSON.parse(fs.readFileSync(identityFile(), "utf-8"));
      if (data.username) {
        this._username = data.username;
        this._password = data.password || "";
        this._jwt = data.jwt || "";
      }
    } catch {}

    if (!this._username) {
      this._username = await prompt("Username: ", false);
      if (!this._username) throw new Error("username required");
      this._password = await prompt("Password: ", true);
      if (!this._password) throw new Error("password required");
    }

    if (!this._jwt) {
      try {
        this._jwt = await fetchJWT(DEFAULT_SERVER, this._username, this._password);
      } catch (e) {
        try { fs.unlinkSync(identityFile()); } catch {}
        this._username = "";
        this._password = "";
        throw e;
      }
    }

    fs.writeFileSync(identityFile(), JSON.stringify({
      username: this._username, password: this._password, jwt: this._jwt,
    }));
  }

  _register() {
    return new Promise((resolve, reject) => {
      const onMsg = (data) => {
        const ack = JSON.parse(data.toString());
        this._ws.removeListener("message", onMsg);
        if (ack.type === "error") return reject(new Error(ack.error));
        console.log(`https://gotunnel.vinstechid.com/a/${this._username}/${this.app}/`);
        console.error(`[tunnelvt] connected — ${this._username}/${this.app} -> localhost:${this.port}`);
        resolve();
      };
      this._ws.on("message", onMsg);
      this._send({ type: "register", jwt: this._jwt, app: this.app, port: this.port, version: VERSION, vhash: BUILD_HASH });
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
