# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
