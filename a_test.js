const initCycleTLS = require('cycletls');
async function test() {
    const session = await fetch('http://localhost:3000/cf-clearance-scraper', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            url: 'https://agma.io',
            mode: "waf-session",
            proxy: {
                host: '64.176.54.117',
                port: 30013,
                username: 'test',
                password: 'test'
            }
        })
    }).then(res => res.json()).catch(err => { console.error(err); return null });

    if (!session || session.code != 200) return console.error(session);

    const cycleTLS = await initCycleTLS();
    const response = await cycleTLS('https://agma.io', {
        body: '',
        ja3: '772,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,23-27-65037-43-51-45-16-11-13-17513-5-18-65281-0-10-35,25497-29-23-24,0', // https://scrapfly.io/web-scraping-tools/ja3-fingerprint
        userAgent: session.headers["user-agent"],
        proxy: 'http://test:test@64.176.54.117:30013',
        headers: {
            ...session.headers,
            cookie: session.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
        }
    }, 'get');

    console.log(response.status);
    cycleTLS.exit().catch(err => { });
}
test()