'use strict';

// ─── Env ──────────────────────────────────────────────────────────────────────
try { require('dotenv').config(); } catch (_) { }

// ─── Config ───────────────────────────────────────────────────────────────────
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const SERVER_URLS = { s6: 'wss://s6.agma.io:2053/', s15: 'wss://s15.agma.io:451/' };

const config = (() => {
    const DEFAULTS = {
        amount: 1, amount_per_ip: 1, name: 'bot', server: 's6',
        debugmode: false, proxy: true, register: false,
        register_count: 1, register_threads: 1, battlemode: false,
        useacc: false, server_port: 8080, puppeteer: false, jitter: true,
        proxy_mode: 'v4', cloudflare: false,
        cf_timeout: 60000, cf_cache: false, cf_concurrency: 3, cf_browsers: 1,
    };
    let raw = {};
    const cfgFile = ['data/config.json', 'config.json'].find(f => fs.existsSync(f));
    if (cfgFile) try { raw = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (_) { }

    if ('a' in raw && !('server' in raw)) raw.server = raw.a ? 's6' : 's15';
    if ('accountnumber' in raw) { raw.register_count = raw.accountnumber; delete raw.accountnumber; }
    if ('threads' in raw) { raw.register_threads = raw.threads; delete raw.threads; }

    const cfg = { ...DEFAULTS, ...raw };
    delete cfg.a;
    if (process.env.SERVER_PORT) cfg.server_port = +process.env.SERVER_PORT;
    cfg.capmonster_key = process.env.CAPMONSTER_API_KEY || cfg.capmonster_key || '';
    cfg.serverUrl = SERVER_URLS[cfg.server] || SERVER_URLS.s6;
    cfg.amount = Math.max(1, cfg.amount | 0);
    cfg.amount_per_ip = Math.max(1, cfg.amount_per_ip | 0);
    cfg.server_port = Math.max(1, cfg.server_port | 0);
    return cfg;
})();

// ─── Writer ───────────────────────────────────────────────────────────────────
class Writer {
    constructor(size) {
        this.buffer = new DataView(new ArrayBuffer(size));
        this.position = 0;
    }
    _chk(n) {
        if (this.position + n > this.buffer.byteLength)
            throw new RangeError(`Writer overflow: +${n}@${this.position}/${this.buffer.byteLength}`);
    }
    setString(s) { for (let i = 0; i < s.length; i++) this.setUint16(s.charCodeAt(i)); return this; }
    setInt8(v) { this._chk(1); this.buffer.setInt8(this.position++, v); return this; }
    setUint8(v) { this._chk(1); this.buffer.setUint8(this.position++, v); return this; }
    setInt16(v) { this._chk(2); this.buffer.setInt16((this.position += 2) - 2, v, true); return this; }
    setUint16(v) { this._chk(2); this.buffer.setUint16((this.position += 2) - 2, v, true); return this; }
    setInt32(v) { this._chk(4); this.buffer.setInt32((this.position += 4) - 4, v, true); return this; }
    setUint32(v) {
        this._chk(4);
        if (v % 1 !== 0 && String(v).slice(-2) === '88') v += 4;
        this.buffer.setUint32((this.position += 4) - 4, v, true); return this;
    }
    setFloat32(v) { this._chk(4); this.buffer.setFloat32((this.position += 4) - 4, v, true); return this; }
    setFloat64(v) { this._chk(8); this.buffer.setFloat64((this.position += 8) - 8, v, true); return this; }
}

// ─── Reader ───────────────────────────────────────────────────────────────────
class Reader {
    constructor(msg, pos = 0) {
        if (!msg?.data) throw new TypeError('Reader: msg.data must be ArrayBuffer');
        this.buffer = new DataView(msg.data);
        this.position = pos;
    }
    hasRemaining(n) { return this.position + n <= this.buffer.byteLength; }
    _chk(n) { if (!this.hasRemaining(n)) throw new RangeError(`Reader underflow: +${n}@${this.position}/${this.buffer.byteLength}`); }
    getString() { const a = []; let v; while ((v = this.getUint16()) !== 0) a.push(String.fromCharCode(v)); return a.join(''); }
    getInt8() { this._chk(1); return this.buffer.getInt8(this.position++); }
    getUint8() { this._chk(1); return this.buffer.getUint8(this.position++); }
    getInt16() { this._chk(2); return this.buffer.getInt16((this.position += 2) - 2, true); }
    getUint16() { this._chk(2); return this.buffer.getUint16((this.position += 2) - 2, true); }
    getInt32() { this._chk(4); return this.buffer.getInt32((this.position += 4) - 4, true); }
    getUint32() { this._chk(4); return this.buffer.getUint32((this.position += 4) - 4, true); }
    getFloat32() { this._chk(4); return this.buffer.getFloat32((this.position += 4) - 4, true); }
    getFloat64() { this._chk(8); return this.buffer.getFloat64((this.position += 8) - 8, true); }
}

// ─── Opcodes + static packets ─────────────────────────────────────────────────
const OP = Object.freeze({
    MOUSE: 0, SPAWN: 1, LOGIN: 2, REGISTER: 3, SETTINGS: 4,
    SPLIT: 17, FEED_W: 21, RESPAWN_CLEAR: 34, FEED_Z: 36,
    CLEAR_SPAWN: 59, POWERUP: 72, CHAT: 98, CAPTCHA_INPUT: 100,
    INVISIBILITY: 130, DISPLAY_SETTING: 160,
    HANDSHAKE_INIT: 245, HANDSHAKE_REPLY: 0xf4, FROZEN_VIRUS: 22, PING: 95,
    SRV_CHALLENGE: 64, SRV_CONNECTED: 244, SRV_CAPTCHA: 101,
    SRV_ACCOUNT_RESULT: 95, SRV_WRAPPER: 240,
});
const PKT = {
    PING: new Uint8Array([OP.PING]),
    INVIS: new Uint8Array([OP.INVISIBILITY]),
    S4_7_1: new Uint8Array([OP.SETTINGS, 7, 1]),
    S4_8_0: new Uint8Array([OP.SETTINGS, 8, 0]),
    S4_3_1: new Uint8Array([OP.SETTINGS, 3, 1]),
    WZ_21: new Uint8Array([OP.FEED_W]),
    WZ_36: new Uint8Array([OP.FEED_Z]),
    D160_0: new Uint8Array([OP.DISPLAY_SETTING, 0]),
    CU: Object.fromEntries([OP.SPLIT, OP.FEED_W, OP.RESPAWN_CLEAR, OP.FEED_Z, OP.CLEAR_SPAWN]
        .map(op => [op, new Uint8Array([op])])),
    FROZEN: { 0: new Uint8Array([OP.FROZEN_VIRUS, 0]), 1: new Uint8Array([OP.FROZEN_VIRUS, 1]), 3: new Uint8Array([OP.FROZEN_VIRUS, 3]) },
};

// ─── Proxy ────────────────────────────────────────────────────────────────────
const readline = require('readline');

function parseProxy(raw) {
    let protocol = 'http';
    const m = raw.match(/^(http|https|socks4|socks5):\/\//);
    if (m) { protocol = m[1]; raw = raw.slice(m[0].length); }
    else raw = raw.replace(/^https?:\/\//, '');
    let username, password, host, port;
    if (raw.includes('@')) {
        const [creds, addr] = raw.split('@');
        [username, password] = creds.split(':').map(x => { try { return decodeURIComponent(x); } catch (_) { return x; } });
        [host, port] = addr.split(':');
    } else { [host, port] = raw.split(':'); }
    return { protocol, username, password, host, port };
}

function createProxyPool() {
    return {
        list: [], set: new Set(), chunks: [], health: new Map(),
        QUARANTINE_MS: 60_000, MAX_FAIL: 5,
        add(p) {
            if (!p || this.set.has(p)) return;
            this.set.add(p); this.list.push(p);
            this.health.set(p, { ok: 0, fail: 0, until: 0 });
        },
        ok(p) { const h = this.health.get(p); if (h) { h.ok++; h.fail = 0; } },
        fail(p) { const h = this.health.get(p); if (h) { h.fail++; if (h.fail >= this.MAX_FAIL) h.until = Date.now() + this.QUARANTINE_MS; } },
        healthy(p) {
            const h = this.health.get(p); if (!h) return false;
            if (h.until > Date.now()) return false;
            if (h.until > 0) { h.fail = 0; h.until = 0; }
            return true;
        },
        getHealthy() { return this.list.filter(p => this.healthy(p)); },
        forChunk(i) {
            if (!this.list.length) return null;
            if (this.chunks[i] && this.healthy(this.chunks[i])) return this.chunks[i];
            const pool = this.getHealthy(); const src = pool.length ? pool : this.list;
            this.chunks[i] = src[~~(Math.random() * src.length)];
            return this.chunks[i];
        },
        resetChunks() { this.chunks.length = 0; },
        get count() { return this.list.length; },
        async load(file) {
            if (!file) return;
            const f = [].concat(file).find(x => fs.existsSync(x));
            if (!f) return;
            await new Promise((res, rej) => {
                const rl = readline.createInterface({ input: fs.createReadStream(f, { highWaterMark: 65536 }), crlfDelay: Infinity });
                rl.on('line', l => { const p = l.trim(); if (p) this.add(p); });
                rl.on('close', res); rl.on('error', rej);
            });
        },
    };
}
const proxyV4 = createProxyPool();
const proxyV6 = createProxyPool();

// ─── AccountStore ─────────────────────────────────────────────────────────────
class AccountStore {
    constructor() {
        this._file = ['data/accounts.json', 'accounts.json'].find(f => fs.existsSync(f)) || 'accounts.json';
        this._data = []; this._dirty = false; this._timer = null; this._q = Promise.resolve();
    }
    async load() {
        try { this._data = JSON.parse(await fsp.readFile(this._file, 'utf8')); }
        catch (_) { this._data = []; }
        return this._data;
    }
    get(i) { return this._data[i]; }
    get count() { return this._data.length; }
    add(user, pass) {
        this._data.push({ user, pass }); this._dirty = true;
        if (!this._timer) this._timer = setTimeout(() => { this._timer = null; this.flush(); }, 2000);
    }
    async flush() {
        if (!this._dirty) return;
        this._q = this._q.then(async () => {
            if (!this._dirty) return; this._dirty = false;
            const tmp = this._file + '.tmp';
            try {
                await fsp.mkdir(path.dirname(this._file), { recursive: true });
                await fsp.writeFile(tmp, JSON.stringify(this._data, null, 2));
                await fsp.rename(tmp, this._file);
            } catch (e) { console.error('AccountStore flush:', e.message); this._dirty = true; }
        });
        return this._q;
    }
    async close() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } await this.flush(); }
}

// ─── CaptchaService ───────────────────────────────────────────────────────────
const { CapMonsterCloudClientFactory, ClientOptions, RecaptchaV2Request } = require('@zennolab_com/capmonstercloud-client');
const UA_POOL = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:138.0) Gecko/20100101 Firefox/138.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:138.0) Gecko/20100101 Firefox/138.0',
    'Mozilla/5.0 (X11; Linux x86_64; rv:138.0) Gecko/20100101 Firefox/138.0',
];
const ACCEPT_LANG_POOL = [
    'en-US,en;q=0.9',
    'en-US,en;q=0.9,fr;q=0.8',
    'en-GB,en;q=0.9',
    'en-US,en;q=0.8',
    'en,en-US;q=0.9',
    'en-US,en;q=0.9,de;q=0.7',
];
function pickRandom(arr) { return arr[~~(Math.random() * arr.length)]; }

class CaptchaService {
    constructor(key = config.capmonster_key) {
        this._c = CapMonsterCloudClientFactory.Create(new ClientOptions({ clientKey: key }));
    }
    async solve(px) {
        for (let i = 1; i <= 3; i++) {
            try {
                const req = new RecaptchaV2Request({
                    websiteURL: 'https://agma.io', websiteKey: '6LdQzBQUAAAAAAXCE8HNtqre-T9uzaewmVf--Uv1',
                    proxy: { proxyType: 'http', proxyAddress: px.host, proxyPort: px.port, proxyLogin: px.username, proxyPassword: px.password },
                    userAgent: pickRandom(UA_POOL),
                });
                const r = await Promise.race([
                    this._c.Solve(req),
                    new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), 60000)),
                ]);
                return r.solution.gRecaptchaResponse;
            } catch (e) {
                if (e.message?.includes('quota') || e.message?.includes('balance')) throw e;
                if (i < 3) await new Promise(r => setTimeout(r, 2 ** i * 1000));
                else throw e;
            }
        }
    }
}

// ─── TLS Client (browser-fingerprint HTTP) ───────────────────────────────────
const { Session: TLSSession, ClientIdentifier, initTLS, destroyTLS } = require('node-tls-client');
let _tlsReady = false;

// All CF-passing TLS IDs (verified via test-fingerprints.js)
const TLS_CHROME_IDS = [
    ClientIdentifier.chrome_103, ClientIdentifier.chrome_104,
    ClientIdentifier.chrome_105, ClientIdentifier.chrome_106,
    ClientIdentifier.chrome_107, ClientIdentifier.chrome_108,
    ClientIdentifier.chrome_109, ClientIdentifier.chrome_110,
    ClientIdentifier.chrome_111, ClientIdentifier.chrome_112,
    ClientIdentifier.chrome_116_PSK, ClientIdentifier.chrome_117,
    ClientIdentifier.chrome_131, ClientIdentifier.chrome_131_psk,
];
const TLS_FIREFOX_IDS = [
    ClientIdentifier.firefox_102, ClientIdentifier.firefox_104,
    ClientIdentifier.firefox_105, ClientIdentifier.firefox_106,
    ClientIdentifier.firefox_108, ClientIdentifier.firefox_110,
    ClientIdentifier.firefox_117, ClientIdentifier.firefox_120,
    ClientIdentifier.firefox_123, ClientIdentifier.firefox_132,
    ClientIdentifier.firefox_133,
];
function pickTLSIdentifier(ua) {
    if (ua.includes('Firefox')) return pickRandom(TLS_FIREFOX_IDS);
    return pickRandom(TLS_CHROME_IDS);
}

async function createTLSSession(ua) {
    if (!_tlsReady) { await initTLS(); _tlsReady = true; }
    return new TLSSession({
        clientIdentifier: pickTLSIdentifier(ua),
        timeout: 15000,
        insecureSkipVerify: true,
    });
}
async function closeTLS() {
    if (_tlsReady) { try { await destroyTLS(); } catch (_) { } _tlsReady = false; }
}

function decodeClientKey(raw) {
    if (!raw || isNaN(raw)) return 0;
    const s = String(raw);
    if (s.length <= 7) return parseInt(s, 10);
    const kp = s.slice(0, 7), cp = s.slice(7);
    if (isNaN(kp) || isNaN(cp)) return 0;
    let chk = 0;
    for (let i = 0; i < kp.length; i++) chk += (parseInt(kp[i], 10) + 55) * (i + 1);
    return chk === parseInt(cp, 10) ? Math.max(parseInt(kp, 10) - 1e6, 0) : 0;
}

// ─── Inline CF Scraper (puppeteer-real-browser, multi-browser pool) ───────────
const cfScraper = {
    _browsers: [],
    _ready: false,
    _launching: false,
    _robin: 0,

    async init() {
        if (this._ready || this._launching || !config.cloudflare) return;
        this._launching = true;
        const count = config.cf_browsers || 1;
        console.log(`  CF Scraper: launching ${count} browser(s)...`);
        await Promise.all(Array.from({ length: count }, (_, i) => this._launchOne(i)));
        this._ready = true;
        this._launching = false;
    },

    async _launchOne(idx) {
        const { connect } = require('puppeteer-real-browser');
        try {
            const { browser } = await connect({
                headless: false, turnstile: true,
                connectOption: { defaultViewport: null },
                disableXvfb: false,
            });
            this._browsers[idx] = browser;
            console.log(`  CF Browser #${idx + 1} launched`);
            browser.on('disconnected', async () => {
                console.log(`  CF Browser #${idx + 1} disconnected, relaunching...`);
                this._browsers[idx] = null;
                await new Promise(r => setTimeout(r, 2000));
                await this._launchOne(idx);
            });
        } catch (e) {
            console.log(`  CF Browser #${idx + 1} error: ${e.message}`);
            await new Promise(r => setTimeout(r, 3000));
            await this._launchOne(idx);
        }
    },

    _pickBrowser() {
        const available = this._browsers.filter(b => b);
        if (!available.length) return null;
        this._robin = (this._robin + 1) % available.length;
        return available[this._robin];
    },

    // Concurrency limiter
    _active: 0,
    get _maxConcurrent() { return config.cf_concurrency || 3; },
    _queue: [],

    async solve(url, proxy) {
        // Wait in queue if at max concurrency
        if (this._active >= this._maxConcurrent) {
            await new Promise(r => this._queue.push(r));
        }
        this._active++;
        try {
            return await this._doSolve(url, proxy);
        } finally {
            this._active--;
            if (this._queue.length) this._queue.shift()();
        }
    },

    async _doSolve(url, proxy) {
        const browser = this._pickBrowser();
        if (!browser) throw new Error('CF scraper: no browser available');
        const timeout = config.cf_timeout || 60000;
        const context = await browser.createBrowserContext({
            proxyServer: proxy ? `http://${proxy.host}:${proxy.port}` : undefined,
        }).catch(() => null);
        if (!context) throw new Error('CF scraper: failed to create browser context');

        try {
            const page = await context.newPage();
            if (proxy?.username && proxy?.password)
                await page.authenticate({ username: proxy.username, password: proxy.password });
            const acceptLang = pickRandom(ACCEPT_LANG_POOL);

            // CF challenge may redirect/abort the initial navigation — that's normal
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout }).catch(e => {
                if (!e.message?.includes('ERR_ABORTED') && !e.message?.includes('net::ERR_')) {
                    throw e;
                }
            });

            // Poll until cf_clearance cookie appears (means CF challenge was solved)
            const deadline = Date.now() + timeout;
            let cookies = [];
            while (Date.now() < deadline) {
                cookies = await page.cookies();
                if (cookies.some(c => c.name === 'cf_clearance')) break;
                await new Promise(r => setTimeout(r, 500));
            }

            if (!cookies.some(c => c.name === 'cf_clearance')) {
                throw new Error('CF scraper: cf_clearance cookie never appeared');
            }

            // Grab the UA from the page itself (matches what CF saw)
            const ua = await page.evaluate(() => navigator.userAgent).catch(() => null);
            const headers = {
                'user-agent': ua || '',
                'accept-language': acceptLang,
            };

            await context.close().catch(() => { });
            return { cookies, headers };
        } catch (e) {
            await context.close().catch(() => { });
            throw e;
        }
    },

    async shutdown() {
        for (const b of this._browsers) {
            if (b) try { await b.close(); } catch (_) { }
        }
        this._browsers = [];
        this._ready = false;
    },
};

// ─── CF Session Cache ─────────────────────────────────────────────────────────
const cfCache = {
    _file: 'data/cf-sessions.json',
    _data: {},
    _consumed: new Set(),
    _dirty: false,
    _timer: null,
    async load() {
        try { this._data = JSON.parse(await fsp.readFile(this._file, 'utf8')); }
        catch (_) { this._data = {}; }
        this._consumed.clear();
    },
    get(proxyKey) { return this._data[proxyKey] || null; },
    set(proxyKey, session) {
        this._data[proxyKey] = { ...session, timestamp: Date.now() };
        this._dirty = true;
        if (!this._timer) this._timer = setTimeout(() => this.flush(), 2000);
    },
    takeNext() {
        for (const key of Object.keys(this._data)) {
            if (!this._consumed.has(key)) {
                this._consumed.add(key);
                return { proxyRaw: key, ...this._data[key] };
            }
        }
        return null;
    },
    consume(proxyKey) {
        this._consumed.delete(proxyKey);
        if (this._data[proxyKey]) {
            delete this._data[proxyKey];
            this._dirty = true;
            if (!this._timer) this._timer = setTimeout(() => this.flush(), 2000);
        }
    },
    release(proxyKey) {
        // Return an unused entry back to the pool (un-reserve without deleting)
        this._consumed.delete(proxyKey);
    },
    get remaining() { return Object.keys(this._data).length - this._consumed.size; },
    get count() { return Object.keys(this._data).length; },
    async flush() {
        if (!this._dirty) return;
        this._dirty = false;
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        try {
            await fsp.mkdir(path.dirname(this._file), { recursive: true });
            await fsp.writeFile(this._file + '.tmp', JSON.stringify(this._data, null, 2));
            await fsp.rename(this._file + '.tmp', this._file);
        } catch (e) { this._dirty = true; }
    },
    async close() {
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        await this.flush();
    },
};

// ─── Protocol (handshake) ─────────────────────────────────────────────────────
const CDIV = Object.freeze([126, 57, 139, 92, 346, 36]);

function checksum(view, off, len, seed) {
    if (off + len > view.byteLength) len = 0;
    let s = 12354678 + seed;
    for (let i = 0; i < len; i++) s += view.getUint8(off + i) * (i + 4);
    return s + 3;
}

// ─── Bot ──────────────────────────────────────────────────────────────────────
const { WebSocket } = require('wreq-js');
const { HttpsProxyAgent } = require('https-proxy-agent');
const crypto = require('crypto');

class Bot {
    constructor(url, idx, pool, autoConnect = true) {
        this.idx = idx; this.pool = pool || null; this._retryT = null;
        this._reset();
        this.chunkIdx = Math.floor(idx / config.amount_per_ip);
        if (config.proxy && this.pool?._proxy) this._setProxy(this.pool._proxy.forChunk(this.chunkIdx));
        // Per-bot fingerprint
        this._ua = pickRandom(UA_POOL);
        this._acceptLang = pickRandom(ACCEPT_LANG_POOL);
        this.url = url;
        if (autoConnect) this._connect(url);
    }

    _reset() {
        this.clientkey = 0;
        this.random = 1 + ~~(53550 + 6e5 * Math.random());
        this.socket = null; this.j9 = 50; this.M_ = -1;
        this.confirmed = false; this.ag219 = ''; this.rq219 = false;
        this.alive = false; this.cookieStr = '';
        this.spawnInt = null; this.pingInt = null;
        if (!this._mouse) {
            this._mouse = new DataView(new ArrayBuffer(9));
            this._mouse.setUint8(0, OP.MOUSE);
        }
    }

    // ── Proxy ──
    _setProxy(raw) {
        if (!raw) return;
        this._proxyRaw = raw;
        Object.assign(this, parseProxy(raw));
        const proto = this.protocol || 'http';
        const auth = this.username ? `${encodeURIComponent(this.username)}:${encodeURIComponent(this.password)}@` : '';
        if (proto === 'socks4' || proto === 'socks5') {
            const { SocksProxyAgent } = require('socks-proxy-agent');
            this.agent = new SocksProxyAgent(`${proto}://${auth}${this.host}:${this.port}`);
            this.proxyStr = `${proto}://${auth}${this.host}:${this.port}`;
        } else {
            this.agent = new HttpsProxyAgent(`http://${auth}${this.host}:${this.port}`);
            this.proxyStr = `http://${auth}${this.host}:${this.port}`;
        }
    }
    _clearProxy() { this._proxyRaw = this.agent = this.username = this.password = this.host = this.port = this.proxyStr = null; }
    reset() {
        this._reset();
        if (config.proxy && this.pool?._proxy) this._setProxy(this.pool._proxy.forChunk(this.chunkIdx));
        else this._clearProxy();
    }

    // ── Timers ──
    _clearTimers() {
        clearInterval(this.pingInt); clearInterval(this.spawnInt);
        this.pingInt = this.spawnInt = null;
        if (this._retryT) { clearTimeout(this._retryT); this._retryT = null; }
    }

    // ── HTTP exchange ──
    async _exchangePuppeteer(url) {
        const puppeteer = require('puppeteer');
        const args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'];
        if (config.proxy && this.host) {
            const proto = this.protocol || 'http';
            args.push(`--proxy-server=${proto}://${this.host}:${this.port}`);
        }

        let browser;
        try {
            browser = await puppeteer.launch({ headless: 'new', args });
            const page = await browser.newPage();
            if (config.proxy && this.username) {
                await page.authenticate({ username: decodeURIComponent(this.username), password: decodeURIComponent(this.password) });
            }
            await page.setUserAgent(this._ua);

            // Bypass CF
            await page.goto('https://agma.io/', { waitUntil: 'domcontentloaded' });
            try { await page.waitForSelector('canvas#canvas', { timeout: 15000 }); } catch (_) { }

            // POST client.php
            const body1 = JSON.stringify({ cv: 4 * this.random, ch: this.j9, ccv: this.random - 2, vv: 158 });
            const r1Data = await page.evaluate(async (bodyStr) => {
                const res = await fetch('https://agma.io/client.php', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: 'data=' + encodeURIComponent(bodyStr)
                });
                return await res.text();
            }, body1);
            if (config.debugmode) console.log(`  [Debug] client.php response:`, r1Data);
            console.log(this.proxyLogin)
            const m = String(r1Data).match(/(\d+)/);
            if (m) this.clientkey = parseInt(m[0], 10);
            this.clientkey = decodeClientKey(this.clientkey);

            if (this.clientkey !== 0 && this.clientkey !== 8) {
                // POST ag219.php
                const body2 = JSON.stringify({ cv: 2 * this.random, ch: this.j9, ccv2: this.random - 2, abl: 254, cp: 62, vv: 158 });
                const r2Data = await page.evaluate(async (bodyStr) => {
                    const res = await fetch('https://agma.io/ag219.php', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: 'data=' + encodeURIComponent(bodyStr)
                    });
                    return await res.text();
                }, body2);
                if (config.debugmode) console.log(`  [Debug] ag219.php response:`, r2Data);
                const b2 = String(r2Data);
                const hm = b2.match(/<body>(.*?)<\/body>/);
                this.ag219 = hm ? hm[1] : b2.trim();
                this.rq219 = true;

                // Cookies
                const cookies = await page.cookies();
                this.cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
            }
        } finally {
            if (browser) await browser.close();
        }
    }

    async _exchange(url) {
        if (config.puppeteer) return this._exchangePuppeteer(url);

        // Per-bot TLS session with matching fingerprint
        const session = await createTLSSession(this._ua);
        const proxyUrl = config.proxy && this._proxyRaw
            ? (this.protocol || 'http') + '://' + (this.username ? `${this.username}:${this.password}@` : '') + `${this.host}:${this.port}`
            : undefined;
        const baseOpts = {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Origin': 'https://agma.io',
                'Referer': 'https://agma.io/',
                'User-Agent': this._ua,
                ...(this.cookieStr ? { 'Cookie': this.cookieStr } : {}),
            },
            ...(proxyUrl ? { proxy: proxyUrl } : {}),
        };

        try {
            // POST client.php
            const body1 = 'data=' + encodeURIComponent(JSON.stringify({ cv: 4 * this.random, ch: this.j9, ccv: this.random - 2, vv: 158 }));
            const r1 = await session.post('https://agma.io/client.php', { ...baseOpts, body: body1 });
            const r1Data = await r1.text();
            if (config.debugmode) console.log(`  [Debug] client.php response:`, r1Data);
            const m = String(r1Data).match(/(\d+)/);
            if (m) this.clientkey = parseInt(m[0], 10);
            this.clientkey = decodeClientKey(this.clientkey);
            if (this.clientkey !== 0 && this.clientkey !== 8) {
                if (this.pool?.jitter ?? config.jitter) await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
                // POST ag219.php
                const body2 = 'data=' + encodeURIComponent(JSON.stringify({ cv: 2 * this.random, ch: this.j9, ccv2: this.random - 2, abl: 254, cp: 62, vv: 158 }));
                const r2 = await session.post('https://agma.io/ag219.php', { ...baseOpts, body: body2 });
                const r2Data = await r2.text();
                if (config.debugmode) console.log(`  [Debug] ag219.php response:`, r2Data);
                const b2 = String(r2Data);
                const hm = b2.match(/<body>(.*?)<\/body>/);
                this.ag219 = hm ? hm[1] : b2.trim();
                this.rq219 = true;
                // Cookies
                const ck = r1.headers?.get?.('set-cookie') || r1.headers?.['set-cookie'];
                if (ck) {
                    this.cookieStr = (Array.isArray(ck) ? ck : [ck]).map(c => c.split(';')[0]).join('; ');
                }
            }
        } finally {
            try { await session.close(); } catch (_) { }
        }
    }

    // ── CF Clearance (inline — no separate service needed) ──
    async _fetchCfSession() {
        const proxy = config.proxy && this.host ? {
            host: this.host, port: parseInt(this.port, 10),
            ...(this.username ? { username: this.username, password: this.password } : {}),
        } : undefined;
        const res = await cfScraper.solve('https://agma.io/client.php', proxy);
        this._cfHeaders = res.headers || {};
        this._ua = res.headers?.['user-agent'] || this._ua;
        this.cookieStr = (res.cookies || []).map(c => `${c.name}=${c.value}`).join('; ');
        if (config.debugmode) console.log(`  ✓ CF session #${this.idx} (${(res.cookies || []).length} cookies)`);
    }

    // Apply a cached CF session onto this bot
    _applyCachedCfSession(entry) {
        this._cfHeaders = entry.headers || {};
        this._ua = entry.ua || this._ua;
        this._acceptLang = entry.acceptLang || this._acceptLang;
        this.cookieStr = entry.cookies || '';
        this._cfSolved = true;
    }

    // ── Connect ──
    async _connect(url) {
        this._aborted = false;
        // Fetch CF clearance cookies if enabled (skip if pre-solved in batch)
        if (config.cloudflare && !this._cfSolved) {
            try { await this._fetchCfSession(); } catch (e) {
                if (this._aborted) return;
                if (config.debugmode) console.error(`  ✗ CF #${this.idx}:`, e.message);
                this.close(false, true); return;
            }
            if (this._aborted) return;
        }
        this._cfSolved = false; // reset so future reconnects re-solve CF
        try { await this._exchange(url); } catch (e) {
            if (this._aborted) return;
            if (config.debugmode) console.error(`  ✗ TLS #${this.idx}:`, e.message);
            this.close(false, true); return;
        }
        this._cfSessionUsed = true; // Mark: CF session was actually used for HTTP
        if (this._aborted) return;
        if (this.clientkey === 8 || this.clientkey === 0) { this.close(); return; }

        this.confirmed = false; this.j9 = 60;

        if (this.pool?.jitter ?? config.jitter) await new Promise(r => setTimeout(r, 50 + Math.random() * 200));
        if (this._aborted) return;

        // Pick WS browser fingerprint matching the UA
        const wsBrowser = this._ua.includes('Firefox') ? 'firefox_133' : 'chrome_134';

        this.socket = new WebSocket(url, {
            headers: {
                'Accept-Encoding': 'gzip, deflate, br, zstd',
                'Accept-Language': this._acceptLang,
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Host': (() => { try { return new URL(url).host; } catch { return 'agma.io'; } })(),
                'Origin': 'https://agma.io',
                'User-Agent': this._ua,
                'Sec-Fetch-Site': 'same-site',
                'Sec-Fetch-Mode': 'websocket',
                'Sec-Fetch-Dest': 'websocket',
                ...(this.cookieStr ? { 'Cookie': this.cookieStr } : {}),
            },
            rejectUnauthorized: false, insecure: true, browser: wsBrowser,
            ...(config.proxy && this.proxyStr ? { proxy: this.proxyStr } : {}),
            ...(config.proxy && this.agent ? { agent: this.agent } : {}),
        });
        this.socket.binaryType = 'arraybuffer';
        this.socket.onopen = () => this._onOpen();
        this.socket.onmessage = m => this._onMsg(m);
        this.socket.onerror = e => { if (config.debugmode) console.log('WS err:', e.message); this.close(false, true); };
        this.socket.onclose = e => { if (config.debugmode) console.log('WS close:', e.code); this.close(false, true); };
    }

    // ── Handshake ──
    _onOpen() {
        const w = new Writer(14);
        w.setUint8(245).setUint16(62).setUint16(158).setUint32(this.random)
            .setUint32(checksum(w.buffer, 0, 9, 245));
        this.send(w);
    }

    // ── Messages ──
    _onMsg(msg) {
        const r = new Reader(msg, 0);
        if (r.buffer.getUint8(0) === OP.SRV_WRAPPER) r.position += 5;
        const op = r.getUint8();
        if (op === OP.SRV_CHALLENGE) this._onChallenge(r);
        else if (op === OP.SRV_CONNECTED) this._onConnected(r);
        else if (op === OP.SRV_CAPTCHA) { if (this.pool) this.pool._captcha++; }
        else if (op === OP.SRV_ACCOUNT_RESULT) this._onAccResult(r);
    }

    _onChallenge(r) {
        r.getUint32(); r.getUint32(); r.getUint32(); r.getUint32(); r.getInt16();
        const a = r.getUint32(), b = r.getUint32();
        r.getUint8(); r.getUint32(); r.getUint32(); r.getUint16(); r.getUint16();
        if (a === b && this.j9 < 70) {
            this.j9 += 40; this.M_ = a + 1;
            this._solveChallenge(0);
        }
    }

    _solveChallenge(retry) {
        if (this.socket?.readyState !== WebSocket.OPEN || this.M_ === -1 || retry) return;
        const mk = new Writer(3);
        mk.setUint8(0xf4).setString('').setUint16(0).setString('');
        this.send(mk);
        const w = new Writer(14);
        w.setUint8(0x2 * (this.j9 + 0x1e) - (this.M_ - 0x5) % 0xa - 0x5);
        this._computeMultiplier(0x2);
        const ck = this.clientkey;
        w.setUint32(
            0x1 + ~~((this.M_ / 14.1 + this.j9 / 0x2) - 0x2 * (retry ? 0.5 : 0x1)) +
            (~~(~~(22.29 * ((~~(this.M_ + 4.81 * this.random + 0x22f) % (ck - 1)) + 0x8f16)) / 4.2 + 0.4))
        );
        let s = 0;
        for (let i = 2; i < CDIV.length; i++) s += ~~(this.M_ / CDIV[i] - CDIV[i] % 162);
        w.setUint32(this._computeMultiplier(0x2) + s + 162 + 0x1);
        w.setUint32(checksum(w.buffer, 0, 9, 0xff));
        this.send(w);
    }

    _computeMultiplier(a, b) {
        return (0x2 == a) && this._computeMultiplier(typeof Event)
            ? (this._solveChallenge = () => { }, 0x2 * a + this.M_ / this.M_ * 1.88)
            : 0x2 == a && 0xa2 == this.M_ ? 0x2 * a + (this.M_ / this.M_) * 0.48
                : 0x2 == b ? 0x2 * a + b / 0x2 + this.M_ / this.M_ * 0.68
                    : 0x2 * a + this.M_ / this.M_ * 0.88;
    }

    _onConnected(r) {
        if (config.debugmode) console.log('  ✓ Connected');
        if (this.pool) this.pool._connected++;
        this.alive = true;
        if (r.buffer.byteLength === 1) {
            this.confirmed = true;
            this._sendAg219(0);
            if (!config.debugmode && !config.register) {
                this.send(PKT.S4_7_1); this.send(PKT.S4_8_0); this.send(PKT.S4_3_1);
                this.send(PKT.INVIS); this.send(PKT.D160_0);
                this.pingInt = setInterval(() => this.send(PKT.PING), 18_000);
            }
        }
        if (!config.register) {
            this._spawn(this.pool?.name ?? config.name);
            const acc = this.pool?.accounts?.get(this.idx);
            if (acc && config.useacc) this._login(acc.user, acc.pass);
            if (this.pool?.pelletLoop) {
                // Pellet loop: drop pellet at mouse then disconnect to reconnect
                const dropAndClose = () => {
                    if (!this.alive) return;
                    this.powerup(3, this.pool.pos.x, this.pool.pos.y);
                    setTimeout(() => { if (this.alive) this.close(false, false); }, 100);
                };
                setTimeout(dropAndClose, 150);
            } else if (this.pool?.battlemode ?? config.battlemode) {
                setTimeout(() => this.close(), 2500);
            }
        } else {
            setTimeout(() => this.register?.(), 3000);
        }
    }

    _onAccResult(r) {
        if (r.getUint8() === 9) {
            if (this.pool) this.pool._regDone++;
            console.log(`  ✓ Registered: ${this._pu} [${this.pool?._regDone || '?'}]`);
            this.pool?.accounts?.add(this._pu, this._pp);
        }
    }

    _sendAg219(tries) {
        if (this.socket?.readyState !== WebSocket.OPEN || tries > 10) return;
        if (this.ag219.length) {
            const w = new Writer(3 + 2 * this.ag219.length);
            w.setUint8(OP.SRV_CAPTCHA).setUint16(this.ag219.length).setString(this.ag219);
            this.send(w); this.rq219 = false;
        } else if (!this.rq219) {
            this._retryT = setTimeout(() => { this._retryT = null; this._sendAg219(tries + 1); }, 3000);
        }
    }

    // ── Actions ──
    _canSend(f) { return this.socket?.readyState === WebSocket.OPEN && (this.confirmed && this.socket.bufferedAmount < 8192 || f); }
    _cu(op) { if (this._canSend()) this.send(PKT.CU[op] || new Uint8Array([op])); }
    send(d) { if (this.socket?.readyState === WebSocket.OPEN && d) this.socket.send(d.buffer || d); }

    split() { this._cu(OP.SPLIT); }
    feed() { this._cu(OP.FEED_W); this._cu(OP.FEED_Z); }
    mouse(x, y) { this._mouse.setInt32(1, x, true); this._mouse.setInt32(5, y, true); if (this.confirmed) this.send(this._mouse); }

    _spawnBuf(name) {
        const b = new DataView(new ArrayBuffer(4 + 2 + 2 * name.length));
        b.setUint8(0, OP.SPAWN); b.setUint16(4, 0, true);
        for (let i = 0; i < name.length; i++) b.setUint16(4 + 2 * i, name.charCodeAt(i), true);
        return b;
    }
    _spawn(name = 'bot') { this._cu(OP.RESPAWN_CLEAR); this.send(this._spawnBuf(name)); }
    respawn(name = 'bot') { this._cu(OP.CLEAR_SPAWN); this._cu(OP.RESPAWN_CLEAR); this.send(this._spawnBuf(name)); }

    startSpawn(fn) { this.spawnInt = setInterval(() => this._spawn(fn()), 1500); }
    stopSpawn() { clearInterval(this.spawnInt); this.spawnInt = null; }

    _login(u, p) {
        const w = new Writer(5 + 2 * u.length + 2 * p.length);
        w.setUint8(OP.LOGIN).setString(u).setUint16(0).setString(p).setUint16(0); this.send(w);
    }
    chat(msg) {
        const b = new DataView(new ArrayBuffer(2 + 2 * msg.length));
        b.setUint8(0, OP.CHAT); b.setUint8(1, 1);
        for (let i = 0; i < msg.length; i++) b.setUint16(2 + 2 * i, msg.charCodeAt(i), true);
        this.send(b);
    }
    powerup(id, x, y) {
        const w = new Writer(10);
        w.setUint8(OP.POWERUP).setInt32(x).setInt32(y).setUint8(id); this.send(w);
    }
    frozenvirus(v) {
        this.send(PKT.FROZEN[v] || new Uint8Array([OP.FROZEN_VIRUS, v]));
        if (v !== 0 && v !== 1) { this.send(PKT.WZ_21); this.send(PKT.WZ_36); }
    }
    rndStr(n) {
        const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let s = ''; for (let i = 0; i < n; i++) s += c[~~(Math.random() * c.length)]; return s;
    }

    // ── Close ──
    close(remove, err) {
        this._aborted = true;
        // CF cache: consume if session was used, release if not
        if (config.cf_cache && this._proxyRaw) {
            if (this._cfSessionUsed) cfCache.consume(this._proxyRaw);
            else cfCache.release(this._proxyRaw);
            this._cfSessionUsed = false;
        }
        if (this._retryT) { clearTimeout(this._retryT); this._retryT = null; }
        if (this.alive) { this.alive = false; if (this.pool) this.pool._connected = Math.max(0, this.pool._connected - 1); }
        if (this.socket) {
            this.socket.onopen = this.socket.onmessage = this.socket.onclose = this.socket.onerror = null;
            try { this.socket.close(); this._clearTimers(); } catch (_) { }
            this.socket = null;
        }
        if (config.register && this._onRegClose) { this._onRegClose(); return; }
        // Pellet loop: auto-reconnect after a short delay
        if (this.pool?.pelletLoop && !remove) {
            if (!this.url || !this.url.startsWith('wss://')) return;
            this._retryT = setTimeout(() => {
                if (!this.pool?.pelletLoop) return; // mode was turned off
                try { this.reset(); this._connect(this.url); } catch (_) { }
            }, 200 + Math.random() * 300);
            return;
        }
        if (err === false) this.reset();
        else if (remove && this.pool) this.pool.remove(this);
    }
}

// ─── RegisterBot ──────────────────────────────────────────────────────────────
const regIdx = [];
let regSeq = 0;

class RegisterBot extends Bot {
    constructor(url, tid, end, start, pool) {
        super(url, regSeq++, pool);
        this.tid = tid; this.end = end;
        if (regIdx[tid] === undefined || regIdx[tid] < start) regIdx[tid] = start;
    }
    async register() {
        const n = regIdx[this.tid]++;
        if (n > this.end) return;
        const pass = this.rndStr(8);
        const md5 = crypto.createHash('md5').update(pass).digest('hex');
        const name = this.rndStr(9) + n;
        this._pu = name; this._pp = md5;
        console.log(`  [T${this.tid}] ${name} | ${pass} | ${md5} (${n}/${this.end})`);
        try {
            const svc = this.pool?.captcha || new CaptchaService();
            const tok = await svc.solve({ host: this.host, port: this.port, username: this.username, password: this.password });
            const tw = new Writer(3 + 2 * tok.length);
            tw.setUint8(OP.CAPTCHA_INPUT).setUint16(tok.length).setString(tok); this.send(tw);
        } catch (e) { console.error(`  ✗ [T${this.tid}] captcha:`, e.message); this.close(); return; }
        const email = name + '@gmail.com';
        setTimeout(() => {
            const w = new Writer(15 + 2 * name.length + 2 * md5.length + 2 * email.length);
            w.setUint8(OP.REGISTER).setString(name).setUint16(0).setString(md5).setUint16(0)
                .setString(email).setUint16(0).setUint32(0).setUint32(0);
            this.send(w);
        }, 3000);
        setTimeout(() => this.close(), 9000);
    }
    _onRegClose() {
        const next = regIdx[this.tid];
        if (next <= this.end) {
            setTimeout(() => {
                const b = new RegisterBot('wss://s6.agma.io:2053/', this.tid, this.end, next, this.pool);
                this.pool?.bots.push(b);
            }, 500);
        } else { console.log(`  [Thread ${this.tid}] done.`); }
        this.pool?.remove(this);
    }
}

// ─── BotPool ──────────────────────────────────────────────────────────────────
const EventEmitter = require('events');

class BotPool extends EventEmitter {
    constructor(accounts, opts = {}) {
        super();
        this.bots = []; this._connected = 0; this._captcha = 0; this._regDone = 0;
        this._randomNames = false; this.pos = { x: 0, y: 0 };
        this.accounts = accounts || null; this.captcha = new CaptchaService();
        this._statT = null; this._mouseT = null;
        // Per-session settings (defaults from config)
        this.battlemode = opts.battlemode ?? config.battlemode;
        this.jitter = opts.jitter ?? config.jitter;
        this._proxy = opts.proxy ?? (config.proxy_mode === 'v6' ? proxyV6 : proxyV4);
        this.name = opts.name ?? config.name;
        this.pelletLoop = false;
    }
    getStats() { return { connected: this._connected, total: this.bots.length, captcha: this._captcha }; }

    async create(n, url) {
        if (this.bots.length) this.disconnectAll();

        if (config.cloudflare && config.cf_cache && cfCache.count > 0) {
            // CF cache has entries → use cached sessions (single-use)
            const available = Math.min(n, cfCache.remaining);
            if (available < n) {
                log.warn(`CF cache: only ${cfCache.remaining} remaining, requested ${n}`);
            }
            for (let i = 0; i < available; i++) {
                const entry = cfCache.takeNext();
                if (!entry) break;
                const bot = new Bot(url, this.bots.length, this, false);
                bot._setProxy(entry.proxyRaw);
                bot._applyCachedCfSession(entry);
                this.bots.push(bot);
            }
            log.info(`Connecting ${this.bots.length} bots from CF cache (${cfCache.remaining} remaining)...`);
            // Connect with staggered delay
            for (const b of this.bots) {
                b._connect(url);
                await new Promise(r => setTimeout(r, 50 + Math.random() * 80));
            }
        } else if (config.cloudflare) {
            // No cache → normal pre-solve flow (solve n, then connect n)
            for (let i = 0; i < n; i++) {
                this.bots.push(new Bot(url, this.bots.length, this, false));
            }
            let solved = 0, failed = 0;
            console.log(`  ⏳ Pre-solving ${n} CF sessions (${cfScraper._maxConcurrent} concurrent)...`);
            await Promise.allSettled(this.bots.map(b =>
                b._fetchCfSession().then(
                    () => { b._cfSolved = true; solved++; console.log(`  ✓ CF ${solved}/${n}`); },
                    (e) => { failed++; if (config.debugmode) console.error(`  ✗ CF #${b.idx}:`, e.message); }
                )
            ));
            this.bots = this.bots.filter(b => b._cfSolved);
            console.log(`  ✅ ${solved}/${n} CF sessions ready${failed ? `, ${failed} failed` : ''}. Connecting all...`);
            for (const b of this.bots) {
                b._connect(url);
                await new Promise(r => setTimeout(r, 50 + Math.random() * 80));
            }
        } else {
            // No CF: original flow
            for (let i = 0; i < n; i++) {
                this.bots.push(new Bot(url, this.bots.length, this));
                if (this.jitter) await new Promise(r => setTimeout(r, 150 + Math.random() * 250));
            }
        }

        this._startIntervals();
    }

    _startIntervals() {
        if (config.debugmode) return;
        if (!this._statT) {
            this._statT = setInterval(() => {
                this.emit('stats', this.getStats());
            }, 500);
        }
        if (!this._mouseT) {
            this._mouseT = setInterval(() => {
                for (let i = 0; i < this.bots.length; i++) this.bots[i].mouse(this.pos.x, this.pos.y);
            }, 100);
        }
    }

    remove(bot) { const i = this.bots.indexOf(bot); if (i !== -1) this.bots.splice(i, 1); }

    _cleanupZombies() {
        for (const b of this.bots) { if (b._retryT) { clearTimeout(b._retryT); b._retryT = null; } }
        this.bots = this.bots.filter(b => b.alive);
        this._connected = this.bots.filter(b => b.alive).length;
        this.emit('stats', this.getStats());
    }

    disconnectAll() {
        const snapshot = this.bots.slice(); // snapshot to avoid splice-while-iterating
        this.bots.length = 0;
        for (const b of snapshot) {
            if (b._retryT) { clearTimeout(b._retryT); b._retryT = null; }
            try { b.close(true, false); } catch (_) { }
        }
        this._connected = 0; this._captcha = 0;
        if (this._statT) { clearInterval(this._statT); this._statT = null; }
        if (this._mouseT) { clearInterval(this._mouseT); this._mouseT = null; }
        this._proxy.resetChunks();
        this.emit('stats', this.getStats());
    }

    async shutdown() { this.disconnectAll(); await this.accounts?.close(); }
}

// ─── Command handlers (per-session) ──────────────────────────────────────────
function makeHandlers(session) {
    return {
        0: r => { const url = r.toString('utf16le', 1).replace(/\0/g, ''); session.pool.name = session.name; log.session(session.id, 'START', `${session.amount} bots → ${C.dim}${url}${C.r}`); session.pool.create(session.amount, url); },
        1: () => session.pool.bots.forEach(b => b.split()),
        2: () => session.pool.bots.forEach(b => b.respawn(session.pool._randomNames ? b.rndStr(5) : session.name)),
        3: () => {
            session.pool.bots.forEach(b => b.powerup(3, session.pool.pos.x, session.pool.pos.y));
            // setTimeout(() => session.pool.bots.forEach(b => b.powerup(8, Math.random() * 18000, Math.random() * 18000)), 500);
        },
        4: () => {
            session.pool.bots.forEach(b => b.frozenvirus(3));
            [[500, b => b.frozenvirus(0)], [1000, b => b.frozenvirus(1)], [1200, b => b.feed()],
            [1400, b => b.feed()], [1600, b => b.feed()], [1800, b => b.feed()], [2000, b => b.feed()]]
                .forEach(([d, fn]) => setTimeout(() => session.pool.bots.forEach(fn), d));
        },
        5: () => { session.pool.disconnectAll(); log.session(session.id, 'STOP', 'All bots disconnected'); },
        6: () => session.pool.bots.forEach(b => b.startSpawn(() => session.pool._randomNames ? b.rndStr(5) : session.name)),
        7: () => session.pool.bots.forEach(b => b.stopSpawn()),
        8: r => { const msg = r.toString('utf16le', 1).replace(/\0/g, ''); session.pool.bots.forEach(b => b.chat(msg)); },
        9: r => { session.pool.pos.x = r.readDoubleLE(1); session.pool.pos.y = r.readDoubleLE(9); },
        11: async () => { log.session(session.id, 'SHUTDOWN', 'Session closed'); await session.pool.shutdown(); },
        12: r => { session.amount = r.readUInt16LE(1); log.session(session.id, 'CONFIG', `amount=${C.bold}${session.amount}${C.r}`); },
        13: r => {
            session.name = r.toString('utf16le', 1).replace(/\0/g, ''); session.pool.name = session.name;
            log.session(session.id, 'CONFIG', `name="${C.bold}${session.name}${C.r}"`);
            session.pool.bots.forEach(b => b.respawn(session.name));
        },
        14: r => {
            const mode = r.readUInt8(1) === 1 ? 'v6' : 'v4';
            session.pool._proxy = mode === 'v6' ? proxyV6 : proxyV4;
            log.session(session.id, 'CONFIG', `proxy=${C.bold}${mode}${C.r} (${session.pool._proxy.count})`);
        },
        15: r => {
            session.pool.battlemode = r.readUInt8(1) === 1;
            log.session(session.id, 'CONFIG', `battle=${session.pool.battlemode ? `${C.green}ON` : `${C.red}OFF`}${C.r}`);
        },
        16: r => {
            session.pool.jitter = r.readUInt8(1) === 1;
            log.session(session.id, 'CONFIG', `jitter=${session.pool.jitter ? `${C.green}ON` : `${C.red}OFF`}${C.r}`);
        },
        17: r => {
            session.pool.pelletLoop = r.readUInt8(1) === 1;
            if (!session.pool.pelletLoop) session.pool._cleanupZombies();
            log.session(session.id, 'CONFIG', `pelletLoop=${session.pool.pelletLoop ? `${C.green}ON` : `${C.red}OFF`}${C.r}`);
        },
    };
}

// ─── Logging & Dashboard ──────────────────────────────────────────────────────
const C = {
    r: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    cyan: '\x1b[36m', magenta: '\x1b[35m', gray: '\x1b[90m', white: '\x1b[37m',
};
const SESSION_COLORS = [C.cyan, C.magenta, C.green, C.yellow, C.red, C.white];
function ts() { return new Date().toLocaleTimeString('en-GB'); }

const dashboard = {
    sessions: new Map(),
    events: [],
    maxEvents: 12,
    _t: null,
    active: false,
    add(id, session) { this.sessions.set(id, session); },
    remove(id) { this.sessions.delete(id); },
    event(icon, msg) {
        this.events.push(`${C.gray}${ts()}${C.r}  ${icon}  ${msg}`);
        if (this.events.length > 50) this.events.splice(0, this.events.length - this.maxEvents);
    },
    start() {
        this.active = true;
        process.stdout.write('\x1b[?25l\x1b[2J');
        this._t = setInterval(() => this.render(), 500);
    },
    stop() { clearInterval(this._t); process.stdout.write('\x1b[?25h'); },
    render() {
        const L = [];
        L.push('');
        L.push(`  ${C.bold}${C.cyan}\u2b21 AGMA BOT${C.r}  ${C.dim}${ts()}${C.r}`);
        L.push(`  ${C.gray}${'─'.repeat(54)}${C.r}`);
        const cfInfo = config.cf_cache ? `  ${C.dim}CF Cache: ${C.bold}${cfCache.remaining}${C.r}${C.dim} remaining${C.r}` : '';
        L.push(`  ${C.dim}Proxies${C.r}  v4: ${C.bold}${proxyV4.count}${C.r}  v6: ${C.bold}${proxyV6.count}${C.r}${cfInfo}  ${C.dim}Port: ${config.server_port}${C.r}`);
        L.push('');
        if (!this.sessions.size) {
            L.push(`  ${C.dim}No active sessions — waiting for panel...${C.r}`);
            L.push('');
        } else {
            L.push(`  ${C.dim}#   BOTS      PROGRESS              PROXY  \u2694   \u23f1${C.r}`);
            L.push(`  ${C.gray}${'─'.repeat(54)}${C.r}`);
            for (const [id, s] of this.sessions) {
                const st = s.pool.getStats();
                const pct = st.total ? Math.round(st.connected / st.total * 100) : 0;
                const bar = '\u2588'.repeat(Math.round(pct / 5)).padEnd(20, '\u2591');
                const c = SESSION_COLORS[(id - 1) % SESSION_COLORS.length];
                const bots = `${st.connected}/${st.total}`;
                const px = (s.pool._proxy === proxyV6 ? 'v6' : 'v4').padEnd(4);
                const bt = s.pool.battlemode ? `${C.green}ON ${C.r}` : `${C.red}OFF${C.r}`;
                const jt = s.pool.jitter ? `${C.green}ON ${C.r}` : `${C.red}OFF${C.r}`;
                const pl = s.pool.pelletLoop ? `${C.green}\u25cf${C.r}` : `${C.dim}\u25cb${C.r}`;
                L.push(`  ${c}#${id}${C.r}  ${C.green}${bots.padEnd(8)}${C.r}  ${C.cyan}${bar}${C.r}  ${px}  ${bt}  ${jt}  ${pl}`);
            }
            L.push('');
        }
        process.stdout.write('\x1b[2J\x1b[3J\x1b[H' + L.join('\n') + '\n');
    },
};

const log = {
    ok(msg) {
        if (dashboard.active) dashboard.event(`${C.green}\u2714${C.r}`, msg);
        else console.log(`  ${C.gray}${ts()}${C.r}  ${C.green}\u2714${C.r}  ${msg}`);
    },
    warn(msg) {
        if (dashboard.active) dashboard.event(`${C.yellow}\u26a0${C.r}`, msg);
        else console.log(`  ${C.gray}${ts()}${C.r}  ${C.yellow}\u26a0${C.r}  ${msg}`);
    },
    info(msg) {
        if (dashboard.active) dashboard.event(`${C.cyan}\u2139${C.r}`, msg);
        else console.log(`  ${C.gray}${ts()}${C.r}  ${C.cyan}\u2139${C.r}  ${msg}`);
    },
    session(id, tag, msg) {
        const c = SESSION_COLORS[(id - 1) % SESSION_COLORS.length];
        const icon = `${c}#${id}${C.r}`;
        const label = `${C.dim}${tag.padEnd(8)}${C.r} ${msg}`;
        if (dashboard.active) dashboard.event(icon, label);
        else console.log(`  ${C.gray}${ts()}${C.r}  ${icon} ${label}`);
    },
};

// ─── Server ───────────────────────────────────────────────────────────────────
const WSServer = require('ws');
const express = require('express');
const cors = require('cors');

let _sessionCounter = 0;

function startServer() {
    const app = express(); app.use(cors());
    const wss = new WSServer.Server({ noServer: true });

    wss.on('connection', ws => {
        const id = ++_sessionCounter;
        const accounts = new AccountStore();
        accounts.load();
        const pool = new BotPool(accounts);
        const session = { id, pool, amount: config.amount, name: config.name };
        const handlers = makeHandlers(session);
        dashboard.add(id, session);

        pool.on('stats', stats => {
            if (ws.readyState !== WSServer.OPEN) return;
            const b = Buffer.alloc(7);
            b.writeUInt8(10, 0); b.writeUInt16LE(stats.connected, 1);
            b.writeUInt16LE(stats.total, 3); b.writeUInt16LE(stats.captcha, 5);
            ws.send(b);
        });

        log.ok(`Panel ${C.bold}#${id}${C.r} connected`);
        ws.on('message', msg => {
            try { const r = Buffer.from(msg), h = handlers[r.readUInt8(0)]; if (h) h(r); }
            catch (e) { log.warn(`Handler error [#${id}]`); }
        });
        ws.on('close', () => {
            log.warn(`Panel ${C.bold}#${id}${C.r} disconnected`);
            pool.disconnectAll();
            dashboard.remove(id);
        });
    });

    const srv = app.listen(config.server_port, () => {
        log.ok(`Panel server on ${C.bold}:${config.server_port}${C.r}`);
        dashboard.start();
    });
    srv.on('upgrade', (req, sock, head) => wss.handleUpgrade(req, sock, head, ws => wss.emit('connection', ws, req)));
    return srv;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    await proxyV4.load(['data/proxyv4.txt', 'proxyv4.txt', 'data/proxy.txt', 'proxy.txt']);
    await proxyV6.load(['data/proxyv6.txt', 'proxyv6.txt']);

    // Launch CF scraper browsers if cloudflare mode is enabled
    if (config.cloudflare) {
        if (config.cf_cache) {
            await cfCache.load();
            if (cfCache.count > 0) {
                log.ok(`CF cache loaded: ${cfCache.count} sessions ready`);
            } else {
                // No cache → solve all proxies upfront, save, exit
                await cfScraper.init();
                const pool = config.proxy_mode === 'v6' ? proxyV6 : proxyV4;
                const allProxies = pool.list;
                if (!allProxies.length) { console.error('  ✗ No proxies loaded for CF solving'); process.exit(1); }
                console.log(`  ⏳ Solving CF for all ${allProxies.length} proxies (${cfScraper._maxConcurrent} concurrent)...`);
                let solved = 0, failed = 0;
                const tasks = allProxies.map(proxyRaw => {
                    const tmpBot = new Bot('', 0, null, false);
                    tmpBot._setProxy(proxyRaw);
                    return cfScraper.solve('https://agma.io/client.php', {
                        host: tmpBot.host, port: parseInt(tmpBot.port, 10),
                        ...(tmpBot.username ? { username: tmpBot.username, password: tmpBot.password } : {}),
                    }).then(res => {
                        const ua = res.headers?.['user-agent'] || tmpBot._ua;
                        const cookieStr = (res.cookies || []).map(c => `${c.name}=${c.value}`).join('; ');
                        cfCache.set(proxyRaw, {
                            cookies: cookieStr,
                            headers: res.headers || {},
                            ua,
                            acceptLang: tmpBot._acceptLang,
                        });
                        solved++;
                        console.log(`  ✓ CF ${solved}/${allProxies.length}`);
                    }).catch(e => {
                        failed++;
                        if (config.debugmode) console.error(`  ✗ CF ${proxyRaw.split(':')[0]}:`, e.message);
                    });
                });
                await Promise.allSettled(tasks);
                await cfCache.flush();
                console.log(`\n  ✅ Done! Solved ${solved}/${allProxies.length}${failed ? `, ${failed} failed` : ''}`);
                console.log(`  📁 Saved to ${cfCache._file}`);
                console.log(`  ▶  Run again to connect bots using cached sessions.\n`);
                await cfScraper.shutdown();
                process.exit(0);
            }
        } else {
            await cfScraper.init();
        }
    }

    if (!config.debugmode && !config.register) return startServer();

    // Non-dashboard modes: print banner
    const mode = config.register ? 'REGISTER' : 'DEBUG';
    const mc = config.register ? C.magenta : C.yellow;
    console.log(`\n  ${C.bold}${C.cyan}\u2b21 AGMA BOT${C.r}  ${mc}${C.bold}${mode}${C.r}`);
    console.log(`  ${C.gray}${'─'.repeat(40)}${C.r}`);
    if (proxyV4.count) log.ok(`${proxyV4.count} proxies (v4)`);
    if (proxyV6.count) log.ok(`${proxyV6.count} proxies (v6)`);

    const accounts = new AccountStore();
    await accounts.load();
    const pool = new BotPool(accounts);

    if (config.debugmode) {
        log.info(`Debug \u2192 ${config.serverUrl}`);
        return pool.create(config.amount, config.serverUrl);
    }

    const total = config.register_count, threads = config.register_threads;
    const per = Math.ceil(total / threads);
    log.info(`Register ${total} / ${threads} threads`);
    for (let t = 0; t < threads; t++) {
        const s = t * per + 1, e = Math.min((t + 1) * per, total);
        if (s > total) break;
        regIdx[t] = s; log.info(`  [T${t}] ${s}–${e}`);
        setTimeout(() => { const b = new RegisterBot('wss://s6.agma.io:2053/', t, e, s, pool); pool.bots.push(b); }, t * 3000);
    }
}

process.on('SIGINT', async () => { dashboard.stop(); for (const s of dashboard.sessions.values()) s.pool.disconnectAll(); await cfCache.close(); await cfScraper.shutdown(); await closeTLS(); process.exit(0); });
process.on('uncaughtException', async e => { dashboard.stop(); console.error('uncaught:', e.message); await cfCache.close(); await cfScraper.shutdown(); await closeTLS(); process.exit(1); });
process.on('unhandledRejection', e => { /* swallow to avoid crashing server */ });

main();
