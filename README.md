# ⬡ AgmaBot

Bot system for [agma.io](https://agma.io) with a WebSocket-based control panel.

## Features

- **Multi-bot management** — Connect dozens of bots simultaneously
- **Proxy support** — HTTP, HTTPS, SOCKS4, SOCKS5 with health tracking & rotation
- **Control panel** — Tampermonkey userscript with live stats, sparkline charts, and dark/light themes
- **Account registration** — Mass account creation with captcha solving
- **Protocol handshake** — TLS-fingerprinted connections via CycleTLS

## Quick Start

### 1. Requirements
- **Node.js** ≥ 18
- **Tampermonkey** browser extension

### 2. Install
```bash
npm install
```

### 3. Configure
Copy `.env.example` to `.env` and fill in your CapMonster API key:
```bash
cp .env.example .env
```

Edit `config.json` (or `data/config.json`):
```json
{
    "amount": 50,
    "name": "MyBot",
    "server": "s6",
    "proxy": true,
    "amount_per_ip": 1
}
```

### 4. Add Proxies
Place proxy list in `proxy.txt` (one per line):
```
user:pass@host:port
socks5://user:pass@host:port
host:port
```

### 5. Run
```bash
npm start
```

### 6. Install Panel
Install `client/agma-bot-panel.user.js` in Tampermonkey, then visit agma.io.

## Modes

| Mode | Config | Description |
|------|--------|-------------|
| **Server** | `debugmode: false, register: false` | Default — starts WS control server for the panel |
| **Debug** | `debugmode: true` | Direct connect, console output, no server |
| **Register** | `register: true` | Mass account registration |

## Config Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `amount` | number | 1 | Number of bots to spawn |
| `amount_per_ip` | number | 1 | Bots sharing the same proxy IP |
| `name` | string | "bot" | Bot display name |
| `server` | string | "s6" | Game server (`s6` or `s15`) |
| `debugmode` | boolean | false | Enable debug mode |
| `proxy` | boolean | true | Enable proxy rotation |
| `register` | boolean | false | Enable registration mode |
| `register_count` | number | 1 | Accounts to register |
| `register_threads` | number | 1 | Parallel registration threads |
| `battlemode` | boolean | false | Auto-disconnect after 3s |
| `useacc` | boolean | false | Login with `accounts.json` credentials |
| `server_port` | number | 8080 | WS control server port |

## Panel Keybinds

| Key | Action |
|-----|--------|
| `` ` `` | Start bots on current server |
| `a` | Split all |
| `1` | Feed all |
| `2` | Drop powerups |
| `3` | Frozen virus combo |
| `[` | Toggle continuous spawn |
| `-` | Stop all bots |
| `0` | Connect to control server |

> Keybinds are remappable in the panel's Settings tab.

## Architecture

```
agmabot/
├── start.js              ← Entry point
├── src/
│   ├── bot/              ← Bot core (Connection, Protocol, Actions, HTTP, Pool)
│   ├── protocol/         ← Binary Reader/Writer + packet opcodes
│   ├── proxy/            ← ProxyManager + ProxyParser
│   ├── services/         ← CaptchaService, AccountStore
│   ├── server/           ← Express + WS server + command handlers
│   └── config.js         ← Config loader with validation
├── client/               ← Tampermonkey userscript
├── data/                 ← Runtime data (accounts, proxies, config)
└── scripts/              ← Install scripts
```

## Troubleshooting

**Q: Bots connect but immediately disconnect**
A: Check your proxy list. Bad proxies are quarantined after 5 failures. Enable `debugmode: true` for detailed logs.

**Q: "CycleTLS failed" errors**
A: CycleTLS requires a valid proxy. Ensure proxy.txt is populated and proxies are alive.

**Q: Panel doesn't connect**
A: Verify the server is running on port 8080. Check browser console for WebSocket errors.

**Q: Captcha solving fails**
A: Ensure `CAPMONSTER_API_KEY` is set in your `.env` file with a valid key and positive balance.

**Q: "Writer overflow" errors**
A: A packet is being built with insufficient buffer size. This is a code bug — report it.

## License

ISC
