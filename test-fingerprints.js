'use strict';

const fs = require('fs');
const { Session: TLSSession, ClientIdentifier, initTLS, destroyTLS } = require('node-tls-client');

// ─── All UAs from bot.js ─────────────────────────────────────────────────────
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

// All CF-passing TLS IDs (matches bot.js exactly)
const CHROME_TLS = [
    'chrome_103', 'chrome_104', 'chrome_105', 'chrome_106',
    'chrome_107', 'chrome_108', 'chrome_109', 'chrome_110',
    'chrome_111', 'chrome_112', 'chrome_116_PSK', 'chrome_117',
    'chrome_131', 'chrome_131_psk',
];
const FIREFOX_TLS = [
    'firefox_102', 'firefox_104', 'firefox_105', 'firefox_106',
    'firefox_108', 'firefox_110', 'firefox_117', 'firefox_120',
    'firefox_123', 'firefox_132', 'firefox_133',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────
function shortUA(ua) {
    const m = ua.match(/(Chrome|Firefox)\/([\d.]+)/);
    const os = ua.includes('Windows') ? 'Win' : ua.includes('Mac') ? 'Mac' : 'Lin';
    return m ? `${os}/${m[1].slice(0, 2)}/${m[2]}` : ua.slice(0, 30);
}

function getProxy() {
    const f = ['data/proxyv4.txt', 'proxyv4.txt'].find(x => fs.existsSync(x));
    if (!f) { console.error('No proxy.txt'); process.exit(1); }
    const line = fs.readFileSync(f, 'utf8').split('\n').find(l => l.trim());
    if (!line) { console.error('proxy.txt empty'); process.exit(1); }
    const raw = line.trim();
    let username, password, host, port;
    if (raw.includes('@')) {
        const [creds, addr] = raw.split('@');
        [username, password] = creds.split(':');
        [host, port] = addr.split(':');
    } else { [host, port] = raw.split(':'); }
    const url = `http://${username ? `${username}:${password}@` : ''}${host}:${port}`;
    return { url, display: `${host}:${port}` };
}

// ─── Test one combo — same logic as bot.js _exchange ─────────────────────────
async function test(ua, tlsId, proxyUrl) {
    const random = 1 + ~~(53550 + 6e5 * Math.random());
    const body = 'data=' + encodeURIComponent(JSON.stringify({
        cv: 4 * random, ch: 50, ccv: random - 2, vv: 158,
    }));

    let session;
    try {
        session = new TLSSession({
            clientIdentifier: ClientIdentifier[tlsId],
            timeout: 15000,
            insecureSkipVerify: true,
        });

        const r = await session.post('https://agma.io/client.php', {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Origin': 'https://agma.io',
                'Referer': 'https://agma.io/',
                'User-Agent': ua,
                'Accept-Language': 'en-US,en;q=0.9',
            },
            proxy: proxyUrl,
            body,
        });

        const text = await r.text();
        const isChallenge = text.includes('Just a moment') || text.includes('challenge-platform') || text.includes('<!DOCTYPE');
        const numMatch = text.match(/^\d+$/);

        if (numMatch) return 'PASS';
        if (isChallenge) return 'CF_BLOCK';
        return 'UNKNOWN';
    } catch (e) {
        return `ERR:${e.message.slice(0, 40)}`;
    } finally {
        try { await session?.close(); } catch (_) { }
    }
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
    console.log('\n  ╔══════════════════════════════════════════════╗');
    console.log('  ║   AGMA Fingerprint Tester                   ║');
    console.log('  ╚══════════════════════════════════════════════╝\n');

    await initTLS();
    const px = getProxy();
    console.log(`  Proxy: ${px.display}`);

    // Build combos: Chrome UAs × Chrome TLS, Firefox UAs × Firefox TLS
    const combos = [];
    for (const ua of UA_POOL) {
        const isFF = ua.includes('Firefox');
        for (const tls of (isFF ? FIREFOX_TLS : CHROME_TLS)) {
            combos.push({ ua, tls });
        }
    }

    console.log(`  Combos: ${combos.length} (${CHROME_TLS.length} Chrome TLS × 7 Chrome UAs + ${FIREFOX_TLS.length} Firefox TLS × 3 Firefox UAs)`);
    console.log('  ────────────────────────────────────────────────\n');

    const results = [];
    for (let i = 0; i < combos.length; i++) {
        const { ua, tls } = combos[i];
        const label = `${shortUA(ua).padEnd(18)} + ${tls.padEnd(20)}`;
        process.stdout.write(`  [${String(i + 1).padStart(3)}/${combos.length}] ${label} `);

        const result = await test(ua, tls, px.url);
        results.push({ ua: shortUA(ua), tls, result });

        if (result === 'PASS') console.log('\x1b[32m✓ PASS\x1b[0m');
        else if (result === 'CF_BLOCK') console.log('\x1b[31m✗ CF CHALLENGE\x1b[0m');
        else console.log(`\x1b[33m? ${result}\x1b[0m`);

        // 300ms between tests
        await new Promise(r => setTimeout(r, 300));
    }

    // ─── Summary ─────────────────────────────────────────────────────────
    const pass = results.filter(r => r.result === 'PASS');
    const fail = results.filter(r => r.result === 'CF_BLOCK');
    const err = results.filter(r => r.result !== 'PASS' && r.result !== 'CF_BLOCK');

    console.log('\n  ════════════════════════════════════════════════');
    console.log(`  \x1b[1m✓ PASS: ${pass.length}   ✗ CF_BLOCK: ${fail.length}   ? OTHER: ${err.length}\x1b[0m`);
    console.log('  ════════════════════════════════════════════════\n');

    if (pass.length) {
        console.log('  \x1b[32m── WORKING COMBOS ──\x1b[0m');
        for (const r of pass) console.log(`    ✓  ${r.ua.padEnd(18)}  ${r.tls}`);

        // Best TLS IDs
        const tlsCount = {};
        for (const r of pass) tlsCount[r.tls] = (tlsCount[r.tls] || 0) + 1;
        const sorted = Object.entries(tlsCount).sort((a, b) => b[1] - a[1]);
        console.log('\n  \x1b[36m── BEST TLS IDs (pass all UAs) ──\x1b[0m');
        for (const [tls, n] of sorted) console.log(`    ${tls}: ${n} UAs pass`);
    }

    if (fail.length) {
        console.log('\n  \x1b[31m── BLOCKED COMBOS ──\x1b[0m');
        for (const r of fail) console.log(`    ✗  ${r.ua.padEnd(18)}  ${r.tls}`);
    }

    // Save raw results
    fs.writeFileSync('fingerprint-results.json', JSON.stringify({
        timestamp: new Date().toISOString(),
        proxy: px.display,
        summary: { pass: pass.length, cf_block: fail.length, error: err.length },
        passing: pass.map(r => ({ ua: r.ua, tls: r.tls })),
        blocked: fail.map(r => ({ ua: r.ua, tls: r.tls })),
        errors: err.map(r => ({ ua: r.ua, tls: r.tls, detail: r.result })),
    }, null, 2));
    console.log('\n  Saved → fingerprint-results.json\n');

    await destroyTLS();
}

main().catch(e => { console.error(e); process.exit(1); });
