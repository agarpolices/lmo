'use strict';

// ─── Standalone Proxy Scraper ─────────────────────────────────────────────────
// Run this BEFORE starting bot.js:   node proxy-scraper.js
// It scrapes free proxy lists, validates each against agma.io,
// and writes all working proxies to proxy.txt.
// Your bot.js reads proxy.txt as-is — zero changes needed.
//
// Usage:
//   node proxy-scraper.js              → scrape + validate + write proxy.txt
//   node proxy-scraper.js --append     → append to existing proxy.txt instead of overwrite

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const CONCURRENCY = 100;           // Parallel validation workers
const VALIDATE_TIMEOUT = 12000;   // 12s timeout per proxy (some slow proxies need more time)
const OUTPUT_FILE = path.join(__dirname, 'proxy.txt');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

// ─── CLI Args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const APPEND_MODE = args.includes('--append');

// ─── Proxy Sources ────────────────────────────────────────────────────────────
const SOURCES = [
    // HTTP sources
    { url: 'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt', protocol: 'http' },
    { url: 'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks5.txt', protocol: 'socks5' },
    { url: 'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/http/data.txt', protocol: 'http' },
    { url: 'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/socks5/data.txt', protocol: 'socks5' },
    { url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt', protocol: 'http' },
    { url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt', protocol: 'socks5' },
    // Extra sources for more volume
    { url: 'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt', protocol: 'socks5' },
    { url: 'https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt', protocol: 'http' },
    { url: 'https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/socks5.txt', protocol: 'socks5' },
    { url: 'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt', protocol: 'http' },
    { url: 'https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS5_RAW.txt', protocol: 'socks5' },
    { url: 'https://raw.githubusercontent.com/ErcinDedeworksWordeWordeWorksWordes/proxy-list/main/proxy-list/data.txt', protocol: 'http' },
    { url: 'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/generated/http_proxies.txt', protocol: 'http' },
    { url: 'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/generated/socks5_proxies.txt', protocol: 'socks5' },
    { url: 'https://api.openproxylist.xyz/http.txt', protocol: 'http' },
    { url: 'https://api.openproxylist.xyz/socks5.txt', protocol: 'socks5' },
    { url: 'https://raw.githubusercontent.com/FLAVOR-FLAVOR/proxy-list/main/proxy-list-main/http.txt', protocol: 'http' },
    { url: 'https://raw.githubusercontent.com/FLAVOR-FLAVOR/proxy-list/main/proxy-list-main/socks5.txt', protocol: 'socks5' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fetchText(url, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, { headers: { 'User-Agent': UA }, timeout: timeoutMs }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchText(res.headers.location, timeoutMs).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

function parseProxyLines(text, protocol) {
    const results = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;

        let proto = protocol;
        let clean = line;

        const protoMatch = clean.match(/^(https?|socks[45]):\/{2}/i);
        if (protoMatch) {
            proto = protoMatch[1].toLowerCase();
            clean = clean.slice(protoMatch[0].length);
        }

        const [host, portStr] = clean.split(':');
        if (!host || !portStr || isNaN(+portStr)) continue;

        results.push({ host, port: +portStr, protocol: proto });
    }
    return results;
}

async function parallelLimit(tasks, limit) {
    const results = [];
    let idx = 0;
    const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
        while (idx < tasks.length) {
            const i = idx++;
            try { results[i] = await tasks[i](); }
            catch { results[i] = null; }
        }
    });
    await Promise.all(workers);
    return results;
}

// ─── Validator ────────────────────────────────────────────────────────────────
const { WebSocket } = require('wreq-js');
const { HttpsProxyAgent } = require('https-proxy-agent');

const WS_TEST_URL = 'wss://s22.agma.io:453/';

function validateProxy(p) {
    return new Promise((resolve) => {
        let resolved = false;
        const done = (result) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            try { ws.close(); } catch { }
            resolve(result);
        };

        const timer = setTimeout(() => done(false), VALIDATE_TIMEOUT);

        // Build proxy string matching what bot.js uses
        let proxyStr, agent;
        if (p.protocol === 'socks5' || p.protocol === 'socks4') {
            const { SocksProxyAgent } = require('socks-proxy-agent');
            proxyStr = `${p.protocol}://${p.host}:${p.port}`;
            agent = new SocksProxyAgent(proxyStr);
        } else {
            proxyStr = `http://${p.host}:${p.port}`;
            agent = new HttpsProxyAgent(proxyStr);
        }

        let ws;
        try {
            ws = new WebSocket(WS_TEST_URL, {
                headers: {
                    'Host': 's22.agma.io:453',
                    'Origin': 'https://agma.io',
                    'User-Agent': UA,
                },
                rejectUnauthorized: false,
                insecure: true,
                browser: 'chrome_134',
                proxy: proxyStr,
                agent: agent,
            });

            ws.onopen = () => done(true);   // Socket opened = proxy works!
            ws.onerror = () => done(false);
            ws.onclose = () => done(false);
        } catch {
            done(false);
        }
    });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function log(msg) {
    process.stdout.write(msg);
}

async function main() {
    console.log('\n\x1b[90m  ──────────────────────────────────────\x1b[0m');
    console.log('  \x1b[1m\x1b[36m🔄 PROXY SCRAPER\x1b[0m');
    console.log('\x1b[90m  ──────────────────────────────────────\x1b[0m');
    console.log(`  Sources: ${SOURCES.length}  Concurrency: ${CONCURRENCY}  Timeout: ${VALIDATE_TIMEOUT / 1000}s`);
    console.log(`  Mode: ${APPEND_MODE ? 'append' : 'overwrite'}  Protocols: HTTP + SOCKS5`);
    console.log('\x1b[90m  ──────────────────────────────────────\x1b[0m\n');

    // 1. Fetch all sources
    console.log('  \x1b[36m①\x1b[0m Fetching proxy lists...');
    const allProxies = [];
    const seen = new Set();

    const fetchResults = await Promise.allSettled(
        SOURCES.map(async src => {
            try {
                const text = await fetchText(src.url);
                const proxies = parseProxyLines(text, src.protocol);
                console.log(`    \x1b[32m✓\x1b[0m ${src.protocol.padEnd(6)} ${proxies.length.toString().padStart(5)} proxies from ${new URL(src.url).hostname}`);
                return proxies;
            } catch (e) {
                console.log(`    \x1b[31m✗\x1b[0m ${src.protocol.padEnd(6)} FAILED from ${new URL(src.url).hostname}: ${e.message}`);
                return [];
            }
        })
    );

    for (const r of fetchResults) {
        if (r.status === 'fulfilled') {
            for (const p of r.value) {
                const key = `${p.host}:${p.port}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    allProxies.push(p);
                }
            }
        }
    }

    console.log(`\n  \x1b[36m②\x1b[0m Deduplicated: \x1b[1m${allProxies.length}\x1b[0m unique proxies\n`);

    if (!allProxies.length) {
        console.log('  \x1b[31m✗\x1b[0m No proxies found. Check your internet connection.');
        process.exit(1);
    }

    // 2. Validate against agma.io
    console.log(`  \x1b[36m③\x1b[0m Validating against agma.io (${CONCURRENCY} workers)...`);
    const working = [];
    let tested = 0;
    const total = allProxies.length;
    const startTime = Date.now();

    // ── Graceful Ctrl+C: save whatever we have so far ──
    const onSIGINT = () => {
        console.log('\n\n  \x1b[33m⚠ Interrupted!\x1b[0m Saving what we have...');
        saveResults(working, total);
        process.exit(0);
    };
    process.on('SIGINT', onSIGINT);

    const tasks = allProxies.map(p => async () => {
        const ok = await validateProxy(p);
        tested++;

        if (ok) {
            working.push(p);
            log(`\r    \x1b[32m✓\x1b[0m ${tested}/${total} tested | \x1b[32m${working.length} working\x1b[0m  `);
        } else if (tested % 50 === 0 || tested === total) {
            log(`\r    \x1b[90m…\x1b[0m ${tested}/${total} tested | \x1b[32m${working.length} working\x1b[0m  `);
        }

        return ok;
    });

    await parallelLimit(tasks, CONCURRENCY);
    process.removeListener('SIGINT', onSIGINT);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n\n  \x1b[36m④\x1b[0m Done in ${elapsed}s`);

    if (!working.length) {
        console.log('  \x1b[31m✗\x1b[0m No working proxies found. Free proxies may be exhausted.');
        console.log('    Try again later or add your own paid proxies to proxy.txt\n');
        process.exit(1);
    }

    saveResults(working, total);
}

// ─── Save Results ─────────────────────────────────────────────────────────────

function formatProxy(p) {
    if (p.protocol === 'socks5') return `socks5://${p.host}:${p.port}`;
    if (p.protocol === 'socks4') return `socks4://${p.host}:${p.port}`;
    return `http://${p.host}:${p.port}`;
}

function saveResults(working, total) {
    if (!working.length) {
        console.log('  \x1b[31m✗\x1b[0m No working proxies to save.');
        return;
    }

    const lines = working.map(formatProxy);

    if (APPEND_MODE) {
        let existing = '';
        try { existing = fs.readFileSync(OUTPUT_FILE, 'utf8'); } catch { }
        const existingSet = new Set(existing.split(/\r?\n/).map(l => l.trim()).filter(Boolean));
        const newLines = lines.filter(l => !existingSet.has(l));
        if (newLines.length) {
            const append = (existing.endsWith('\n') ? '' : '\n') + newLines.join('\n') + '\n';
            fs.appendFileSync(OUTPUT_FILE, append);
            console.log(`  \x1b[32m✓\x1b[0m Appended \x1b[1m${newLines.length}\x1b[0m new proxies to proxy.txt (${existingSet.size} already existed)`);
        } else {
            console.log(`  \x1b[33m⚠\x1b[0m All ${working.length} working proxies already in proxy.txt`);
        }
    } else {
        fs.writeFileSync(OUTPUT_FILE, lines.join('\n') + '\n');
        console.log(`  \x1b[32m✓\x1b[0m Wrote \x1b[1m${working.length}\x1b[0m working proxies to proxy.txt`);
    }

    console.log('\n\x1b[90m  ──────────────────────────────────────\x1b[0m');
    console.log(`  \x1b[1m\x1b[32m✓ COMPLETE\x1b[0m  ${working.length}/${total} proxies work (${(working.length / total * 100).toFixed(1)}%)`);
    console.log('  Now run: \x1b[36mnode bot.js\x1b[0m');
    console.log('\x1b[90m  ──────────────────────────────────────\x1b[0m\n');
}

main().catch(e => {
    console.error('\n  \x1b[31m✗ Fatal:\x1b[0m', e.message);
    process.exit(1);
});
