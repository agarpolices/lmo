// ==UserScript==
// @name         Agma Bot Panel
// @namespace    http://tampermonkey.net/
// @version      7.0.0
// @description  Agma Bot Control Panel - V7 Per-Session Controls
// @author       Police
// @match        *://agma.io/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=agma.io
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

(() => {
    'use strict';

    let bots = [];
    let spawncontinous = false;
    let botsRunning = false;
    let position = { x: 0, y: 0 };
    let url = '';
    let panelMinimized = false;
    let rgbMode = localStorage.getItem('bp-rgb') === 'true';
    let statsConnected = 0, statsTotal = 0, statsCaptcha = 0;
    let sessionProxyMode = 'v4';
    let sessionBattle = false;
    let sessionJitter = false;
    let sessionPelletLoop = false;

    // Server switching logic
    let serverMode = 'local'; // 'local' or 'remote'
    const NGROK_URL = 'womanly-cahoots-unhearing.ngrok-free.dev';

    function getWsUrl() {
        return serverMode === 'local' ? 'ws://localhost:8080' : `wss://${NGROK_URL}`;
    }

    // Pre-allocate a buffer for outbound mouse updates (26 bytes)
    const mouseBuffer = new ArrayBuffer(26);
    const mouseView = new DataView(mouseBuffer);
    mouseView.setUint8(0, 9); // Header 9

    // Extract pristine native WebSocket to avoid game's anti-cheat hooks completely
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    document.documentElement.appendChild(iframe);
    const PureWebSocket = iframe.contentWindow.WebSocket;
    const _pureSend = PureWebSocket.prototype.send;

    // Set of known panel-created sockets to strict bypass
    const panelSockets = new WeakSet();

    // Hook construction to stealth-capture game URL
    const RealWebSocket = unsafeWindow.WebSocket;
    unsafeWindow.WebSocket = new Proxy(RealWebSocket, {
        construct(target, args) {
            const ws = new target(...args);
            try {
                const wsUrl = args[0] || '';
                if (typeof wsUrl === 'string' && wsUrl.includes('agma.io')) {
                    url = wsUrl;
                }
            } catch (e) { }
            return ws;
        }
    });

    // Save original send BEFORE proxying — bot uses this to avoid interference
    const _originalSend = RealWebSocket.prototype.send;

    RealWebSocket.prototype.send = new Proxy(_originalSend, {
        apply(target, thisArg, argArray) {
            // Skip processing entirely if it's our bot panel socket connection
            if (panelSockets.has(thisArg)) {
                return target.apply(thisArg, argArray);
            }

            try {
                let pkt = argArray[0];
                let byteLength = 0;

                // Native check on length without allocating objects
                if (pkt instanceof ArrayBuffer) {
                    byteLength = pkt.byteLength;
                } else if (pkt && pkt.buffer) {
                    byteLength = pkt.byteLength;
                }

                // Agma mouse packet is exactly 9 bytes and first byte is 0
                if (byteLength === 9) {
                    const view = (pkt instanceof DataView) ? pkt : new DataView(pkt instanceof ArrayBuffer ? pkt : pkt.buffer);
                    if (view.getUint8(0) === 0) {
                        position.x = view.getInt32(1, true);
                        position.y = view.getInt32(5, true);
                    }
                }
            } catch (e) { }

            // Execute original send
            return target.apply(thisArg, argArray);
        }
    });

    class SocketBot {
        socket = null;
        mouseint = null;
        constructor(wss) { this.wss = wss; this.connect(wss); }

        connect(wss) {
            this.socket = new WebSocket(wss);
            panelSockets.add(this.socket);
            this.socket.binaryType = 'arraybuffer';
            this.socket.onopen = this.onOpen.bind(this);
            this.socket.onmessage = this.onMessage.bind(this);
            this.socket.onclose = this.onClose.bind(this);
        }
        onOpen() {
            updatePanel();
            // Sync panel toggle states to this new session so server doesn't use config.json defaults
            this.setProxyMode(sessionProxyMode === 'v6');
            this.setBattleMode(sessionBattle);
            this.setJitter(sessionJitter);
            this.setPelletLoop(sessionPelletLoop);

            // Only send mouse packets if they change payload coords to save overhead
            let lastX = 0;
            let lastY = 0;
            this.mouseint = setInterval(() => {
                if (position.x !== lastX || position.y !== lastY) {
                    this.sendMouse(position.x, position.y);
                    lastX = position.x;
                    lastY = position.y;
                }
            }, 50);
        }
        onMessage(msg) {
            try {
                const view = new DataView(msg.data);
                if (view.byteLength >= 7 && view.getUint8(0) === 10) {
                    statsConnected = view.getUint16(1, true);
                    statsTotal = view.getUint16(3, true);
                    statsCaptcha = view.getUint16(5, true);
                    updatePanel();
                }
            } catch (e) { }
        }
        onClose() {
            clearInterval(this.mouseint); this.mouseint = null;
            if (this.socket) { this.socket.close(); this.socket = null; }
            statsConnected = 0; statsTotal = 0; statsCaptcha = 0;
            updatePanel();
        }
        send(msg) {
            // Use pure isolated send to guarantee packets never route to the game's anti-cheat socket
            if (this.socket && this.socket.readyState === PureWebSocket.OPEN)
                _pureSend.call(this.socket, msg.buffer || msg);
        }
        feed() { this.send(new Uint8Array([2])); }
        split() { this.send(new Uint8Array([1])); }
        stspawnint(a) { a ? this.send(new Uint8Array([6])) : this.send(new Uint8Array([7])); }
        droppw() { this.send(new Uint8Array([3])); }
        sendfrozenvirus() { this.send(new Uint8Array([4])); }
        stopbots() { this.send(new Uint8Array([5])); }
        killserver() { this.send(new Uint8Array([11])); }
        setAmount(n) {
            const buf = new DataView(new ArrayBuffer(3));
            buf.setUint8(0, 12); buf.setUint16(1, n, true);
            this.send(buf);
        }
        setName(name) {
            const buf = new DataView(new ArrayBuffer(1 + 2 * name.length));
            buf.setUint8(0, 13);
            for (let i = 0; i < name.length; i++) buf.setUint16(1 + 2 * i, name.charCodeAt(i), true);
            this.send(buf);
        }
        setProxyMode(v6) { this.send(new Uint8Array([14, v6 ? 1 : 0])); }
        setBattleMode(on) { this.send(new Uint8Array([15, on ? 1 : 0])); }
        setJitter(on) { this.send(new Uint8Array([16, on ? 1 : 0])); }
        setPelletLoop(on) { this.send(new Uint8Array([17, on ? 1 : 0])); }
        sendMouse(x, y) {
            mouseView.setFloat64(1, x, true);
            mouseView.setFloat64(9, y, true);
            this.send(mouseBuffer);
        }
        sendwss(wss) {
            const buf = new DataView(new ArrayBuffer(1 + 2 * wss.length));
            buf.setUint8(0, 0);
            for (let i = 0; i < wss.length; i++) buf.setUint16(1 + 2 * i, wss.charCodeAt(i), true);
            this.send(buf);
        }
        sendChat(msg) {
            const buf = new DataView(new ArrayBuffer(1 + 2 * msg.length));
            buf.setUint8(0, 8);
            for (let i = 0; i < msg.length; i++) buf.setUint16(1 + 2 * i, msg.charCodeAt(i), true);
            this.send(buf);
        }
        connectbot(wss) { this.sendwss(wss); }
        destroy() {
            clearInterval(this.mouseint); this.mouseint = null;
            if (this.socket) { this.socket.onclose = null; this.socket.close(); this.socket = null; }
        }
    }

    unsafeWindow.closesv = () => bots.forEach(b => b.stopbots());
    unsafeWindow.chtsocket = (msg) => bots.forEach(b => b.sendChat(msg));
    unsafeWindow.socketbot = (string) => bots.forEach(b => b.connectbot(string || url));

    unsafeWindow.addEventListener('keydown', e => {
        if (document.querySelector('input:focus, textarea:focus, select:focus')) return;
        switch (e.key) {
            case '[': spawncontinous = !spawncontinous; bots.forEach(b => b.stspawnint(spawncontinous)); break;
            case '-': botsRunning = false; bots.forEach(b => b.stopbots()); updatePanel(); break;
            case '0': connectToServer(); break;
            case 'a': bots.forEach(b => b.split()); break;
            case '1': bots.forEach(b => b.feed()); break;
            case '\`': unsafeWindow.socketbot(); break;
            case '2': bots.forEach(b => b.droppw()); break;
            case '3': bots.forEach(b => b.sendfrozenvirus()); break;
        }
    });

    function isServerConnected() { return bots.some(b => b.socket?.readyState === WebSocket.OPEN); }

    function connectToServer() {
        if (bots.length === 0 || !isServerConnected()) {
            bots.forEach(b => b.destroy());
            bots = [];
            bots.push(new SocketBot(getWsUrl()));
        }
    }

    function disconnectFromServer() {
        bots.forEach(b => b.destroy());
        bots = [];
        statsConnected = 0; statsTotal = 0; statsCaptcha = 0; botsRunning = false;
        updatePanel();
    }

    /* ─── Modern Glassmorphism UI ─── */

    const icons = {
        globe: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>',
        split: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M15.89 8.11L8.11 15.89"></path></svg>',
        feed: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="2"></circle></svg>',
        power: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"></path></svg>',
        virus: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5l-10 14M7 5l10 14M2 12h20"></path></svg>',
        send: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>'
    };

    function createPanel() {
        const panel = document.createElement('div');
        panel.id = 'bot-panel';
        panel.innerHTML = `
            <div id="bp-hd">
                <div class="bp-hd-title">
                    <span id="bp-conn-pulse"><span id="bp-conn-indicator"></span></span>
                    <span class="bp-hd-text">NEXUS</span>
                    <span class="bp-badge">v6</span>
                </div>
                <div class="bp-hd-actions">
                    <span id="bp-rgb-btn" title="Toggle RGB"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg></span>
                    <span id="bp-min" title="Minimize"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"></line></svg></span>
                </div>
            </div>

            <div id="bp-bd">
                <!-- Server Connection Row -->
                <div class="bp-cyber-row">
                    <button class="bp-btn bp-server-btn" id="bp-srv">
                        <span class="bp-icon">${icons.globe}</span>
                        <span id="bp-stx">OFFLINE</span>
                    </button>
                    <div class="bp-select-wrap">
                        <select id="bp-sel">
                            <option value="local">LOCAL</option>
                            <option value="remote">NGROK</option>
                        </select>
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" class="chevron"><polyline points="6 9 12 15 18 9"></polyline></svg>
                    </div>
                </div>

                <!-- Stats HUD -->
                <div class="bp-stats-hud">
                    <div class="bp-stat">
                        <span class="bp-s-lbl">ONLINE</span>
                        <span class="bp-s-val bp-c-green" id="bp-connected">0</span>
                    </div>
                    <div class="bp-s-div"></div>
                    <div class="bp-stat">
                        <span class="bp-s-lbl">TOTAL</span>
                        <span class="bp-s-val bp-c-white" id="bp-total">0</span>
                    </div>
                    <div class="bp-s-div"></div>
                    <div class="bp-stat">
                        <span class="bp-s-lbl">CAPTCHA</span>
                        <span class="bp-s-val bp-c-amber" id="bp-captcha">0</span>
                    </div>
                </div>

                <!-- Progress Bar -->
                <div id="bp-bar-wrap"><div id="bp-bar"><div id="bp-bar-shimmer"></div></div></div>

                <!-- Setup Row -->
                <div class="bp-inputs-hud">
                    <input type="text" id="bp-name" value="Bot" maxlength="15" autocomplete="off" placeholder="Bot Name" />
                    <input type="number" id="bp-amount" value="50" min="1" max="500" placeholder="Amt" />
                </div>

                <!-- Session Toggles -->
                <div class="bp-toggles-row">
                    <div class="bp-select-wrap bp-toggle-sel">
                        <select id="bp-proxy-mode">
                            <option value="v4">IPv4</option>
                            <option value="v6">IPv6</option>
                        </select>
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" class="chevron"><polyline points="6 9 12 15 18 9"></polyline></svg>
                    </div>
                    <button class="bp-btn bp-toggle-btn" id="bp-battle" title="Battle Mode">⚔ OFF</button>
                    <button class="bp-btn bp-toggle-btn" id="bp-jitter" title="Jitter">⏱ OFF</button>
                    <button class="bp-btn bp-toggle-btn" id="bp-pellet" title="Pellet Loop">🟢 OFF</button>
                </div>

                <!-- Action Grid -->
                <div id="bp-action-grid">
                    <button class="bp-btn bp-btn-grid" id="bp-act-split" title="Shortcut: a">
                        <span class="bp-grid-icon">${icons.split}</span>
                    </button>
                    <button class="bp-btn bp-btn-grid" id="bp-act-feed" title="Shortcut: 1">
                        <span class="bp-grid-icon">${icons.feed}</span>
                    </button>
                    <button class="bp-btn bp-btn-grid" id="bp-act-pw" title="Shortcut: 2">
                        <span class="bp-grid-icon">${icons.power}</span>
                    </button>
                    <button class="bp-btn bp-btn-grid" id="bp-act-fv" title="Shortcut: 3">
                        <span class="bp-grid-icon">${icons.virus}</span>
                    </button>
                </div>

                <!-- Chat Row -->
                <div class="bp-chat-hud">
                    <input type="text" id="bp-chat" autocomplete="off" placeholder="Broadcast message..." />
                    <button class="bp-btn" id="bp-send-chat">${icons.send}</button>
                </div>

                <!-- Game Socket URL -->
                <div id="bp-url">WAITING FOR GAME HOOK...</div>
            </div>

            <!-- Start / Stop Button -->
            <button class="bp-btn" id="bp-start">INITIALIZE BOTS</button>
        `;

        const css = document.createElement('style');
        css.textContent = `
            @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;700;800&family=JetBrains+Mono:wght@400;700;800&display=swap');

            /* ── Global Context ── */
            #bot-panel {
                position: fixed; top: 15px; right: 15px; z-index: 999999; width: 260px;
                font-family: 'Outfit', sans-serif; box-sizing: border-box;
                
                /* Glassmorphism Theming */
                background: rgba(15, 15, 20, 0.75);
                backdrop-filter: blur(24px) saturate(160%);
                -webkit-backdrop-filter: blur(24px) saturate(160%);
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 16px;
                box-shadow: 0 24px 48px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05);
                color: #ffffff;
                
                opacity: 0; transform: translateY(-20px) scale(0.95);
                transition: opacity 0.4s cubic-bezier(0.16, 1, 0.3, 1), transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
            }
            #bot-panel * { box-sizing: border-box; }
            #bot-panel.bp-visible { opacity: 1; transform: translateY(0) scale(1); }

            /* ── Header ── */
            #bp-hd {
                display: flex; justify-content: space-between; align-items: center;
                padding: 12px 16px; cursor: grab; background: rgba(0,0,0,0.2);
                border-bottom: 1px solid rgba(255, 255, 255, 0.06);
            }
            #bp-hd:active { cursor: grabbing; }
            .bp-hd-title { display: flex; align-items: center; gap: 8px; }
            .bp-hd-text {
                font-size: 13px; font-weight: 800; letter-spacing: 1px;
                background: linear-gradient(135deg, #fff, #a0a0b0);
                -webkit-background-clip: text; -webkit-text-fill-color: transparent;
            }
            .bp-badge {
                font-family: 'JetBrains Mono', monospace; font-size: 9px; font-weight: 800;
                padding: 2px 6px; border-radius: 6px;
                background: rgba(59, 130, 246, 0.15); color: #3b82f6;
            }
            .bp-hd-actions { display: flex; align-items: center; gap: 8px; }
            #bp-rgb-btn, #bp-min {
                cursor: pointer; color: #656575; display: flex; align-items: center; transition: all 0.2s;
            }
            #bp-rgb-btn:hover { color: #fff; transform: scale(1.1) rotate(45deg); }
            #bp-min:hover { color: #fff; transform: scale(1.1); }
            
            /* ── RGB Mode ── */
            @keyframes rgb-bg-move { 0% { background-position: 0% 50%; } 100% { background-position: 200% 50%; } }
            #bot-panel.rgb-mode { 
                border-color: transparent; z-index: 999999; 
                backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
            }
            #bp-hd { border-radius: 16px 16px 0 0; } /* Ensure top corners are smooth */
            #bot-panel.rgb-mode::before {
                content: ''; position: absolute; top: -3px; left: -3px; right: -3px; bottom: -3px;
                background: linear-gradient(90deg, #ff0000, #ff7300, #fffb00, #48ff00, #00ffd5, #002bff, #7a00ff, #ff00c8, #ff0000);
                background-size: 200% 200%; z-index: -2; border-radius: 19px; filter: blur(12px);
                animation: rgb-bg-move 4s linear infinite; opacity: 0.9;
            }
            #bot-panel.rgb-mode::after {
                content: ''; position: absolute; top: 0; left: 0; right: 0; bottom: 0;
                background: rgba(12, 12, 16, 0.98); border-radius: 16px; z-index: -1;
            }
            #bot-panel.rgb-mode .bp-hd-text {
                background: linear-gradient(90deg, #ff0000, #ff7300, #fffb00, #48ff00, #00ffd5, #002bff, #7a00ff, #ff00c8, #ff0000);
                background-size: 200% auto; -webkit-background-clip: text; -webkit-text-fill-color: transparent;
                animation: rgb-bg-move 4s linear infinite; text-shadow: none;
            }
            #bot-panel.rgb-mode #bp-bar {
                background: linear-gradient(90deg, #ff0000, #ff7300, #fffb00, #48ff00, #00ffd5, #002bff, #7a00ff, #ff00c8, #ff0000);
                background-size: 200% auto; animation: rgb-bg-move 2s linear infinite; box-shadow: 0 0 10px rgba(255,255,255,0.3);
            }
            #bot-panel.rgb-mode #bp-start.running {
                background: linear-gradient(90deg, #ff0000, #ff7300, #fffb00, #48ff00, #00ffd5, #002bff, #7a00ff, #ff00c8, #ff0000);
                background-size: 200% auto; animation: rgb-bg-move 3s linear infinite; color: #fff; text-shadow: 0 1px 3px rgba(0,0,0,0.8);
            }

            /* Status Indicator */
            #bp-conn-pulse { position: relative; width: 10px; height: 10px; display: flex; align-items: center; justify-content: center; }
            #bp-conn-indicator { width: 8px; height: 8px; border-radius: 50%; background: #ef4444; transition: background 0.4s; }
            #bp-conn-indicator.online { background: #10b981; box-shadow: 0 0 10px #10b981; }
            #bp-conn-indicator.online::after {
                content: ''; position: absolute; width: 100%; height: 100%;
                border-radius: 50%; border: 2px solid #10b981;
                animation: bp-ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite;
            }
            @keyframes bp-ping { 75%, 100% { transform: scale(2.5); opacity: 0; } }

            /* ── Body ── */
            #bp-bd { padding: 14px; display: flex; flex-direction: column; gap: 12px; }
            #bp-bd.bp-hidden { display: none; }

            /* Buttons Default Reset */
            .bp-btn {
                border: none; outline: none; cursor: pointer;
                transition: all 0.2s cubic-bezier(0.4,0,0.2,1);
                display: flex; justify-content: center; align-items: center;
            }
            .bp-btn:hover { transform: translateY(-1px); }
            .bp-btn:active { transform: scale(0.97); }

            /* Server Row */
            .bp-cyber-row { display: flex; gap: 8px; }
            .bp-server-btn {
                flex: 1; padding: 10px; border-radius: 10px;
                background: rgba(25, 25, 33, 0.65); border: 1px solid rgba(255,255,255,0.06);
                color: #a0a0b0; font-size: 11px; font-weight: 700; gap: 8px;
            }
            .bp-server-btn:hover { background: rgba(35, 35, 45, 0.8); border-color: rgba(255,255,255,0.15); color: #fff; }
            .bp-server-btn.online { background: rgba(16, 185, 129, 0.1); border-color: rgba(16, 185, 129, 0.3); color: #10b981; }
            .bp-server-btn.online:hover { background: rgba(16, 185, 129, 0.15); }
            
            .bp-select-wrap { position: relative; width: 80px; }
            #bp-sel {
                width: 100%; height: 100%; padding: 0 10px; appearance: none; cursor: pointer;
                background: rgba(25, 25, 33, 0.65); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px;
                color: #fff; font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 700; outline: none;
                transition: all 0.2s;
            }
            #bp-sel:hover { border-color: rgba(255,255,255,0.15); background: rgba(35, 35, 45, 0.8); }
            #bp-sel option { background: #121218; color: #fff; }
            .bp-select-wrap .chevron { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); color: #656575; pointer-events: none; }

            /* Stats */
            .bp-stats-hud {
                display: flex; align-items: center; justify-content: space-between;
                background: rgba(10, 10, 15, 0.5); border-radius: 12px; padding: 10px;
                border: 1px solid rgba(255,255,255,0.04);
            }
            .bp-stat { display: flex; flex-direction: column; align-items: center; flex: 1; gap: 2px; }
            .bp-s-lbl { font-size: 9px; font-weight: 800; color: #656575; letter-spacing: 0.5px; }
            .bp-s-val { font-family: 'JetBrains Mono', monospace; font-size: 18px; font-weight: 800; line-height: 1.1; transition: transform 0.1s; display: inline-block;}
            .bp-c-green { color: #10b981; } .bp-c-white { color: #fff; } .bp-c-amber { color: #f59e0b; }
            .bp-s-div { width: 1px; height: 24px; background: rgba(255,255,255,0.06); }
            .bp-counter-pop { transform: scale(1.15) translateY(-2px); }

            /* Progress Bar */
            #bp-bar-wrap { width: 100%; height: 4px; background: rgba(255,255,255,0.06); border-radius: 2px; overflow: hidden; }
            #bp-bar { height: 100%; width: 0%; border-radius: 2px; background: linear-gradient(90deg, #3b82f6, #8b5cf6); transition: width 0.4s ease-out; position: relative; }
            #bp-bar-shimmer { position: absolute; top: 0; left: -100%; width: 50%; height: 100%; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.5), transparent); animation: bp-shimmer 2s infinite; }
            @keyframes bp-shimmer { 100% { left: 200%; } }

            /* Inputs */
            .bp-inputs-hud, .bp-chat-hud { display: flex; gap: 8px; }
            input[type="text"], input[type="number"] {
                width: 100%; padding: 10px 12px;
                background: rgba(10, 10, 15, 0.5); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px;
                color: #fff; font-size: 12px; font-weight: 600; font-family: 'Outfit', sans-serif;
                outline: none; transition: all 0.2s;
            }
            input:focus { border-color: #3b82f6; background: rgba(25, 25, 33, 0.65); box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15); }
            #bp-amount { width: 70px; text-align: center; }
            input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }

            /* Grid Actions */
            #bp-action-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
            .bp-btn-grid {
                background: rgba(25, 25, 33, 0.65); border: 1px solid rgba(255,255,255,0.06);
                padding: 10px 0; border-radius: 10px; color: #a0a0b0;
            }
            .bp-btn-grid:hover { background: rgba(35, 35, 45, 0.8); border-color: rgba(255,255,255,0.15); color: #3b82f6; }

            /* Chat Row */
            .bp-chat-hud #bp-chat { flex: 1; }
            #bp-send-chat {
                background: rgba(25, 25, 33, 0.65); border: 1px solid rgba(255,255,255,0.06);
                border-radius: 10px; width: 44px; color: #8b5cf6;
            }
            #bp-send-chat:hover { background: rgba(139, 92, 246, 0.15); border-color: #8b5cf6; }

            /* Session Toggles */
            .bp-toggles-row { display: flex; gap: 6px; }
            .bp-toggle-sel { flex: 1; }
            .bp-toggle-sel select {
                width: 100%; padding: 8px 10px; appearance: none; cursor: pointer;
                background: rgba(25, 25, 33, 0.65); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px;
                color: #fff; font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 700; outline: none;
                transition: all 0.2s;
            }
            .bp-toggle-sel select:hover { border-color: rgba(255,255,255,0.15); }
            .bp-toggle-sel select option { background: #121218; color: #fff; }
            .bp-toggle-btn {
                flex: 1; padding: 8px 0; border-radius: 10px;
                background: rgba(25, 25, 33, 0.65); border: 1px solid rgba(255,255,255,0.06);
                color: #656575; font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 700;
            }
            .bp-toggle-btn:hover { border-color: rgba(255,255,255,0.15); color: #a0a0b0; }
            .bp-toggle-btn.active { background: rgba(16, 185, 129, 0.15); border-color: rgba(16, 185, 129, 0.3); color: #10b981; }

            /* Hook URL */
            #bp-url {
                text-align: center; font-family: 'JetBrains Mono', monospace; font-size: 8px;
                font-weight: 700; color: #656575; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            }

            /* Main Start/Stop Button */
            #bp-start {
                width: 100%; border-radius: 0 0 16px 16px; padding: 14px 0;
                font-family: 'Outfit', sans-serif; font-size: 12px; font-weight: 800; letter-spacing: 1px;
                background: rgba(255, 255, 255, 0.03); color: #3b82f6; border-top: 1px solid rgba(59, 130, 246, 0.15);
            }
            #bp-start:hover { background: rgba(59, 130, 246, 0.1); text-shadow: 0 0 8px rgba(59, 130, 246, 0.5); }
            
            #bp-start.running {
                background: linear-gradient(135deg, #ef4444, #be123c); color: #fff;
                border-top: none; text-shadow: 0 2px 4px rgba(0,0,0,0.3);
            }
            #bp-start.running:hover { filter: brightness(1.1); box-shadow: 0 0 20px rgba(239, 68, 68, 0.4); }
        `;
        document.head.appendChild(css);
        document.documentElement.appendChild(panel);

        // Enter Hook
        requestAnimationFrame(() => {
            panel.classList.add('bp-visible');
            if (rgbMode) panel.classList.add('rgb-mode');
        });

        // RGB Toggle
        panel.querySelector('#bp-rgb-btn').addEventListener('click', (e) => {
            e.currentTarget.blur();
            rgbMode = !rgbMode;
            panel.classList.toggle('rgb-mode', rgbMode);
            localStorage.setItem('bp-rgb', rgbMode);
        });

        // Dragging
        const header = panel.querySelector('#bp-hd');
        let dragging = false, dx = 0, dy = 0;
        header.addEventListener('mousedown', e => {
            if (e.target.closest('#bp-min')) return;
            dragging = true; panel.style.transition = 'none';
            dx = e.clientX - panel.getBoundingClientRect().left; dy = e.clientY - panel.getBoundingClientRect().top;
        });
        document.addEventListener('mousemove', e => {
            if (!dragging) return;
            panel.style.left = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, e.clientX - dx)) + 'px';
            panel.style.top = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - dy)) + 'px';
            panel.style.right = 'auto';
        });
        document.addEventListener('mouseup', () => {
            if (dragging) { dragging = false; panel.style.transition = 'opacity 0.4s cubic-bezier(0.16, 1, 0.3, 1), transform 0.4s cubic-bezier(0.16, 1, 0.3, 1)'; }
        });

        // Minify
        panel.querySelector('#bp-min').addEventListener('click', function () {
            panelMinimized = !panelMinimized;
            panel.querySelector('#bp-bd').classList.toggle('bp-hidden', panelMinimized);
            panel.querySelector('#bp-start').style.display = panelMinimized ? 'none' : 'flex';
            this.innerHTML = panelMinimized ? '+' : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"></line></svg>';
        });

        // Server Connect
        panel.querySelector('#bp-srv').addEventListener('click', (e) => {
            e.currentTarget.blur();
            if (isServerConnected()) disconnectFromServer(); else connectToServer();
        });

        // Host selector change handler
        panel.querySelector('#bp-sel').addEventListener('change', (e) => {
            e.currentTarget.blur();
            serverMode = e.target.value;
            disconnectFromServer();
            setTimeout(connectToServer, 100);
        });

        // Sub-buttons execution with universal blur focus removal
        const bindBtn = (id, fn) => panel.querySelector('#' + id).addEventListener('click', e => { e.currentTarget.blur(); fn(); });

        bindBtn('bp-act-split', () => bots.forEach(b => b.split()));
        bindBtn('bp-act-feed', () => bots.forEach(b => b.feed()));
        bindBtn('bp-act-pw', () => bots.forEach(b => b.droppw()));
        bindBtn('bp-act-fv', () => bots.forEach(b => b.sendfrozenvirus()));

        bindBtn('bp-send-chat', () => {
            const msg = panel.querySelector('#bp-chat').value.trim();
            if (msg) { bots.forEach(b => b.sendChat(msg)); panel.querySelector('#bp-chat').value = ''; }
        });
        panel.querySelector('#bp-chat').addEventListener('keydown', e => { if (e.key === 'Enter') panel.querySelector('#bp-send-chat').click(); e.stopPropagation(); });

        // Toggle start/stop
        panel.querySelector('#bp-start').addEventListener('click', (e) => {
            e.currentTarget.blur(); // <-- Removes focus immediately!
            if (!isServerConnected()) { connectToServer(); return; }

            botsRunning = !botsRunning;
            if (botsRunning) {
                const amount = parseInt(panel.querySelector('#bp-amount').value) || 50;
                const name = panel.querySelector('#bp-name').value.trim() || 'Bot';
                bots.forEach(b => { b.setAmount(amount); b.setName(name); });
                setTimeout(() => { if (url) bots.forEach(b => b.connectbot(url)); }, 100);
            } else {
                bots.forEach(b => b.stopbots());
            }
            updatePanel();
        });

        // Name / Amount inputs
        panel.querySelector('#bp-name').addEventListener('keydown', e => {
            e.stopPropagation();
            if (e.key === 'Enter') {
                e.currentTarget.blur();
                const name = e.target.value.trim() || 'Bot';
                bots.forEach(b => b.setName(name));
            }
        });
        panel.querySelector('#bp-amount').addEventListener('keydown', e => e.stopPropagation());

        // Session toggles
        panel.querySelector('#bp-proxy-mode').addEventListener('change', e => {
            e.stopPropagation();
            sessionProxyMode = e.target.value;
            bots.forEach(b => b.setProxyMode(sessionProxyMode === 'v6'));
        });
        panel.querySelector('#bp-battle').addEventListener('click', e => {
            e.currentTarget.blur();
            sessionBattle = !sessionBattle;
            e.currentTarget.textContent = sessionBattle ? '⚔ ON' : '⚔ OFF';
            e.currentTarget.classList.toggle('active', sessionBattle);
            bots.forEach(b => b.setBattleMode(sessionBattle));
        });
        panel.querySelector('#bp-jitter').addEventListener('click', e => {
            e.currentTarget.blur();
            sessionJitter = !sessionJitter;
            e.currentTarget.textContent = sessionJitter ? '⏱ ON' : '⏱ OFF';
            e.currentTarget.classList.toggle('active', sessionJitter);
            bots.forEach(b => b.setJitter(sessionJitter));
        });
        panel.querySelector('#bp-pellet').addEventListener('click', e => {
            e.currentTarget.blur();
            sessionPelletLoop = !sessionPelletLoop;
            e.currentTarget.textContent = sessionPelletLoop ? '🟢 ON' : '🟢 OFF';
            e.currentTarget.classList.toggle('active', sessionPelletLoop);
            bots.forEach(b => b.setPelletLoop(sessionPelletLoop));
        });
    }

    // ── HUD Syncing ──
    function updatePanel() {
        const el = id => document.getElementById(id);
        if (!el('bp-connected')) return;

        // Animated pop-in for numbers
        const cv = el('bp-connected'), tv = el('bp-total'), cap = el('bp-captcha');
        if (cv.textContent != statsConnected) { cv.textContent = statsConnected; cv.classList.add('bp-counter-pop'); setTimeout(() => cv.classList.remove('bp-counter-pop'), 150); }
        if (tv.textContent != statsTotal) { tv.textContent = statsTotal; tv.classList.add('bp-counter-pop'); setTimeout(() => tv.classList.remove('bp-counter-pop'), 150); }
        if (cap.textContent != statsCaptcha) { cap.textContent = statsCaptcha; cap.classList.add('bp-counter-pop'); setTimeout(() => cap.classList.remove('bp-counter-pop'), 150); }

        const pct = statsTotal > 0 ? (statsConnected / statsTotal) * 100 : 0;
        el('bp-bar').style.width = pct + '%';

        // Toggle sync
        const startBtn = el('bp-start');
        if (startBtn) {
            if (statsTotal === 0 && !isServerConnected()) botsRunning = false;

            if (botsRunning) {
                startBtn.textContent = 'TERMINATE BOTS';
                startBtn.classList.add('running');
            } else {
                startBtn.textContent = 'INITIALIZE BOTS';
                startBtn.classList.remove('running');
            }
        }

        // Server button state
        const alive = isServerConnected();
        const btn = el('bp-srv');
        btn.className = alive ? 'bp-btn bp-server-btn online' : 'bp-btn bp-server-btn';
        el('bp-stx').textContent = alive ? 'CONNECTED' : 'OFFLINE';
        if (el('bp-conn-indicator')) el('bp-conn-indicator').className = alive ? 'online' : '';

        // Display captured game socket URL
        const urlEl = el('bp-url');
        if (urlEl) {
            urlEl.textContent = url || 'WAITING FOR GAME HOOK...';
            urlEl.style.color = url ? '#10b981' : '#656575';
            urlEl.style.textShadow = url ? '0 0 8px rgba(16, 185, 129, 0.4)' : 'none';
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createPanel);
    } else {
        createPanel();
    }
    setInterval(updatePanel, 1000);
})();
