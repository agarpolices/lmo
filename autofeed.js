// ==UserScript==
// @name         Auto feeder
// @namespace    http://tampermonkey.net/
// @version      1.2.0
// @description  Auto feeder - Strict Cycling
// @author       Police
// @match        *://agma.io/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=agma.io
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==
(function () {
    'use strict';

    // ── Config ──────────────────────────────────────────────────────────────────
    const positions = [
        { x: 666, y: 1080, id: 'a1' },
        { x: 11134, y: 1334, id: 'a5' },
        { x: 11391, y: 5996, id: 'c5' },
        { x: 11000, y: 11000, id: 'e5' },
        { x: 1000, y: 11000, id: 'e1' },
        { x: 600, y: 6000, id: 'c1' },
    ];
    const MIN_FEED_MASS = 900;
    const RESPAWN_MASS = 200;
    const ARRIVE_DIST = 350;
    const FEED_DROP_RATIO = 0.45;
    const FEED_TIMEOUT_MS = 8000;
    const MOUSE_INTERVAL = 50;
    const SPLIT_INTERVAL_MS = 1500;

    // ── Worker-based timers (immune to background-tab throttling) ────────────────
    const _workerTimers = {};
    let _workerNextId = 1;
    const _timerWorker = new Worker(URL.createObjectURL(new Blob([`
        const timers = {};
        onmessage = e => {
            if (e.data.cmd === 'set') {
                timers[e.data.id] = setInterval(() => postMessage(e.data.id), e.data.ms);
            } else if (e.data.cmd === 'clear') {
                clearInterval(timers[e.data.id]);
                delete timers[e.data.id];
            }
        };
    `], { type: 'text/javascript' })));
    _timerWorker.onmessage = e => { const cb = _workerTimers[e.data]; if (cb) cb(); };
    function workerInterval(fn, ms) {
        const id = _workerNextId++;
        _workerTimers[id] = fn;
        _timerWorker.postMessage({ cmd: 'set', id, ms });
        return id;
    }
    function workerClearInterval(id) {
        delete _workerTimers[id];
        _timerWorker.postMessage({ cmd: 'clear', id });
    }

    // ── WS intercept ─────────────────────────────────────────────────────────────
    let send;
    const osend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (...args) {
        send = (...e) => osend.call(this, ...e);
        return osend.apply(this, args);
    };

    const mouse = (x, y) => {
        if (!send) return;
        const d = new DataView(new ArrayBuffer(9));
        d.setUint8(0, 0);
        d.setInt32(1, x, true);
        d.setInt32(5, y, true);
        send(d.buffer);
    };
    const split = () => { if (send) send(new Uint8Array([17]).buffer); };
    const respawn = (name = ' ') => {
        const buf = new DataView(new ArrayBuffer(4 + 2 + 2 * name.length));
        buf.setUint8(0, 1);
        for (let b = 4, i = 0; i < 1; i++) buf.setUint16(b, 0, true);
        for (let i = 0; i < name.length; i++) buf.setUint16(4 + 2 * i, name.charCodeAt(i), true);
        send(new Uint8Array([59]));
        send(new Uint8Array([34]));
        send(buf.buffer);
    };

    // ── Canvas-based cell tracking ────────────────────────────────────────────────
    const MASS_FACTOR = 0.0031828408;
    let myPos = { x: 0, y: 0, mass: 0 };
    let _frameMass = 0;

    const _origSetTransform = CanvasRenderingContext2D.prototype.setTransform;
    CanvasRenderingContext2D.prototype.setTransform = function (...args) {
        if (this.canvas && this.canvas.id === 'canvas') {
            let zoom = 1, e = 0, f = 0;
            if (args.length >= 6) {
                zoom = args[0]; e = args[4]; f = args[5];
            } else if (args.length === 1 && typeof args[0] === 'object') {
                zoom = args[0].a; e = args[0].e; f = args[0].f;
            }

            if (zoom > 0.02 && zoom < 10) {
                myPos.x = (innerWidth / 2 - e) / zoom;
                myPos.y = (innerHeight / 2 - f) / zoom;
            }
        }
        return _origSetTransform.apply(this, args);
    };

    const _origDrawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function () {
        if (this.canvas && this.canvas.id === 'canvas') {
            const dw = arguments.length === 9 ? arguments[7] : arguments[3];
            if (dw > 0) {
                const radius = dw / 2;
                if (radius > 28) _frameMass += Math.PI * radius * radius * MASS_FACTOR;
            }
        }
        return _origDrawImage.apply(this, arguments);
    };

    let currentMass = 0, leaderboardPos;
    const _fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function () {
        if ((this.fillStyle == "#ffffff" || this.fillStyle == "#626262") && isNaN(arguments?.[0]) && /^Mass: \d+$/gm.test(arguments[0])) {
            currentMass = +arguments[0].match(/(?<=^Mass: )\d+$/gm)[0];
        } else if (this.canvas.id == "leaderboard" && this.fillStyle == "#ffaaaa" && /^\d+(?=\.\s)/gm.test(arguments[0])) {
            [leaderboardPos] = arguments[0].match(/^\d+(?=\.\s)/gm);
        }
        _fillText.apply(this, arguments);
    }

    function isSpawned() {
        const el = document.getElementById('cellsAmount');
        if (el) return parseInt(el.textContent) > 0;
        const ov = document.getElementById('overlays');
        return ov ? ov.style.display === 'none' : false;
    }

    // ── State machine ─────────────────────────────────────────────────────────────
    let autoFeedEnabled = false;
    let state = 'IDLE';
    let posIndex = 0; // Strictly drives the cycle
    let peakMass = 0;
    let feedTimer = 0;
    let mouseTimer = null;
    let splitTimer = null;
    let spawnAttemptTime = 0;
    const SPAWN_RETRY_MS = 6000;

    function currentTarget() { return positions[posIndex]; }
    function advancePos() { posIndex = (posIndex + 1) % positions.length; }

    function startMovingTo(target) {
        if (mouseTimer) workerClearInterval(mouseTimer);
        mouseTimer = workerInterval(() => {
            if (!isSpawned()) { workerClearInterval(mouseTimer); mouseTimer = null; return; }
            mouse(target.x, target.y);
        }, MOUSE_INTERVAL);

        if (splitTimer) workerClearInterval(splitTimer);
        splitTimer = workerInterval(() => {
            if (!isSpawned()) return;
            mouse(target.x, target.y);
            split();
        }, SPLIT_INTERVAL_MS);
    }

    function stopMoving() {
        if (mouseTimer) { workerClearInterval(mouseTimer); mouseTimer = null; }
        if (splitTimer) { workerClearInterval(splitTimer); splitTimer = null; }
    }

    function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

    // Main loop
    workerInterval(() => {
        if (!send || !autoFeedEnabled) return;

        switch (state) {

            case 'IDLE': {
                respawn();
                spawnAttemptTime = Date.now();
                state = 'SPAWNING';
                console.log('[AF] IDLE → SPAWNING');
                break;
            }

            case 'SPAWNING': {
                if (!isSpawned()) {
                    if (Date.now() - spawnAttemptTime > SPAWN_RETRY_MS) {
                        console.log('[AF] Spawn timeout — retrying respawn');
                        respawn();
                        spawnAttemptTime = Date.now();
                    }
                    break;
                }

                if (currentMass < RESPAWN_MASS) {
                    console.log(`[AF] Spawned too small (mass=${currentMass}) — respawning`);
                    respawn();
                    spawnAttemptTime = Date.now();
                    break;
                }

                // NO MORE DISTANCE CHECKS. Just take the current item in the cycle.
                peakMass = currentMass;
                const target = currentTarget();
                console.log(`[AF] Spawned (mass=${peakMass}) → moving to ${target.id} (${target.x},${target.y})`);

                mouse(target.x, target.y);
                split();
                startMovingTo(target);
                state = 'MOVING';
                break;
            }

            case 'MOVING': {
                if (!isSpawned()) {
                    stopMoving();
                    advancePos(); // Don't retry same position after dying
                    state = 'IDLE';
                    break;
                }
                if (currentMass < RESPAWN_MASS) {
                    console.log(`[AF] Mass ${currentMass} < ${RESPAWN_MASS} → respawning, advancing to next`);
                    stopMoving();
                    advancePos(); // Don't retry same position after losing mass
                    respawn();
                    spawnAttemptTime = Date.now();
                    state = 'SPAWNING';
                    break;
                }
                if (currentMass > peakMass) peakMass = currentMass;

                const target = currentTarget();
                const d = dist(myPos, target);

                if (d <= ARRIVE_DIST) {
                    if (currentMass < MIN_FEED_MASS) {
                        console.log(`[AF] At ${target.id} but mass ${currentMass} < ${MIN_FEED_MASS} → skipping to next`);
                        stopMoving();
                        advancePos(); // Cycle to next
                        respawn();
                        spawnAttemptTime = Date.now();
                        state = 'SPAWNING';
                        break;
                    }
                    console.log(`[AF] Arrived at ${target.id} (mass=${currentMass}) → waiting for feed`);
                    peakMass = currentMass;
                    feedTimer = Date.now();
                    split();
                    state = 'WAITING_FEED';
                }
                break;
            }

            case 'WAITING_FEED': {
                if (!isSpawned()) {
                    stopMoving();
                    state = 'IDLE';
                    break;
                }
                if (currentMass < RESPAWN_MASS) {
                    console.log(`[AF] Mass ${currentMass} < ${RESPAWN_MASS} mid-feed → respawning`);
                    stopMoving();
                    advancePos(); // Cycle to next
                    respawn();
                    spawnAttemptTime = Date.now();
                    state = 'SPAWNING';
                    break;
                }

                const dropRatio = (peakMass - currentMass) / peakMass;
                if (dropRatio >= FEED_DROP_RATIO) {
                    console.log(`[AF] Fed at ${currentTarget().id}! Drop ${Math.round(dropRatio * 100)}% → next pos`);
                    stopMoving();
                    advancePos(); // Cycle to next
                    respawn();
                    spawnAttemptTime = Date.now();
                    state = 'SPAWNING';
                    break;
                }

                if (Date.now() - feedTimer > FEED_TIMEOUT_MS) {
                    console.log(`[AF] Feed timeout at ${currentTarget().id} → next pos`);
                    stopMoving();
                    advancePos(); // Cycle to next
                    respawn();
                    spawnAttemptTime = Date.now();
                    state = 'SPAWNING';
                    break;
                }

                if ((Date.now() - feedTimer) % 2000 < 260) split();
                break;
            }
        }
    }, 250);

    // ── UI ────────────────────────────────────────────────────────────────────────
    function createUI() {
        if (!document.body) { setTimeout(createUI, 100); return; }

        const style = document.createElement('style');
        style.textContent = `
            #af-feed-hud{position:fixed;bottom:14px;left:14px;z-index:2147483647;font-family:Arial,sans-serif;user-select:none;}
            #af-feed-pill{display:flex;align-items:center;gap:7px;background:rgba(8,14,24,0.92);border:1.5px solid #888;border-radius:20px;padding:5px 13px 5px 9px;cursor:pointer;transition:border-color 0.2s,box-shadow 0.2s;box-shadow:0 2px 12px rgba(0,0,0,0.3);}
            #af-feed-pill.on{border-color:#4fc3f7;box-shadow:0 2px 12px rgba(79,195,247,0.25);}
            #af-feed-dot{width:8px;height:8px;border-radius:50%;background:#555;transition:background 0.2s;}
            #af-feed-pill.on #af-feed-dot{background:#4fc3f7;}
            #af-feed-label{color:#888;font-weight:bold;font-size:11px;transition:color 0.2s;}
            #af-feed-pill.on #af-feed-label{color:#fff;}
            #af-feed-state{font-size:10px;color:#555;margin-left:2px;transition:color 0.2s;}
            #af-feed-pill.on #af-feed-state{color:#4fc3f7;}
        `;
        document.head.appendChild(style);

        const hud = document.createElement('div');
        hud.id = 'af-feed-hud';
        hud.innerHTML = `
            <div id="af-feed-pill">
                <div id="af-feed-dot"></div>
                <span id="af-feed-label">Auto Feed</span>
                <span id="af-feed-state">OFF</span>
            </div>
        `;
        document.body.appendChild(hud);

        const pill = document.getElementById('af-feed-pill');
        const stateSpan = document.getElementById('af-feed-state');

        pill.addEventListener('click', () => {
            autoFeedEnabled = !autoFeedEnabled;
            if (autoFeedEnabled) {
                state = 'IDLE';
                pill.classList.add('on');
                stateSpan.textContent = 'ON';
                console.log('[AutoFeeder] Started. Target:', currentTarget().id);
            } else {
                stopMoving();
                state = 'IDLE';
                pill.classList.remove('on');
                stateSpan.textContent = 'OFF';
                console.log('[AutoFeeder] Stopped.');
            }
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', createUI);
    else createUI();

    console.log('[AutoFeeder] Loaded. Click the button to start.');
})();