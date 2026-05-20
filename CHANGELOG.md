# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **CF fingerprint passthrough** — `cfScraper` now captures `navigator.userAgentData` and emits matching `sec-ch-ua` / `sec-ch-ua-mobile` / `sec-ch-ua-platform` headers on the subsequent HTTP exchange and WebSocket handshake. Lowers re-challenge rate from CF's WAF when bots switch from puppeteer-real-browser → node-tls-client → wreq-js WS.
- **Version-aware TLS identifier picker** — `pickTLSIdentifier(ua)` now parses the Chrome/Firefox major version out of the captured UA and selects the closest available `ClientIdentifier`, instead of picking randomly. Eliminates the JA3 mismatch between solver-Chrome and post-clearance HTTP.
- **Pre-flight proxy probe** (`cf_preflight`, default `true`) — 5s probe against `https://1.1.1.1/cdn-cgi/trace` before paying the 1–2s context-creation + up-to-60s CF-wait cost. Drops mean failed-solve latency from ~60s to <5s on dead proxies.
- **Background CF cache refresh** (`cf_background_refresh`, default `false`; `cf_refresh_after_days`, default `5`) — when a bot pulls a cached session older than the threshold, a non-blocking re-solve overwrites the cache entry while the bot uses the still-valid cookie immediately.
- **CF solve failures feed proxy quarantine** — `Bot._fetchCfSession` and the precache loop in `main()` now call `proxyPool.fail(raw)` on solve failure, so a CF-blacklisted IP is skipped on subsequent `forChunk()` calls instead of being hammered until the HTTP/WS-driven failure threshold is reached.

### Changed
- **CF solve URL** is now `https://agma.io/` instead of `https://agma.io/client.php`. Same zone, same clearance scope, but a GET to a POST endpoint is anomalous to CF; the root path looks like normal browser traffic.
- **Cookie-wait polling interval** in `cfScraper._doSolve` shrunk from 500ms → 100ms. `cf_clearance` is HttpOnly so we can't shortcut via `page.waitForFunction(document.cookie)`; this is the cheap version of the same idea. Drops up to ~400ms tail latency per solve.
- **`cfScraper.init()` is now idempotent** — concurrent callers (e.g. multiple background-refresh requests) coalesce on a single shared promise instead of racing.

### Configuration
New keys (all backward-compatible defaults):
- `cf_preflight: true`
- `cf_preflight_timeout: 5000`
- `cf_background_refresh: false`
- `cf_refresh_after_days: 5`

## [2.0.0] — 2026-04-20

### Breaking Changes
- All `require()` paths changed — modules moved to `src/` directory
- `Bot.js` decomposed into 6 modules under `src/bot/`
- Global state (`global._consoleInterval`, etc.) replaced with `BotPool` EventEmitter
- `frozenvirus()` → `sendFrozenVirus()`, `sendPw()` → `sendPowerup()`
- `string()` → `randomString()`
- `startspawnint()/stopspawnint()` → `startContinuousSpawn()/stopContinuousSpawn()`
- `ou()` → `_canSend()` (now private)
- Config must be in `data/config.json` or root `config.json`
- Old install scripts replaced — see `scripts/` directory

### Added
- **Modular architecture**: 6 bot modules, 2 proxy modules, 2 service modules
- **BotPool** EventEmitter — emits `statsUpdate` events
- **CaptchaService** — retry logic (3 attempts), exponential backoff, 60s timeout, structured errors
- **AccountStore** — async I/O, 2s write debouncing, atomic file writes
- **ProxyManager** — health tracking, automatic quarantine (5 failures → 60s cooldown)
- **ProxyParser** — extracted as testable pure function
- **Named OPCODES** — all magic numbers replaced with `OPCODES.SRV_CONNECTED`, etc.
- **Bounds checking** — Reader/Writer throw `RangeError` on overflow/underflow
- **Reader.hasRemaining()** — check if N bytes are available
- **Writer.toBuffer()** — convenience method
- **dotenv support** — secrets loaded from `.env` file
- **`.env.example`** — template for environment variables
- **`.gitignore`** — protects credentials and data files
- **README.md** — full documentation
- **Server command router** — handler map pattern replaces 145-line switch
- **Graceful shutdown** — 3s drain on panel kill command
- **Panel v4** — redesigned with tabs, sparkline, theming, keybind remapping, log console

### Changed
- `package.json` version bumped to 2.0.0
- `main` field fixed: `aa.js` → `start.js`
- `start` npm script added
- Protocol methods deobfuscated with JSDoc:
  - `_0x4c0714` → `_writeHandshakeOpcode`
  - `_0x25377f` → `_writeClientChallenge`
  - `_0x9b1a41` → `_computeMultiplier`
  - `_0x4bfb7f` → `_writeChecksumPayload`
  - `_0x11d218` → `_writePacketChecksum`
- `Bot._AEE6F6` → `CHECKSUM_DIVISORS` (named constant)

### Removed
- **11 unused dependencies**: axios, cloudflare-bypasser, cloudscraper, curl-cffi-node, curl-impersonate, got-scraping, http2-wrapper, puppeteer-core, puppeteer-extra, puppeteer-extra-plugin-stealth, puppeteer-page-proxy, undici
- All `global.*` namespace pollution
- Synchronous file I/O in hot paths
- Hardcoded API key from source (moved to `.env`)
- Old `install.bat` / `install.sh` (replaced in `scripts/`)

### Security
- CapMonster API key moved from hardcoded string to environment variable
- `accounts.json` added to `.gitignore`
- Server shutdown uses graceful drain instead of `process.exit(0)`
