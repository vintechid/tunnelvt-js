/**
 * tunnelvt — Simple tunneling. No login.
 *
 * @example
 * ```js
 * import { TunnelVT } from "tunnelvt";
 *
 * const t = new TunnelVT("https://tunnel.example.com", "myapp", 3000, "token");
 * await t.connect();
 * ```
 */

export { TunnelVT } from "./lib/client.js";
