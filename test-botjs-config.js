'use strict';

const fs = require('fs');
const { Session: TLSSession, ClientIdentifier, initTLS, destroyTLS } = require('node-tls-client');

// ─── Exact bot.js config after the fix ───────────────────────────────────────
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

// Updated TLS IDs from bot.js
const TLS_CHROME_IDS = ['chrome_131', 'chrome_131_psk', 'chrome_117'];
const TLS_FIREFOX_IDS = ['firefox_133', 'firefox_132', 'firefox_120'];

function shortUA(ua) {
    const m = ua.match(/(Chrome|Firefox)\/([\d.]+)/);
    const os = ua.includes('Windows') ? 'Win' : ua.includes('Mac') ? 'Mac' : 'Lin';
    return m ? `${os}/${m[1].slice(0, 2)}/${m[2]}` : ua.slice(0, 30);
}

function getProxy() {
    const f = ['data/proxy.txt', 'proxy.txt'].find(x => fs.existsSync(x));
    const line = fs.readFileSync(f, 'utf8').split('\n').find(l => l.trim());
    const raw = line.trim();
    let username, password, host, port;
    if (raw.includes('@')) {
        const [creds, addr] = raw.split('@');
        [username, password] = creds.split(':');
        [host, port] = addr.split(':');
    } else { [host, port] = raw.split(':'); }
    return `http://${username ? `${username}:${password}@` : ''}${host}:${port}`;
}

async function test(ua, tlsId, proxyUrl) {
    const random = 1 + ~~(53550 + 6e5 * Math.random());
    const body = 'data=' + encodeURIComponent(JSON.stringify({ cv: 4 * random, ch: 50, ccv: random - 2, vv: 158 }));
    let session;
    try {
        session = new TLSSession({ clientIdentifier: ClientIdentifier[tlsId], timeout: 15000, insecureSkipVerify: true });
        const r = await session.post('https://agma.io/client.php', {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Origin': 'https://agma.io', 'Referer': 'https://agma.io/',
                'User-Agent': ua, 'Accept-Language': 'en-US,en;q=0.9',
            },
            proxy: proxyUrl, body,
        });
        const text = await r.text();
        if (text.match(/^\d+$/)) return 'PASS';
        if (text.includes('Just a moment') || text.includes('<!DOCTYPE')) return 'CF_BLOCK';
        return 'UNKNOWN';
    } catch (e) { return `ERR:${e.message.slice(0, 40)}`; }
    finally { try { await session?.close(); } catch (_) { } }
}

async function main() {
    console.log('\n  ── bot.js Config Verification ──\n');
    await initTLS();
    const px = getProxy();

    const combos = [];
    for (const ua of UA_POOL) {
        const isFF = ua.includes('Firefox');
        for (const tls of (isFF ? TLS_FIREFOX_IDS : TLS_CHROME_IDS)) {
            combos.push({ ua, tls });
        }
    }

    console.log(`  Testing ${combos.length} combos (bot.js exact config)\n`);

    let pass = 0, fail = 0;
    for (let i = 0; i < combos.length; i++) {
        const { ua, tls } = combos[i];
        process.stdout.write(`  [${String(i + 1).padStart(2)}/${combos.length}] ${shortUA(ua).padEnd(18)} + ${tls.padEnd(16)} `);
        const r = await test(ua, tls, px);
        if (r === 'PASS') { pass++; console.log('\x1b[32m✓ PASS\x1b[0m'); }
        else { fail++; console.log(`\x1b[31m✗ ${r}\x1b[0m`); }
        await new Promise(r => setTimeout(r, 300));
    }

    console.log(`\n  ════════════════════════════════`);
    console.log(`  \x1b[1m✓ ${pass}/${combos.length} PASS   ✗ ${fail} FAIL\x1b[0m`);
    console.log(`  ════════════════════════════════\n`);
    if (fail === 0) console.log('  \x1b[32m🎉 All bot.js fingerprint combos pass CF!\x1b[0m\n');
    else console.log('  \x1b[31m⚠ Some combos still blocked!\x1b[0m\n');

    await destroyTLS();
}

main().catch(e => { console.error(e); process.exit(1); });
