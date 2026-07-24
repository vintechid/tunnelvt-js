# tunnelvt — JavaScript

Simple tunneling client in Node.js. No login. Expose local apps at `domain/<device>/<app>`.

## Install

```bash
npm install -g tunnelvt
```

Requires Node.js ≥ 18.

## Usage

```bash
tunnelvt -s https://tunnel.example.com -a myapp -p 3000
```

Output:
```
[tunnelvt] connected — a1b2c3d4e5f6g7h8/myapp -> localhost:3000
```

Your app is now at:

```
https://tunnel.example.com/a1b2c3d4e5f6g7h8/myapp/
```

### Custom device ID

```bash
tunnelvt -s https://tunnel.example.com -d my-laptop -a api -p 8080
# → https://tunnel.example.com/my-laptop/api/
```

### Library usage

```js
import { TunnelVT } from "tunnelvt";

const t = new TunnelVT("https://tunnel.example.com", "myapp", 3000);
await t.connect(); // blocks
```

## License

MIT
