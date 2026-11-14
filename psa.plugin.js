/**
 * @name psa
 * @author psa
 * @description Private per-user fiches: save media + notes against any Discord ID, stored locally. Right-click a user or a message.
 * @version 1.0.0
 */

module.exports = class psa {
    constructor() {
        this.ACCENT = "#FF0000";
        this.BRAND = "psa";
        this.MAX_BYTES = 24 * 1024 * 1024;
        this.EPOCH = 1420070400000n;
        this.IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;
        this.VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;
        this._patches = [];
        // ── psa.sec (vault de tokens intégré) — état de session, jamais persisté en clair ──
        this.SEC_API = "https://discord.com/api/v9";
        this._secKey = null;       // clé AES-GCM en mémoire (session)
        this._secAccounts = null;  // comptes déchiffrés en mémoire
        this._secSalt = null;
    }

    start() {
        this.migrate();
        this.blobIndex();
        try { this.migrateToBlobs(); } catch (e) { /* ignore */ }
        BdApi.DOM.addStyle("psa", this.css());
        const user = BdApi.ContextMenu.patch("user-context", (ret, props) => this.userMenu(ret, props));
        const message = BdApi.ContextMenu.patch("message", (ret, props) => this.messageMenu(ret, props));
        this._patches = [user, message];
        this.injectLauncher();
        this._obs = new MutationObserver(() => {
            if (this._t) return;
            this._t = setTimeout(() => { this._t = null; this.injectLauncher(); this.injectProfileTab(); }, 300);
        });
        this._obs.observe(document.body, { childList: true, subtree: true });
        this.startLogger();
        this._gcT = setTimeout(() => { try { this.gcBlobs(); } catch (e) { /* ignore */ } }, 5000);
        this._maintT = setTimeout(() => { try { this.runBlobMaintenance(); } catch (e) { /* ignore */ } }, 8000);
    }

    stop() {
        this.stopLogger();
        BdApi.DOM.removeStyle("psa");
        for (const un of this._patches) {
            try { un(); } catch (e) { /* ignore */ }
        }
        this._patches = [];
        if (this._obs) { try { this._obs.disconnect(); } catch (e) { /* ignore */ } this._obs = null; }
        if (this._t) { clearTimeout(this._t); this._t = null; }
        const b = document.getElementById("psa-launch");
        if (b) b.remove();
        this._introKilled = true;
        const io = document.getElementById("psa-intro");
        if (io) io.remove();
        if (this._gcT) { clearTimeout(this._gcT); this._gcT = null; }
        if (this._maintT) { clearTimeout(this._maintT); this._maintT = null; }
        if (this._bidxT) this.saveBlobIndex(true);
        this.revokeObjUrls();
        this._secKey = null;
        this._secAccounts = null;   // on oublie le vault déchiffré à l'arrêt
        this._secSalt = null;
    }

    showIntro(onDone) {
        let done = false;
        const finish = () => { if (done) return; done = true; try { const el = document.getElementById("psa-intro"); if (el) el.remove(); } catch (e) { /* ignore */ } if (typeof onDone === "function") onDone(); };
        try {
            if (document.getElementById("psa-intro")) { finish(); return; }
            const o = document.createElement("div");
            o.id = "psa-intro";
            o.className = "psa-intro-overlay";
            o.innerHTML =
                '<div class="psa-io-rays"></div>'
                + '<div class="psa-io-bloom"></div>'
                + '<div class="psa-io-stage">'
                + '<div class="psa-io-name">psa</div>'
                + '<div class="psa-io-tag">le monde chico</div>'
                + '</div>';
            document.body.appendChild(o);
            o.addEventListener("click", finish);
            setTimeout(() => { o.classList.add("out"); }, 2600);
            setTimeout(finish, 3200);
        } catch (e) { finish(); }
    }

    launcherIconUrl() {
        try {
            const of = require("original-fs");
            const p = require("path").join(this.baseDir(), "icon.png");
            if (of.existsSync(p)) return "data:image/png;base64," + of.readFileSync(p, "base64");
        } catch (e) { /* fallback */ }
        return null;
    }

    injectLauncher() {
        try {
            if (document.getElementById("psa-launch")) return;
            const gear = document.querySelector('button[aria-label="User Settings"]') || document.querySelector('button[aria-label="Paramètres utilisateur"]');
            if (!gear || !gear.parentElement) return;
            const btn = document.createElement("button");
            btn.id = "psa-launch";
            btn.className = "psa-launch";
            btn.type = "button";
            btn.setAttribute("aria-label", "psa dashboard");
            const icon = this.launcherIconUrl();
            if (icon) btn.style.backgroundImage = "url(" + icon + ")";
            else btn.textContent = "🐫";
            btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); if (this.cfg().intro !== false && !this._introShown) { this._introShown = true; this.showIntro(() => this.openDashboard()); } else this.openDashboard(); });
            gear.parentElement.appendChild(btn);
        } catch (e) { /* ignore */ }
    }

    selectedTabClass(tabs) {
        try {
            if (tabs.length < 2) return null;
            const a = [].slice.call(tabs[0].classList);
            const b = [].slice.call(tabs[1].classList);
            const diff = a.filter(c => b.indexOf(c) === -1).concat(b.filter(c => a.indexOf(c) === -1));
            return diff.find(c => /select/i.test(c)) || null;
        } catch (e) { return null; }
    }

    profileUserId(modal) {
        try {
            const s = BdApi.Webpack.getStore("UserProfileModalStore");
            if (s) { const id = (s.getUserId && s.getUserId()) || (s.getUser && (s.getUser() || {}).id); if (id) return id; }
        } catch (e) { /* next */ }
        try {
            const scope = (modal && modal.querySelector('[class*="profileHeader"]')) || modal || document;
            const html = (scope.innerHTML || "") + (modal ? modal.innerHTML || "" : "");
            const m = html.match(/\/(?:avatars|banners)\/(\d{17,20})[\/.]/);
            if (m) return m[1];
        } catch (e) { /* ignore */ }
        return null;
    }

    injectProfileTab() {
        try {
            const tablist = document.querySelector('[role="tablist"][class*="top_"]');
            if (!tablist || tablist.querySelector(".psa-ptab")) return;
            if (!/Activity|Mutual|Activité|Serveurs|amis|friends|servers/i.test(tablist.textContent || "")) return;
            const tabs = tablist.querySelectorAll('[role="tab"]');
            if (!tabs.length) return;
            const selClass = this.selectedTabClass(tabs);
            const tmpl = [].slice.call(tabs).find(t => selClass ? !t.classList.contains(selClass) : true) || tabs[0];
            const lbl = tmpl.querySelector("div");
            const modal = tablist.closest('[class*="outer_"]') || tablist.closest('[role="dialog"]') || document.body;
            const self = this;

            const uid = this.profileUserId(modal);
            if (uid) {
                try { const u = BdApi.Webpack.getStore("UserStore").getUser(uid); if (u && u.bot) return; } catch (e) { /* fail open */ }
            }

            const tab = document.createElement("div");
            tab.className = tmpl.className;
            tab.setAttribute("role", "tab");
            tab.classList.add("psa-ptab");
            const label = document.createElement("div");
            if (lbl) label.className = lbl.className;
            label.textContent = "Fiche";
            tab.appendChild(label);

            const getPanel = () => document.querySelector('[role="tabpanel"][class*="tabBarPanel"]');
            const restore = () => {
                const p = getPanel(); if (!p) return;
                const c = p.querySelector(".psa-pcont");
                if (c) {
                    try { if (c._psaRoot) { const r = c._psaRoot; c._psaRoot = null; setTimeout(() => { try { r.unmount(); } catch (e) { /* ignore */ } }, 0); } else if (BdApi.ReactDOM.unmountComponentAtNode) { BdApi.ReactDOM.unmountComponentAtNode(c); } } catch (e) { /* ignore */ }
                    c.remove();
                }
                [].slice.call(p.children).forEach(ch => { ch.style.display = ""; });
                if (selClass) tab.classList.remove(selClass);
            };

            tab.addEventListener("click", (e) => {
                e.preventDefault(); e.stopPropagation();
                const userId = self.profileUserId(modal);
                if (selClass) { [].slice.call(tabs).forEach(t => t.classList.remove(selClass)); tab.classList.add(selClass); }
                const p = getPanel(); if (!p) return;
                [].slice.call(p.children).forEach(ch => { if (!ch.classList.contains("psa-pcont")) ch.style.display = "none"; });
                let cont = p.querySelector(".psa-pcont");
                if (!cont) { cont = document.createElement("div"); cont.className = "psa-pcont"; p.appendChild(cont); }
                try {
                    const el = BdApi.React.createElement(self.ficheComponent(userId || "0"));
                    if (BdApi.ReactDOM.createRoot) {
                        if (!cont._psaRoot) cont._psaRoot = BdApi.ReactDOM.createRoot(cont);
                        cont._psaRoot.render(el);
                    } else {
                        BdApi.ReactDOM.render(el, cont);
                    }
                } catch (err) { cont.style.color = "#fff"; cont.style.fontSize = "13px"; cont.textContent = "psa error: " + ((err && err.message) || err); }
            });

            [].slice.call(tabs).forEach(t => t.addEventListener("click", restore));
            tablist.appendChild(tab);
        } catch (e) { /* ignore */ }
    }

    dumpDiscord() {
        try {
            const out = ["=== psa Discord snapshot @ " + new Date().toISOString() + " ==="];
            const cs = getComputedStyle(document.documentElement);
            out.push("\n=== THEME VARS ===");
            for (let i = 0; i < cs.length; i++) {
                const n = cs[i];
                if (n.indexOf("--") === 0) out.push(n + ": " + cs.getPropertyValue(n).trim());
            }
            const subs = new Set();
            for (const sheet of document.styleSheets) {
                let rules;
                try { rules = sheet.cssRules; } catch (e) { continue; }
                if (!rules) continue;
                for (const rule of rules) {
                    const sel = rule.selectorText;
                    if (!sel) continue;
                    const m = sel.match(/\[class\*=["']([^"']+)["']\]/g);
                    if (m) m.forEach(x => { const s = x.match(/["']([^"']+)["']/); if (s) subs.add(s[1]); });
                }
            }
            out.push("\n=== MY CLASSES vs Discord [class*=] ===");
            const mine = ["psa-settings", "psa-side", "psa-sitem", "psa-sitem-ic", "psa-main", "psa-close", "psa-panel", "psa-pgr", "psa-stage", "psa-fiche", "psa-launch", "psa-fhead", "psa-fav", "psa-fname", "stat", "ico", "pill", "acts", "ibtn", "who", "num", "dim", "empty", "psa-nav"];
            const arr = [].slice.call(subs);
            let any = false;
            for (const c of mine) {
                const hits = arr.filter(s => c.indexOf(s) !== -1);
                if (hits.length) { out.push("⚠ " + c + " matches: " + hits.join(", ")); any = true; }
            }
            if (!any) out.push("no collisions ✓");
            require("fs").writeFileSync(require("path").join(this.mediaRoot(), "..", "psa-dbg-discord.txt"), out.join("\n"));
            this.toast("Discord snapshot → data/psa-dbg-discord.txt");
        } catch (e) { this.toast("Dump failed: " + ((e && e.message) || e), "error"); }
    }

    css() {
        return `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..600,0..1,0&display=swap');
.psa-empty{text-align:center;color:var(--text-muted);padding:30px 0;font-size:14px;}
.psa-launch{width:32px;height:32px;border:none;border-radius:8px;background-color:transparent;background-size:22px 22px;background-position:center;background-repeat:no-repeat;cursor:pointer;color:#b5bac1;display:flex;align-items:center;justify-content:center;font-size:18px;padding:0;margin:0 2px;flex:0 0 auto;}
.psa-launch:hover{background-color:rgba(255,255,255,.08);}
.psa-intro-overlay{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;overflow:hidden;background:radial-gradient(600px 440px at 50% 46%,rgba(0,0,0,.42),rgba(0,0,0,0) 70%);cursor:pointer;animation:psaIoIn .25s ease;transition:opacity .5s ease;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",system-ui,sans-serif;}
.psa-intro-overlay.out{opacity:0;}
.psa-io-rays{position:absolute;left:50%;top:50%;width:1100px;height:1100px;margin:-550px 0 0 -550px;z-index:1;pointer-events:none;background:conic-gradient(from 0deg,#4cd42c00 0deg,#4cd42c1f 8deg,#4cd42c00 16deg,#4cd42c00 40deg,#4cd42c1f 48deg,#4cd42c00 56deg,#4cd42c00 90deg,#4cd42c1f 98deg,#4cd42c00 106deg,#4cd42c00 180deg,#4cd42c1f 188deg,#4cd42c00 196deg,#4cd42c00 270deg,#4cd42c1f 278deg,#4cd42c00 286deg);opacity:0;animation:psaIoRays 2.6s ease forwards;}
.psa-io-bloom{position:absolute;left:50%;top:50%;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;z-index:1;pointer-events:none;background:radial-gradient(circle,#eafff0,#4cd42c 40%,transparent 70%);opacity:0;animation:psaIoBloom 1.5s ease forwards;}
.psa-io-stage{position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;}
.psa-io-name{font-style:italic;font-weight:900;font-size:76px;letter-spacing:-.02em;color:#4cd42c;line-height:1;opacity:0;transform:scale(.6);filter:blur(10px);animation:psaIoBloomName 1s ease .3s forwards,psaIoGlow 2.6s ease-in-out 1.4s infinite;}
.psa-io-tag{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-weight:600;font-size:11px;text-transform:uppercase;color:#9dee86;margin-top:16px;opacity:0;text-shadow:0 0 10px rgba(76,212,44,.5);animation:psaIoSpread .9s ease 1.2s forwards;}
@keyframes psaIoIn{from{opacity:0}to{opacity:1}}
@keyframes psaIoBloom{0%{opacity:0;transform:scale(.2)}22%{opacity:1;transform:scale(6)}45%{opacity:.16;transform:scale(12)}100%{opacity:0;transform:scale(16)}}
@keyframes psaIoRays{0%{opacity:0;transform:rotate(0deg)}25%{opacity:1}70%{opacity:.5}100%{opacity:.3;transform:rotate(55deg)}}
@keyframes psaIoBloomName{0%{opacity:0;transform:scale(.6);filter:blur(10px)}55%{opacity:1;transform:scale(1);filter:blur(0);text-shadow:0 0 34px #4cd42c,0 0 80px rgba(76,212,44,.55)}100%{opacity:1;transform:scale(1);filter:blur(0)}}
@keyframes psaIoGlow{0%,100%{text-shadow:0 0 10px rgba(76,212,44,.5)}50%{text-shadow:0 0 26px rgba(76,212,44,.95),0 0 60px rgba(76,212,44,.45)}}
@keyframes psaIoSpread{from{opacity:0;letter-spacing:.02em}to{opacity:.92;letter-spacing:.34em}}
.psa-pcont{padding:12px 16px;width:100%;max-width:100%;box-sizing:border-box;overflow-x:hidden;}
.psa-pcont .psa-fiche{min-width:0;max-width:100%;}
.psa-pcont .psa-stage{height:300px;}
.psa-fhead{flex-wrap:wrap;}
.psa-foot{display:flex;justify-content:space-between;align-items:center;margin-top:12px;font-size:11px;color:var(--text-muted);opacity:.7;}
.psa-app{--pink:#43c62b;--pinkbg:rgba(67,198,43,.15);--pinktx:#7ee066;--bg:#100e15;--card:#1a1622;--line:#2b2634;--text:#ededf2;--muted:#9b93a8;--faint:#6f6880;--redbg:rgba(255,92,92,.16);--redtx:#ff7a7a;--amberbg:rgba(255,180,60,.14);--ambertx:#e0a84a;width:100%;background:var(--bg);color:var(--text);border-radius:14px;padding:18px;border:1px solid var(--line);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text","Helvetica Neue","Segoe UI",system-ui,sans-serif;box-sizing:border-box;}
.psa-app *{box-sizing:border-box;}
.psa-app .top{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;gap:12px;flex-wrap:wrap;}
.psa-app .hi h1{font-size:21px;font-weight:800;margin:0;letter-spacing:-.02em;color:var(--text);}
.psa-app .hi p{margin:3px 0 0;font-size:13px;color:var(--muted);}
.psa-app .tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.psa-app .sort{height:34px;display:flex;align-items:center;gap:6px;padding:0 12px;border:1px solid var(--line);border-radius:9px;font-size:13px;color:var(--muted);cursor:pointer;background:#17151c;white-space:nowrap;}
.psa-app .sort:hover{background:#221e2a;color:var(--text);}
.psa-app .sort b{color:var(--text);font-weight:600;}
.psa-app .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:20px;}
.psa-app .stat{border:1px solid var(--line);border-radius:14px;padding:12px;display:flex;align-items:center;gap:10px;min-width:0;background:var(--card);}
.psa-app .stat .ico{width:42px;height:42px;border-radius:50%;background:var(--pinkbg);color:var(--pink);display:flex;align-items:center;justify-content:center;font-size:19px;flex:0 0 auto;}
.psa-app .stat .m{min-width:0;}
.psa-app .stat .l{font-size:12px;color:var(--muted);margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.psa-app .stat .v{font-size:20px;font-weight:800;letter-spacing:-.02em;line-height:1;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.psa-app .stat .t{font-size:11px;color:var(--faint);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.psa-app .panel{border:1px solid var(--line);border-radius:14px;padding:16px;background:var(--card);}
.psa-app .phead{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px;flex-wrap:wrap;}
.psa-app .phead .pt{font-size:16px;font-weight:800;margin:0;color:var(--text);}
.psa-app .phead .ps{font-size:12px;color:var(--pink);font-weight:600;margin-top:2px;}
.psa-app .tsearch{height:34px;width:170px;max-width:44vw;border:1px solid var(--line);border-radius:9px;padding:0 12px;font-size:13px;outline:none;background:#100e15;color:var(--text);}
.psa-app .tsearch::placeholder{color:var(--faint);}
.psa-app .twrap{overflow-x:auto;margin:0 -4px;}
.psa-app table{width:100%;border-collapse:collapse;table-layout:fixed;min-width:540px;}
.psa-app col.c1{width:38%;}.psa-app col.c2{width:10%;}.psa-app col.c3{width:10%;}.psa-app col.c4{width:13%;}.psa-app col.c5{width:16%;}.psa-app col.c6{width:13%;}
.psa-app thead th{text-align:left;font-size:12px;font-weight:600;color:var(--muted);padding:0 8px 12px;border-bottom:1px solid var(--line);white-space:nowrap;}
.psa-app thead th.r{text-align:right;}
.psa-app tbody td{padding:11px 8px;border-bottom:1px solid var(--line);font-size:14px;vertical-align:middle;white-space:nowrap;overflow:hidden;color:var(--text);}
.psa-app tbody tr:last-child td{border-bottom:none;}
.psa-app tbody tr:hover{background:rgba(255,255,255,.03);}
.psa-app .who{display:flex;align-items:center;gap:11px;min-width:0;}
.psa-app .av{width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#14261a,#0f1a12);display:flex;align-items:center;justify-content:center;font-weight:700;color:var(--pinktx);font-size:14px;flex:0 0 auto;overflow:hidden;}
.psa-app .av img{width:100%;height:100%;object-fit:cover;}
.psa-app .who .m{min-width:0;}
.psa-app .who .n{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text);}
.psa-app .who .id{font-size:12px;color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.psa-app .num{font-variant-numeric:tabular-nums;}
.psa-app .dim{color:var(--muted);}
.psa-app .pill{display:inline-flex;align-items:center;gap:5px;padding:5px 10px;border-radius:8px;font-size:12px;font-weight:600;white-space:nowrap;}
.psa-app .pill.g{background:var(--pinkbg);color:var(--pinktx);}
.psa-app .pill.a{background:var(--amberbg);color:var(--ambertx);}
.psa-app .acts{display:flex;gap:6px;justify-content:flex-end;}
.psa-app .ibtn{width:31px;height:31px;border-radius:8px;border:1px solid var(--line);background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:14px;color:var(--muted);transition:.12s;}
.psa-app .ibtn:hover{background:#221e2a;color:var(--text);}
.psa-app .ibtn.del:hover{background:var(--redbg);color:var(--redtx);border-color:var(--redbg);}
.psa-app .empty{text-align:center;color:var(--muted);padding:34px 0;font-size:14px;}
.psa-app .pfoot{display:flex;justify-content:space-between;align-items:center;margin-top:14px;font-size:11px;color:var(--faint);}
.psa-modal-wrap{padding:16px;}
.psa-fiche{--green:#4cd42c;--green-txt:#9dee86;--green-dim:rgba(76,212,44,.12);--green-line:rgba(76,212,44,.35);--bg:#08080a;--card:#131317;--line:#212127;--line2:#2b2b33;--text:#ecedf0;--muted:#8a8a95;--faint:#565661;--redbg:rgba(255,107,107,.14);--redtx:#ff6b6b;--mono:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text","Helvetica Neue","Segoe UI",system-ui,sans-serif;color:var(--text);width:100%;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text","Helvetica Neue","Segoe UI",system-ui,sans-serif;position:relative;background:radial-gradient(500px 320px at 8% -20%,rgba(76,212,44,.07),transparent 60%);border-radius:12px;}
.psa-fiche *{box-sizing:border-box;}
.psa-fhead{display:flex;align-items:center;gap:14px;margin-bottom:14px;}
.psa-fav{width:56px;height:56px;border-radius:12px;background:#0c0c0f;border:1px solid var(--green-line);display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-weight:700;color:var(--green-txt);font-size:20px;flex:0 0 auto;overflow:hidden;box-shadow:0 0 20px rgba(76,212,44,.16);}
.psa-fav img{width:100%;height:100%;object-fit:cover;}
.psa-fmeta{flex:1;min-width:0;}
.psa-fname{font-weight:600;font-size:20px;color:#fff;letter-spacing:-.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.psa-fsub{font-family:var(--mono);font-size:11px;color:var(--faint);margin-top:3px;letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.psa-fstat{font-family:var(--mono);font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--green-txt);background:var(--green-dim);border:1px solid var(--green-line);padding:6px 12px;border-radius:8px;white-space:nowrap;flex:0 0 auto;}
.psa-alias{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;}
.psa-alias .p{font-family:var(--mono);padding:4px 10px;border-radius:7px;background:var(--card);border:1px solid var(--line2);color:var(--muted);font-size:11px;}
.psa-stage{position:relative;width:100%;height:460px;background:#050506;border:1px solid var(--line2);border-radius:14px;overflow:hidden;display:flex;align-items:center;justify-content:center;box-shadow:inset 0 0 60px rgba(0,0,0,.6);}
.psa-stagemedia{max-width:100%;max-height:100%;object-fit:contain;display:block;}
.psa-pgr{position:absolute;top:50%;transform:translateY(-50%);width:42px;height:42px;border-radius:10px;border:1px solid var(--line2);background:rgba(8,8,10,.7);color:#fff;font-size:22px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:.14s;z-index:2;}
.psa-pgr:hover{background:var(--green);color:#04120a;border-color:var(--green);}
.psa-pgr.l{left:12px;}
.psa-pgr.r{right:12px;}
.psa-counter{position:absolute;bottom:12px;left:50%;transform:translateX(-50%);background:rgba(8,8,10,.75);border:1px solid var(--line2);color:var(--green-txt);font-family:var(--mono);font-size:11px;letter-spacing:.1em;padding:4px 12px;border-radius:20px;}
.psa-stageempty{color:var(--muted);font-family:var(--mono);font-size:13px;}
.psa-stagefail{text-align:center;color:var(--muted);padding:20px;max-width:420px;}
.psa-failic{font-size:46px;margin-bottom:12px;}
.psa-failt{font-size:14px;color:#cfcfd6;margin-bottom:18px;line-height:1.5;}
.psa-failb{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;}
.psa-cap{font-family:var(--mono);font-size:11px;color:var(--faint);margin-top:8px;text-align:center;letter-spacing:.02em;}
.psa-factions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px;}
.psa-notes-t{font-family:var(--mono);font-weight:700;font-size:11px;letter-spacing:.2em;text-transform:uppercase;margin:18px 0 8px;color:var(--muted);}
.psa-note{display:flex;align-items:flex-start;gap:8px;font-size:13px;color:#cfcfd6;margin-bottom:6px;padding:9px 12px;background:var(--card);border:1px solid var(--line);border-left:2px solid var(--green-line);border-radius:8px;}
.psa-note-t{flex:1;min-width:0;word-break:break-word;line-height:1.45;}
.psa-note-del{flex:0 0 auto;width:22px;height:22px;border-radius:6px;border:1px solid var(--line2);background:transparent;color:var(--faint);cursor:pointer;font-size:10px;display:flex;align-items:center;justify-content:center;transition:.14s;}
.psa-note-del:hover{border-color:#ff5555;color:#ff5555;background:rgba(255,85,85,.12);}
.psa-acth{display:flex;align-items:center;gap:10px;margin:22px 0 14px;}
.psa-acth-l{font-family:var(--mono);font-weight:700;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--green-txt);}
.psa-acth-l b{color:var(--faint);font-weight:700;}
.psa-acth-rule{flex:1;height:1px;background:linear-gradient(90deg,rgba(76,212,44,.4),var(--line2) 60%);}
.psa-acth-m{font-family:var(--mono);font-weight:600;font-size:9.5px;letter-spacing:.06em;color:var(--faint);font-variant-numeric:tabular-nums;}
.psa-tl{position:relative;padding-left:26px;}
.psa-tl::before{content:"";position:absolute;left:6px;top:6px;bottom:10px;width:1px;background:linear-gradient(180deg,rgba(76,212,44,.3),var(--line2) 40%,transparent);}
.psa-ev{position:relative;margin-bottom:12px;}
.psa-node{position:absolute;left:-23px;top:14px;width:11px;height:11px;border-radius:50%;background:#0c0c10;border:2px solid var(--faint);}
.psa-ev.del .psa-node{border-color:#ff5555;box-shadow:0 0 0 3px rgba(255,85,85,.14),0 0 10px rgba(255,85,85,.47);animation:psaPulse 2.6s ease-in-out infinite;}
.psa-ev.edt .psa-node{border-color:#e6ab48;box-shadow:0 0 0 3px rgba(230,171,72,.14),0 0 10px rgba(230,171,72,.47);animation:psaPulse 2.6s ease-in-out infinite .4s;}
.psa-ev-card{border:1px solid var(--line);border-radius:11px;background:#0a0a0d;padding:12px 14px;transition:border-color .16s,transform .16s,box-shadow .16s;}
.psa-ev-card:hover{transform:translateX(2px);border-color:var(--line2);box-shadow:-8px 0 24px -18px var(--green);}
.psa-ev.del .psa-ev-card{border-left:2px solid #ff5555;}
.psa-ev.edt .psa-ev-card{border-left:2px solid #e6ab48;}
.psa-ev-top{display:flex;align-items:center;gap:9px;margin-bottom:9px;}
.psa-tag{font-family:var(--mono);font-weight:700;font-size:9px;letter-spacing:.11em;text-transform:uppercase;padding:3px 7px;border-radius:5px;flex:0 0 auto;}
.psa-tag.del{color:#ff5555;background:rgba(255,85,85,.12);}
.psa-tag.edt{color:#e6ab48;background:rgba(230,171,72,.12);}
.psa-ev-loc{font-family:var(--mono);font-weight:600;font-size:10px;color:var(--muted);letter-spacing:.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.psa-ev-loc .h{color:var(--faint);}
.psa-ev-loc b{color:var(--green-txt);font-weight:600;}
.psa-ev-when{margin-left:auto;font-family:var(--mono);font-weight:600;font-size:10px;color:var(--faint);font-variant-numeric:tabular-nums;white-space:nowrap;flex:0 0 auto;}
.psa-ev-body{font-size:13.5px;line-height:1.5;color:#dcdce4;white-space:pre-wrap;word-break:break-word;}
.psa-ev-body.del{color:#d78f8f;}
.psa-ev-body .strk{text-decoration:line-through;text-decoration-color:rgba(255,85,85,.47);text-decoration-thickness:1.5px;}
.psa-ev-empty{color:var(--faint);font-family:var(--mono);font-style:italic;font-size:12.5px;}
.psa-diff{font-family:var(--mono);font-weight:500;font-size:12.5px;border-radius:8px;overflow:hidden;border:1px solid var(--line);}
.psa-diff-row{display:flex;gap:8px;padding:5px 10px;line-height:1.45;white-space:pre-wrap;word-break:break-word;}
.psa-diff-row .g{flex:0 0 auto;user-select:none;font-weight:700;}
.psa-diff-row.minus{background:rgba(255,92,92,.08);color:#e79a9a;}
.psa-diff-row.minus .g{color:#ff6b6b;}
.psa-diff-row.plus{background:rgba(76,212,44,.10);color:var(--green-txt);}
.psa-diff-row.plus .g{color:var(--green);}
.psa-ev-media{display:flex;gap:8px;margin-top:11px;flex-wrap:wrap;}
.psa-ev-media .psa-gcell{width:80px;height:80px;flex:0 0 auto;aspect-ratio:auto;}
.psa-ev-m{width:58px;height:58px;border-radius:8px;border:1px solid var(--line2);background:#121216;display:flex;align-items:center;justify-content:center;font-size:19px;color:var(--faint);position:relative;overflow:hidden;}
.psa-ev-m.saved{border-color:rgba(76,212,44,.4);box-shadow:inset 0 0 14px rgba(76,212,44,.1);}
.psa-ev-m.dead{border-color:rgba(255,85,85,.35);opacity:.7;}
.psa-ev-m.vid::before{content:"▶";position:absolute;font-size:15px;color:#fff;text-shadow:0 0 5px #000;}
.psa-ev-m .kind{position:absolute;bottom:3px;left:3px;font-family:var(--mono);font-weight:700;font-size:7px;letter-spacing:.05em;color:#fff;background:rgba(0,0,0,.66);padding:1px 3px;border-radius:3px;text-transform:uppercase;}
.psa-ev-m .ok{position:absolute;top:3px;right:3px;width:13px;height:13px;border-radius:50%;background:var(--green);color:#04120a;font-size:9px;display:flex;align-items:center;justify-content:center;font-weight:900;box-shadow:0 0 6px rgba(76,212,44,.6);}
.psa-ev-m .x{position:absolute;top:3px;right:3px;width:13px;height:13px;border-radius:50%;background:#ff5555;color:#1a0606;font-size:8px;display:flex;align-items:center;justify-content:center;font-weight:900;}
.psa-idnow{display:flex;align-items:center;gap:12px;padding:11px 13px;border:1px solid var(--line);border-left:2px solid var(--green);border-radius:10px;background:var(--card);margin-bottom:10px;}
.psa-idlab{font-family:var(--mono);font-weight:700;font-size:8.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--green);background:var(--green-dim);padding:3px 7px;border-radius:5px;flex:0 0 auto;}
.psa-idvcol{min-width:0;}
.psa-idval{font-weight:700;font-size:14.5px;color:#fff;}
.psa-idsub{font-family:var(--mono);font-weight:600;font-size:11px;color:var(--faint);margin-top:2px;}
.psa-idhist{display:flex;flex-direction:column;}
.psa-idrow{display:flex;align-items:center;gap:9px;padding:9px 4px;border-bottom:1px solid var(--line);font-size:13px;flex-wrap:wrap;}
.psa-idrow:last-child{border-bottom:none;}
.psa-idk{font-family:var(--mono);font-weight:700;font-size:8px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);flex:0 0 auto;}
.psa-idold{font-family:var(--mono);font-weight:600;color:var(--muted);text-decoration:line-through;text-decoration-color:#5a5a66;}
.psa-idarr{color:var(--green);font-family:var(--mono);font-weight:700;}
.psa-idnew{font-family:var(--mono);font-weight:700;color:var(--green-txt);}
.psa-idwhen{margin-left:auto;font-family:var(--mono);font-weight:600;font-size:10px;color:var(--faint);white-space:nowrap;flex:0 0 auto;font-variant-numeric:tabular-nums;}
.psa-avstrip{display:flex;align-items:center;gap:9px;padding:12px 2px 4px;overflow-x:auto;}
.psa-avitem{flex:0 0 auto;text-align:center;}
.psa-avpic{width:42px;height:42px;border-radius:11px;overflow:hidden;border:1px solid var(--line2);background:#111116;display:flex;align-items:center;justify-content:center;color:var(--faint);font-family:var(--mono);}
.psa-avpic img{width:100%;height:100%;object-fit:cover;}
.psa-avitem.cur .psa-avpic{border-color:#4cd42c88;box-shadow:0 0 0 2px rgba(76,212,44,.13);}
.psa-avdt{font-family:var(--mono);font-weight:600;font-size:8.5px;color:var(--faint);margin-top:5px;}
.psa-avarr{color:var(--faint);font-family:var(--mono);flex:0 0 auto;}
.psa-pday{font-family:var(--mono);font-weight:700;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin:10px 0 6px;}
.psa-prow{display:flex;align-items:center;gap:11px;padding:8px 4px;border-bottom:1px solid var(--line);}
.psa-prow:last-child{border-bottom:none;}
.psa-pdot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;margin:0 8px;}
.psa-pdot.online{background:#3ba55d;box-shadow:0 0 7px #3ba55d;}
.psa-pdot.idle{background:#e0a728;box-shadow:0 0 7px #e0a728;}
.psa-pdot.dnd{background:#ed4245;box-shadow:0 0 7px #ed4245;}
.psa-pdot.offline{background:#6a6a75;}
.psa-pico{width:26px;height:26px;border-radius:7px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;font-size:13px;background:#111116;border:1px solid var(--line2);}
.psa-pico.spot{color:#1db954;}
.psa-pmain{flex:1;min-width:0;}
.psa-pttl{font-size:13px;color:#dcdce4;font-weight:500;}
.psa-pttl b{color:#fff;font-weight:700;}
.psa-pttl b.psa-spot{color:#1db954;}
.psa-psub{font-family:var(--mono);font-weight:600;font-size:10.5px;color:var(--faint);margin-top:2px;}
.psa-pdur{font-family:var(--mono);font-weight:700;font-size:10px;color:var(--green-txt);background:var(--green-dim);padding:2px 7px;border-radius:5px;flex:0 0 auto;margin-left:auto;}
.psa-pwhen{margin-left:auto;font-family:var(--mono);font-weight:600;font-size:10px;color:var(--faint);white-space:nowrap;flex:0 0 auto;font-variant-numeric:tabular-nums;}
.psa-tgl{display:flex;align-items:center;gap:14px;padding:12px 0;cursor:pointer;border-top:1px solid var(--line);}
.psa-tgl-tx{flex:1;min-width:0;}
.psa-tgl-l{font-size:13.5px;font-weight:600;color:var(--text);}
.psa-tgl-d{font-family:var(--mono);font-size:10.5px;color:var(--faint);margin-top:3px;letter-spacing:.01em;}
.psa-switch{flex:0 0 auto;width:40px;height:23px;border-radius:999px;background:#1c1c22;border:1px solid var(--line2);position:relative;transition:.18s;}
.psa-switch .knob{position:absolute;top:2px;left:2px;width:17px;height:17px;border-radius:50%;background:#6f6f7a;transition:.18s;}
.psa-switch.on{background:var(--green-dim);border-color:rgba(76,212,44,.5);}
.psa-switch.on .knob{left:19px;background:var(--green);box-shadow:0 0 10px rgba(76,212,44,.6);}
.psa-settings .psa-spad{padding:20px 22px 22px;}
.psa-spanel-h{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:11px;}
.psa-spanel-h .psa-pt{margin:0;}
.psa-spad>.psa-pt{margin-bottom:9px;}
.psa-spad>.psa-about{margin-bottom:16px;}
.psa-settings .psa-spad .psa-about{line-height:1.65;font-size:12.5px;}
.psa-status{display:inline-flex;align-items:center;gap:7px;font-family:var(--mono);font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);padding:5px 11px;border-radius:999px;border:1px solid var(--line2);flex:0 0 auto;}
.psa-status .d{width:6px;height:6px;border-radius:50%;background:var(--faint);}
.psa-status.on{color:var(--green);border-color:rgba(76,212,44,.4);background:var(--green-dim);}
.psa-status.on .d{background:var(--green);box-shadow:0 0 8px var(--green);animation:psaPulse 1.8s ease-in-out infinite;}
.psa-input{width:100%;height:38px;padding:0 12px;border-radius:9px;background:#0b0b0e;color:var(--text);border:1px solid var(--line2);outline:none;font-size:14px;font-family:var(--mono);}
.psa-btn{height:38px;padding:0 16px;border-radius:9px;border:1px solid var(--line2);cursor:pointer;font-family:var(--mono);font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--text);background:#111114;display:inline-flex;align-items:center;justify-content:center;gap:6px;transition:.14s;}
.psa-btn:hover{border-color:var(--green-line);color:var(--green-txt);}
.psa-btn.psa-pink{background:var(--green);border-color:transparent;color:#04120a;}
.psa-btn.psa-pink:hover{background:#37c220;color:#04120a;}
.psa-btn.psa-red{background:var(--redbg);border-color:transparent;color:var(--redtx);}
.psa-btn.psa-red:hover{background:#ff4d4d;color:#fff;}
.psa-fiche::before{content:"";position:absolute;inset:0;pointer-events:none;opacity:.4;background-image:linear-gradient(#212127 1px,transparent 1px),linear-gradient(90deg,#212127 1px,transparent 1px);background-size:44px 44px;-webkit-mask-image:radial-gradient(700px 420px at 10% -10%,#000,transparent 70%);mask-image:radial-gradient(700px 420px at 10% -10%,#000,transparent 70%);z-index:0;border-radius:12px;}
.psa-fiche > *{position:relative;z-index:1;}
.bd-modal-root:has(.psa-fiche){background:#08080a!important;border:1px solid #2b2b33!important;box-shadow:0 24px 80px rgba(0,0,0,.6),0 0 60px rgba(76,212,44,.05)!important;}
.bd-modal-root:has(.psa-fiche) .bd-modal-content{background:transparent!important;}
.bd-modal-root:has(.psa-fiche) .bd-modal-header{background:transparent!important;border-bottom:1px solid #1b1b1f!important;}
.bd-modal-root:has(.psa-fiche) .bd-modal-header *{color:#ecedf0!important;font-family:ui-monospace,"SF Mono",Consolas,monospace!important;letter-spacing:.1em;}
.bd-modal-root:has(.psa-fiche) .bd-modal-footer{background:#0b0b0e!important;border-top:1px solid #1b1b1f!important;}
.bd-modal-root:has(.psa-fiche) .bd-modal-footer .bd-button{background:rgba(76,212,44,.14)!important;color:#9dee86!important;border:1px solid rgba(76,212,44,.35)!important;}
.bd-modal-root:has(.psa-fiche) .bd-modal-footer .bd-button:hover{background:#4cd42c!important;color:#04120a!important;}
.psa-modal-wrap{width:100%;padding:16px;box-sizing:border-box;}
.psa-modal-root{width:900px!important;max-width:94vw!important;}
.bd-modal-root:has(.psa-modal-wrap){width:900px!important;max-width:94vw!important;}
.bd-modal-content:has(.psa-modal-wrap){width:100%!important;max-width:100%!important;max-height:82vh!important;}
[role="dialog"]:has(.psa-modal-wrap){width:900px!important;max-width:94vw!important;}
[role="dialog"]:has(.psa-modal-wrap) [class*="content_"],[role="dialog"]:has(.psa-modal-wrap) [class*="content-"]{width:100%!important;max-width:100%!important;max-height:82vh!important;}
.bd-modal-root:has(.psa-settings){width:94vw!important;max-width:1180px!important;height:88vh!important;position:fixed!important;left:50%!important;top:50%!important;transform:translate(-50%,-50%)!important;margin:0!important;}
.bd-modal-content:has(.psa-settings){padding:0!important;max-height:none!important;height:100%!important;}
.bd-modal-root:has(.psa-settings) .bd-modal-header,.bd-modal-root:has(.psa-settings) .bd-modal-footer{display:none!important;}
.psa-modal-wrap:has(.psa-settings){padding:0!important;height:100%!important;}
[role="dialog"]:has(.psa-settings){width:94vw!important;max-width:1180px!important;height:88vh!important;position:fixed!important;left:50%!important;top:50%!important;transform:translate(-50%,-50%)!important;margin:0!important;}
.psa-settings{--green:#4cd42c;--green-txt:#9dee86;--green-dim:rgba(76,212,44,.12);--green-line:rgba(76,212,44,.35);--bg:#08080a;--panel:#0e0e11;--card:#131317;--card2:#17171c;--side:#0c0c0f;--line:#212127;--line2:#2b2b33;--text:#ecedf0;--muted:#8a8a95;--faint:#565661;--amberbg:rgba(224,168,74,.14);--ambertx:#e0a84a;--redbg:rgba(255,107,107,.14);--redtx:#ff6b6b;--mono:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text","Helvetica Neue","Segoe UI",system-ui,sans-serif;display:flex;height:100%;min-height:520px;color:var(--text);overflow:hidden;border-radius:8px;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text","Helvetica Neue","Segoe UI",system-ui,sans-serif;box-sizing:border-box;position:relative;background:radial-gradient(680px 440px at 12% -6%,rgba(76,212,44,.09),transparent 60%),var(--bg);}
.psa-settings *{box-sizing:border-box;}
.psa-settings::before{content:"";position:absolute;inset:0;pointer-events:none;opacity:.5;background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);background-size:44px 44px;-webkit-mask-image:radial-gradient(900px 600px at 12% 0%,#000,transparent 70%);mask-image:radial-gradient(900px 600px at 12% 0%,#000,transparent 70%);}
.psa-side{width:252px;flex:0 0 252px;border-right:1px solid var(--line);background:linear-gradient(180deg,rgba(255,255,255,.015),transparent);display:flex;flex-direction:column;padding:20px 14px;overflow-y:auto;position:relative;z-index:1;}
.psa-brand{display:flex;align-items:center;gap:11px;padding:2px 6px 18px;}
.psa-logo{width:40px;height:40px;border-radius:11px;background:#0c0c0f;border:1px solid var(--green-line);display:flex;align-items:center;justify-content:center;font-size:20px;flex:0 0 auto;overflow:hidden;box-shadow:0 0 22px rgba(76,212,44,.18);}
.psa-logo img{width:100%;height:100%;object-fit:contain;}
.psa-bt{font-family:var(--mono);font-weight:600;font-size:16px;letter-spacing:-.02em;color:#fff;}
.psa-bs{font-family:var(--mono);font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--green-txt);opacity:.75;}
.psa-side-search{height:36px;border:1px solid var(--line);border-radius:9px;background:#0b0b0e;color:var(--text);padding:0 12px;font-size:12px;font-family:var(--mono);letter-spacing:.02em;outline:none;margin-bottom:16px;}
.psa-side-search::placeholder{color:var(--faint);}
.psa-grp{font-family:var(--mono);font-size:10px;letter-spacing:.24em;color:var(--faint);text-transform:uppercase;padding:12px 8px 6px;}
.psa-sitem{position:relative!important;width:100%!important;display:flex;align-items:center;gap:11px;padding:9px 11px;border-radius:9px;font-size:14px;color:var(--muted);cursor:pointer;margin-bottom:2px;box-sizing:border-box;transition:.16s;}
.psa-sitem:hover{background:rgba(255,255,255,.035);color:var(--text);}
.psa-sitem.on{background:var(--green-dim);color:#fff;}
.psa-sitem.on::before{content:"";position:absolute;left:-14px;top:8px;bottom:8px;width:3px;border-radius:0 3px 3px 0;background:var(--green);box-shadow:0 0 12px var(--green);}
.psa-sitem-ic{width:18px;text-align:center;flex:0 0 auto;opacity:.85;}
.psa-side-foot{margin-top:auto;padding:16px 8px 4px;border-top:1px solid var(--line);}
.psa-sig{display:inline-flex;align-items:center;gap:11px;user-select:none;}
.psa-mol{flex:0 0 auto;overflow:visible;}
.psa-mol line{stroke:var(--green);stroke-width:1.6;stroke-linecap:round;filter:drop-shadow(0 0 3px rgba(76,212,44,.55));}
.psa-mol circle{fill:#08080a;stroke:var(--green);stroke-width:1.4;filter:drop-shadow(0 0 3px rgba(76,212,44,.6));}
.psa-sig-name{display:inline-flex;flex-direction:column;line-height:1;}
.psa-sig-name .n{font-style:italic;font-weight:800;font-size:18px;letter-spacing:-.01em;color:var(--green);animation:psaGlow 3.2s ease-in-out infinite;}
.psa-sig-name .psa-formula{font-style:normal;font-family:var(--mono);font-weight:700;font-size:9.5px;letter-spacing:.02em;color:var(--green-txt);margin-top:6px;}
.psa-sig-name .psa-formula b{color:#fff;font-weight:700;}
.psa-sig-name .psa-formula .s{font-size:.78em;vertical-align:-.28em;color:var(--green);}
.psa-foot .psa-sig-name .n{font-size:15px;}
@keyframes psaGlow{0%,100%{text-shadow:0 0 4px rgba(76,212,44,.4);}50%{text-shadow:0 0 12px rgba(76,212,44,.9),0 0 26px rgba(76,212,44,.45);}}
.psa-main{flex:1;min-width:0;overflow-y:auto;padding:34px 40px;position:relative;z-index:1;}
.psa-settings ::-webkit-scrollbar{width:11px;height:11px;}
.psa-settings ::-webkit-scrollbar-track{background:transparent;}
.psa-settings ::-webkit-scrollbar-thumb{background:var(--line2);border-radius:10px;border:3px solid transparent;background-clip:padding-box;min-height:40px;}
.psa-settings ::-webkit-scrollbar-thumb:hover{background:rgba(76,212,44,.45);background-clip:padding-box;}
.psa-settings ::-webkit-scrollbar-corner{background:transparent;}
.psa-settings{scrollbar-width:thin;scrollbar-color:var(--line2) transparent;}
.psa-close{position:absolute;top:26px;right:28px;width:34px;height:34px;border-radius:9px;border:1px solid var(--line2);color:var(--muted);background:rgba(0,0,0,.2);display:flex;align-items:center;justify-content:center;font-size:14px;cursor:pointer;z-index:2;}
.psa-close:hover{border-color:var(--green-line);color:var(--green-txt);}
.psa-eyebrow{font-family:var(--mono);font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--green-txt);opacity:.8;margin-bottom:8px;}
.psa-h1{font-size:30px;font-weight:600;letter-spacing:-.026em;margin:0;color:#fff;line-height:1;}
.psa-h1 b{color:var(--green);}
.psa-sub{font-size:13px;color:var(--muted);margin:8px 0 26px;}
.psa-settings .psa-stats{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-bottom:26px;}
@media (max-width:1100px){.psa-settings .psa-stats{grid-template-columns:repeat(3,1fr);}}
.psa-settings .tile{position:relative;border:1px solid var(--line);border-radius:14px;background:linear-gradient(180deg,var(--card2),var(--card));padding:16px 16px 18px;overflow:hidden;min-width:0;opacity:0;transform:translateY(10px);animation:psarise .5s cubic-bezier(.2,.8,.2,1) forwards;}
.psa-settings .tile::after{content:"";position:absolute;left:0;right:0;top:0;height:1px;background:linear-gradient(90deg,transparent,var(--green-line),transparent);opacity:.6;}
.psa-settings .tile:nth-child(1){animation-delay:.02s}.psa-settings .tile:nth-child(2){animation-delay:.08s}.psa-settings .tile:nth-child(3){animation-delay:.14s}.psa-settings .tile:nth-child(4){animation-delay:.2s}
.psa-settings .tile .tl{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;}
.psa-settings .tile .lab{font-family:var(--mono);font-size:11px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;color:var(--muted);}
.psa-settings .tile .dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 10px var(--green);flex:0 0 auto;}
.psa-settings .tile .val{font-family:var(--mono);font-size:32px;font-weight:600;letter-spacing:-.03em;color:#fff;line-height:.9;font-variant-numeric:tabular-nums;white-space:nowrap;}
.psa-settings .tile.brand .val{font-size:22px;}
.psa-back{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--green-txt);background:transparent;border:1px solid var(--line2);border-radius:8px;padding:6px 12px;cursor:pointer;margin-bottom:14px;transition:.14s;}
.psa-back:hover{border-color:var(--green-line);background:var(--green-dim);color:#fff;}
.psa-fiche-inline{margin-top:10px;border:1px solid var(--line2);border-radius:14px;background:var(--panel);padding:16px 18px;position:relative;overflow:hidden;}
.psa-detail{margin-top:8px;}
.psa-dt-empty,.psa-dt-muted{font-family:var(--mono);font-size:12px;color:var(--faint);padding:14px 4px;}
.psa-dhead{display:flex;align-items:center;gap:20px;padding:22px 24px;border:1px solid var(--line2);border-radius:16px;background:linear-gradient(120deg,#0e120c,#0b0b0e 55%);position:relative;overflow:hidden;margin-bottom:16px;}
.psa-dhead::before{content:"";position:absolute;inset:0;background:linear-gradient(#4cd42c0d 1px,transparent 1px),linear-gradient(90deg,#4cd42c0d 1px,transparent 1px);background-size:26px 26px;-webkit-mask-image:radial-gradient(140% 100% at 10% 0%,#000 30%,transparent 75%);mask-image:radial-gradient(140% 100% at 10% 0%,#000 30%,transparent 75%);pointer-events:none;}
.psa-dhead>*{position:relative;z-index:1;}
.psa-dav{width:76px;height:76px;border-radius:20px;background:linear-gradient(135deg,var(--green-dim),#0a0a0d);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:30px;color:var(--green);box-shadow:inset 0 0 0 1px #4cd42c33,0 0 22px #4cd42c1f;flex:0 0 auto;position:relative;}
.psa-dav img{width:100%;height:100%;object-fit:cover;border-radius:20px;}
.psa-dav .pr{position:absolute;right:-2px;bottom:-2px;width:20px;height:20px;border-radius:50%;border:4px solid #0b0b0e;box-sizing:border-box;}
.psa-dav .pr.online{background:#3ba55d;}.psa-dav .pr.idle{background:#e0a728;}.psa-dav .pr.dnd{background:#ed4245;}.psa-dav .pr.offline{background:#6a6a75;}
.psa-dhmeta{min-width:0;}
.psa-dname{font-weight:800;font-size:24px;color:#fff;letter-spacing:-.02em;display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.psa-dname .h{font-family:var(--mono);font-size:13px;color:var(--faint);font-weight:600;}
.psa-dmeta{font-family:var(--mono);font-weight:600;font-size:12px;color:var(--faint);margin-top:6px;font-variant-numeric:tabular-nums;letter-spacing:.02em;}
.psa-dmeta .stt.online{color:#3ba55d;}.psa-dmeta .stt.idle{color:#e0a728;}.psa-dmeta .stt.dnd{color:#ed4245;}.psa-dmeta .stt.offline{color:var(--muted);}
.psa-chips{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;}
.psa-chip{display:flex;flex-direction:column;align-items:center;min-width:62px;padding:9px 12px;border:1px solid var(--line);border-radius:11px;background:var(--card);}
.psa-chip .cv{font-family:var(--mono);font-weight:800;font-size:19px;color:#fff;line-height:1;font-variant-numeric:tabular-nums;}
.psa-chip .cl{font-family:var(--mono);font-weight:700;font-size:8.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-top:5px;}
.psa-chip.del .cv{color:#ff7a7a;}.psa-chip.edt .cv{color:#e6ab48;}.psa-chip.med .cv{color:var(--green);}
.psa-dgrid{display:grid;grid-template-columns:1.55fr 1fr;gap:14px;align-items:start;}
@media (max-width:900px){.psa-dgrid{grid-template-columns:1fr;}}
.psa-dcol{display:flex;flex-direction:column;gap:14px;min-width:0;}
.psa-card{border:1px solid var(--line2);border-radius:14px;background:var(--panel);overflow:hidden;}
.psa-chd{display:flex;align-items:center;gap:9px;padding:13px 16px;border-bottom:1px solid var(--line);}
.psa-chd .t{font-family:var(--mono);font-weight:700;font-size:11px;letter-spacing:.13em;text-transform:uppercase;color:var(--green-txt);}
.psa-chd .n{margin-left:auto;font-family:var(--mono);font-weight:600;font-size:10px;color:var(--faint);}
.psa-cbody{padding:14px 16px;max-height:440px;overflow-y:auto;overscroll-behavior:contain;}
.psa-cbody::-webkit-scrollbar{width:8px;}
.psa-cbody::-webkit-scrollbar-thumb{background:var(--line2);border-radius:8px;}
.psa-cbody::-webkit-scrollbar-thumb:hover{background:var(--green-line);}
.psa-cbody::-webkit-scrollbar-track{background:transparent;}
.psa-gal{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:8px;}
.psa-gcell{aspect-ratio:1;border-radius:9px;border:1px solid var(--line2);background:#141419 center/cover no-repeat;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden;cursor:pointer;transition:.14s;}
.psa-gcell:hover{border-color:var(--green-line);transform:translateY(-2px);}
.psa-gcell.vid::after{content:"▶";position:absolute;font-size:16px;color:#fff;text-shadow:0 0 5px #000;}
.psa-gcell .kd{position:absolute;bottom:4px;left:4px;font-family:var(--mono);font-weight:700;font-size:7px;color:#fff;background:rgba(0,0,0,.66);padding:1px 4px;border-radius:3px;text-transform:uppercase;z-index:1;}
.psa-gload{color:var(--faint);font-size:18px;}
.psa-gmedia{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#141419;}
.psa-gcell.fail{background:#141419;}
.psa-noteadd{display:flex;gap:8px;margin-top:8px;}
.psa-noteinp{flex:1;min-width:0;height:36px;border:1px solid var(--line2);border-radius:8px;background:#0b0b0e;color:#fff;padding:0 12px;font-size:13px;outline:none;}
.psa-noteinp:focus{border-color:var(--green-line);}
.psa-notebtn{height:36px;padding:0 15px;border-radius:8px;border:1px solid var(--green-line);background:var(--green-dim);color:var(--green-txt);font-family:var(--mono);font-weight:700;font-size:12px;cursor:pointer;flex:0 0 auto;}
.psa-notebtn:hover{background:var(--green);color:#04120a;}
.psa-card .psa-tl{padding-left:22px;}
.psa-card .psa-acth{margin-top:0;}
.psa-srvgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;}
.psa-srvcard{display:flex;align-items:center;gap:13px;border:1px solid var(--line2);border-radius:13px;background:var(--panel);padding:13px 15px;cursor:pointer;transition:.15s;}
.psa-srvcard:hover{border-color:var(--green-line);transform:translateY(-2px);box-shadow:0 10px 30px -18px var(--green);}
.psa-srvic{width:46px;height:46px;border-radius:14px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-weight:800;font-size:15px;color:#fff;position:relative;}
.psa-srvic-dot{position:absolute;right:-2px;bottom:-2px;width:13px;height:13px;border-radius:50%;background:#ff5c5c;border:2.5px solid var(--panel);box-shadow:0 0 8px rgba(255,92,92,.6);}
.psa-srvcard-m{flex:1;min-width:0;}
.psa-srvcard-n{font-weight:700;font-size:14.5px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.psa-srvcard-s{font-family:var(--mono);font-weight:600;font-size:10.5px;color:var(--faint);margin-top:3px;}
.psa-srvcard-c{text-align:right;flex:0 0 auto;}
.psa-srvcard-c .n{font-family:var(--mono);font-weight:800;font-size:20px;color:#ff7a7a;line-height:1;font-variant-numeric:tabular-nums;}
.psa-srvcard-c .x{font-family:var(--mono);font-weight:700;font-size:8px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-top:4px;}
.psa-shic{width:60px;height:60px;border-radius:18px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-weight:800;font-size:22px;color:#fff;background-position:center;}
.psa-srv-tb{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;}
.psa-srv-search{flex:1;min-width:180px;height:36px;border:1px solid var(--line2);border-radius:9px;background:#0b0b0e;color:#fff;padding:0 12px;font-family:var(--mono);font-size:13px;outline:none;}
.psa-srv-search:focus{border-color:var(--green-line);}
.psa-srv-feed{border:1px solid var(--line2);border-radius:14px;background:var(--panel);overflow:hidden;}
.psa-srv-day{font-family:var(--mono);font-weight:700;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);padding:12px 18px 6px;}
.psa-srvm{display:flex;gap:12px;padding:11px 18px;border-top:1px solid var(--line);position:relative;}
.psa-srvm:hover{background:rgba(255,255,255,.015);}
.psa-srvm::before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;background:#ff5c5c;opacity:.55;}
.psa-srvm-av{width:38px;height:38px;border-radius:50%;flex:0 0 auto;display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff;font-size:14px;background:linear-gradient(135deg,#1c1c22,#0b0b0e);overflow:hidden;}
.psa-srvm-av img{width:100%;height:100%;object-fit:cover;}
.psa-srvm-body{flex:1;min-width:0;}
.psa-srvm-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.psa-srvm-name{font-weight:700;font-size:13.5px;color:#fff;}
.psa-srvm-handle{font-family:var(--mono);font-weight:600;font-size:10px;color:var(--faint);font-variant-numeric:tabular-nums;}
.psa-srvm-chan{font-family:var(--mono);font-weight:600;font-size:10.5px;color:var(--green-txt);}
.psa-srvm-chan .h{color:var(--faint);}
.psa-srvm-when{margin-left:auto;font-family:var(--mono);font-weight:600;font-size:10px;color:var(--faint);font-variant-numeric:tabular-nums;}
.psa-srvm-text{font-size:13.5px;color:#d78f8f;line-height:1.45;margin-top:5px;text-decoration:line-through;text-decoration-color:rgba(255,92,92,.4);white-space:pre-wrap;word-break:break-word;}
.psa-filt{height:36px;display:flex;align-items:center;gap:6px;padding:0 13px;border:1px solid var(--line2);border-radius:9px;font-family:var(--mono);font-weight:600;font-size:11px;color:var(--muted);background:#0b0b0e;cursor:pointer;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;transition:.14s;}
.psa-filt:hover{border-color:var(--green-line);color:var(--green-txt);}
.psa-filt.on{border-color:var(--green-line);color:var(--green-txt);background:var(--green-dim);}
.psa-galgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(158px,1fr));gap:10px;}
.psa-galcell{position:relative;aspect-ratio:1;border-radius:12px;overflow:hidden;border:1px solid var(--line2);background:#141419;cursor:pointer;transition:.15s;}
.psa-galcell:hover{border-color:var(--green-line);transform:translateY(-3px);box-shadow:0 14px 34px -20px var(--green);}
.psa-galcell::before{content:"";position:absolute;left:0;right:0;bottom:0;height:62%;background:linear-gradient(transparent,rgba(0,0,0,.85));z-index:1;pointer-events:none;}
.psa-galcell::after{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:#ff5c5c;opacity:.7;z-index:2;}
.psa-galmedia{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#141419;}
.psa-galload{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--faint);font-size:20px;}
.psa-galtag{position:absolute;top:8px;left:8px;z-index:3;font-family:var(--mono);font-weight:700;font-size:8px;letter-spacing:.1em;text-transform:uppercase;color:#fff;background:rgba(255,92,92,.85);padding:2px 6px;border-radius:5px;}
.psa-galgif{position:absolute;top:8px;left:8px;z-index:3;font-family:var(--mono);font-weight:700;font-size:8px;letter-spacing:.08em;text-transform:uppercase;color:#04120a;background:var(--green);padding:2px 6px;border-radius:5px;}
.psa-galsub .pid{color:#9aa2ad;}
.psa-pager{display:flex;align-items:center;justify-content:center;gap:6px;margin-top:22px;flex-wrap:wrap;}
.psa-pbtn{min-width:34px;height:34px;padding:0 10px;border:1px solid var(--line2);border-radius:9px;background:#0b0b0e;color:var(--muted);font-family:var(--mono);font-weight:700;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:.14s;font-variant-numeric:tabular-nums;}
.psa-pbtn:hover{border-color:var(--green-line);color:var(--green-txt);}
.psa-pbtn.on{background:var(--green);color:#04120a;border-color:transparent;}
.psa-pbtn.arrow{color:#fff;}
.psa-pbtn.dis{opacity:.35;cursor:default;pointer-events:none;}
.psa-pdots{color:var(--faint);font-family:var(--mono);font-weight:700;font-size:12px;padding:0 3px;}
.psa-pcount{text-align:center;margin-top:12px;font-family:var(--mono);font-weight:600;font-size:10px;color:var(--faint);text-transform:uppercase;letter-spacing:.06em;}
.psa-pcount b{color:var(--green-txt);}
.psa-galkd{position:absolute;bottom:8px;right:8px;z-index:3;font-family:var(--mono);font-weight:700;font-size:8px;color:#fff;background:rgba(0,0,0,.6);padding:2px 5px;border-radius:4px;text-transform:uppercase;}
.psa-galdel{position:absolute;top:7px;right:7px;z-index:4;width:22px;height:22px;border-radius:7px;border:none;background:rgba(0,0,0,.55);color:#fff;font-size:11px;cursor:pointer;opacity:0;transition:.14s;display:flex;align-items:center;justify-content:center;padding:0;}
.psa-galcell:hover .psa-galdel{opacity:1;}
.psa-galdel:hover{background:#ff5c5c;color:#fff;box-shadow:0 0 10px rgba(255,92,92,.5);}
.psa-srv-delbtn{height:36px;padding:0 13px;border-radius:9px;border:1px solid var(--line2);background:rgba(255,92,92,.08);color:#ff7a7a;font-family:var(--mono);font-weight:700;font-size:11px;letter-spacing:.04em;text-transform:uppercase;cursor:pointer;white-space:nowrap;transition:.14s;}
.psa-srv-delbtn:hover{background:#ff5c5c;color:#fff;border-color:transparent;}
.psa-galplay{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:3;font-size:26px;color:#fff;text-shadow:0 0 10px #000;opacity:.92;}
.psa-galmeta{position:absolute;left:9px;right:9px;bottom:8px;z-index:3;}
.psa-galwho{display:flex;align-items:center;gap:7px;}
.psa-galav{width:22px;height:22px;border-radius:50%;flex:0 0 auto;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:10px;color:#fff;background:linear-gradient(135deg,#1c1c22,#0b0b0e);overflow:hidden;}
.psa-galav img{width:100%;height:100%;object-fit:cover;}
.psa-galnm{font-weight:700;font-size:12px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 3px #000;}
.psa-galsub{display:flex;align-items:center;gap:6px;margin-top:4px;font-family:var(--mono);font-weight:600;font-size:9.5px;color:#cfcfd6;text-shadow:0 1px 2px #000;}
.psa-galsub .ch{color:var(--green-txt);}.psa-galsub .dot{width:2px;height:2px;border-radius:50%;background:#888;flex:0 0 auto;}
.psa-lb{position:fixed;inset:0;z-index:100001;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.86);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);cursor:zoom-out;}
.psa-lb-stage{position:relative;max-width:88vw;max-height:86vh;display:flex;flex-direction:column;align-items:center;cursor:default;}
.psa-lb-media{max-width:88vw;max-height:78vh;border-radius:12px;border:1px solid var(--line2);box-shadow:0 30px 90px rgba(0,0,0,.6),0 0 60px rgba(76,212,44,.06);object-fit:contain;background:#0b0b0e;}
.psa-lb-info{display:flex;align-items:center;gap:12px;margin-top:12px;font-family:var(--mono);font-size:11px;color:var(--muted);flex-wrap:wrap;justify-content:center;max-width:80vw;}
.psa-lb-info .nm{color:#fff;font-weight:700;}.psa-lb-info .ch{color:var(--green-txt);}.psa-lb-info .tm{color:var(--faint);}
.psa-lb-info .tx{color:#d78f8f;text-decoration:line-through;text-decoration-color:rgba(255,92,92,.4);}
.psa-lb-info .cnt{color:var(--faint);font-variant-numeric:tabular-nums;}
.psa-lb-x{position:fixed;top:20px;right:24px;z-index:2;width:40px;height:40px;border-radius:10px;border:1px solid var(--line2);background:rgba(0,0,0,.4);color:#fff;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;}
.psa-lb-x:hover{border-color:var(--green-line);color:var(--green-txt);}
.psa-lb-nav{position:fixed;top:50%;transform:translateY(-50%);z-index:2;width:48px;height:48px;border-radius:50%;border:1px solid var(--line2);background:rgba(0,0,0,.4);color:#fff;font-size:24px;cursor:pointer;display:flex;align-items:center;justify-content:center;}
.psa-lb-nav:hover{border-color:var(--green-line);color:var(--green-txt);}
.psa-lb-nav.l{left:24px;}.psa-lb-nav.r{right:24px;}
.psa-settings .tile .cap{font-size:11px;color:var(--faint);margin-top:8px;}
.psa-panel{border:1px solid var(--line);border-radius:16px;background:linear-gradient(180deg,rgba(255,255,255,.012),transparent),var(--panel);padding:4px 4px 8px;opacity:0;transform:translateY(10px);animation:psarise .5s .26s cubic-bezier(.2,.8,.2,1) forwards;}
.psa-phead{display:flex;justify-content:space-between;align-items:center;padding:16px 18px 12px;gap:12px;flex-wrap:wrap;}
.psa-pt{font-family:var(--mono);font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:var(--text);}
.psa-ps{font-family:var(--mono);font-size:12px;letter-spacing:.1em;color:var(--green-txt);text-transform:uppercase;}
.psa-fld{display:flex;gap:8px;}
.psa-fs{height:34px;width:200px;max-width:40vw;border:1px solid var(--line);border-radius:9px;background:#0b0b0e;color:var(--text);padding:0 12px;font-size:12px;font-family:var(--mono);outline:none;}
.psa-fs::placeholder{color:var(--faint);}
.psa-sort{height:34px;display:flex;align-items:center;gap:6px;padding:0 12px;border:1px solid var(--line);border-radius:9px;font-family:var(--mono);font-size:11px;letter-spacing:.08em;color:var(--muted);background:#0b0b0e;cursor:pointer;white-space:nowrap;text-transform:uppercase;}
.psa-sort b{color:var(--green-txt);}
.psa-twrap{overflow-x:auto;padding:0 4px;}
.psa-settings table{width:100%;border-collapse:collapse;table-layout:fixed;}
.psa-settings col.c1{width:38%;}.psa-settings col.c2{width:9%;}.psa-settings col.c3{width:9%;}.psa-settings col.c4{width:12%;}.psa-settings col.c5{width:18%;}.psa-settings col.c6{width:14%;}
.psa-settings thead th{text-align:left;font-family:var(--mono);font-size:11px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--faint);padding:6px 12px 12px;border-bottom:1px solid var(--line);white-space:nowrap;}
.psa-settings thead th.r{text-align:right;}
.psa-settings tbody td{padding:13px 12px;border-bottom:1px solid rgba(255,255,255,.04);font-size:14px;vertical-align:middle;white-space:nowrap;overflow:hidden;}
.psa-settings tbody tr{transition:.14s;}
.psa-settings tbody tr:hover{background:linear-gradient(90deg,var(--green-dim),transparent 40%);}
.psa-settings tbody tr:hover td:first-child{box-shadow:inset 3px 0 0 var(--green);}
.psa-settings tbody tr:last-child td{border-bottom:none;}
.psa-settings .who{display:flex;align-items:center;gap:13px;min-width:0;}
.psa-settings .who .av{width:38px;height:38px;border-radius:10px;background:#0c0c0f;border:1px solid var(--line2);display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-weight:700;color:var(--green-txt);overflow:hidden;flex:0 0 auto;}
.psa-settings .who .av img{width:100%;height:100%;object-fit:cover;border-radius:10px;}
.psa-settings .who .av{position:relative;overflow:visible;}
.psa-settings .rpres{position:absolute;right:-3px;bottom:-3px;width:13px;height:13px;border-radius:50%;border:2.5px solid var(--panel);box-sizing:border-box;}
.psa-settings .rpres.online{background:#3ba55d;}
.psa-settings .rpres.idle{background:#e0a728;}
.psa-settings .rpres.dnd{background:#ed4245;}
.psa-settings .rpres.offline{background:#6a6a75;}
.psa-settings .idchip{margin-left:7px;font-family:var(--mono);font-weight:700;font-size:9px;letter-spacing:.04em;color:var(--green);background:var(--green-dim);padding:1px 5px;border-radius:5px;vertical-align:middle;}
.psa-settings .cnt{font-weight:700;font-variant-numeric:tabular-nums;}
.psa-settings .cnt.del{color:#ff7a7a;}
.psa-settings .cnt.edt{color:#e6ab48;}
.psa-settings table{min-width:720px;}
.psa-settings .who .m{min-width:0;}
.psa-settings .who .n{font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.psa-settings .who .id{font-family:var(--mono);font-size:12px;color:var(--faint);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.psa-settings .num{font-family:var(--mono);font-size:14px;font-variant-numeric:tabular-nums;letter-spacing:-.01em;}
.psa-settings .dim{color:var(--muted);}
.psa-settings .pill{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:7px;font-family:var(--mono);font-size:11px;letter-spacing:.04em;font-weight:600;border:1px solid transparent;white-space:nowrap;text-transform:uppercase;}
.psa-settings .pill.g{background:var(--green-dim);color:var(--green-txt);border-color:var(--green-line);}
.psa-settings .pill .d{width:6px;height:6px;border-radius:50%;background:var(--green);box-shadow:0 0 8px var(--green);flex:0 0 auto;}
.psa-settings .pill.a{background:var(--amberbg);color:var(--ambertx);border-color:rgba(224,168,74,.3);}
.psa-settings .acts{display:flex;gap:7px;justify-content:flex-end;}
.psa-settings .ibtn{width:32px;height:32px;border-radius:8px;border:1px solid var(--line2);background:transparent;color:var(--muted);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:13px;transition:.14s;}
.psa-settings .ibtn:hover{border-color:var(--green-line);color:var(--green-txt);}
.psa-settings .ibtn.del:hover{border-color:var(--redtx);color:var(--redtx);background:var(--redbg);}
.psa-settings .empty{text-align:center;color:var(--muted);padding:34px 0;font-size:14px;font-family:var(--mono);}
.psa-settings .psa-dbtn{height:38px;padding:0 16px;border-radius:9px;border:1px solid var(--green-line);background:var(--green-dim);color:var(--green-txt);font-family:var(--mono);font-size:12px;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;display:inline-flex;align-items:center;gap:6px;}
.psa-settings .psa-dbtn:hover{background:var(--green);color:#04120a;}
.psa-settings .psa-about{font-size:13px;color:var(--muted);line-height:1.8;font-family:var(--mono);}
@keyframes psarise{to{opacity:1;transform:none;}}

/* ============================ Apple redesign (green kept) ============================ */
.psa-app,.psa-fiche,.psa-settings{--bg:#060607;--card:#151517;--card2:#191a1d;--panel:#151517;--side:#0d0d0f;--line:rgba(255,255,255,.08);--line2:rgba(255,255,255,.13);--text:#f5f5f7;--muted:#a1a1a6;--faint:#6e6e73;--green:#4cd42c;--green-txt:#8ff07a;--green-dim:rgba(76,212,44,.14);--green-line:rgba(76,212,44,.34);--redbg:rgba(255,69,58,.16);--redtx:#ff8a80;--amberbg:rgba(255,176,42,.16);--ambertx:#ffb02a;--mono:"JetBrains Mono",ui-monospace,"SF Mono",Menlo,monospace;font-family:"Inter",-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;}
.psa-mi{font-family:"Material Symbols Outlined";font-weight:400;font-style:normal;font-size:20px;line-height:1;letter-spacing:normal;text-transform:none;white-space:nowrap;-webkit-font-feature-settings:'liga';font-feature-settings:'liga';-webkit-font-smoothing:antialiased;}
.psa-settings .tile .dot{display:none;}
.psa-sitem-ic{opacity:1;color:var(--faint);width:22px;font-size:20px;}
.psa-sitem.on .psa-sitem-ic{color:var(--green);}
.psa-bt{font-family:"Inter",-apple-system,"Segoe UI",sans-serif;font-style:italic;font-weight:800;font-size:19px;letter-spacing:-.03em;color:#fff;}
.psa-settings .tile .lab,.psa-settings .tile .cap{font-family:"Inter",-apple-system,"Segoe UI",sans-serif;text-transform:none;letter-spacing:0;}
.psa-settings .tile .lab{font-size:12px;color:var(--faint);font-weight:500;}
.psa-settings .tile .val{font-family:"Inter",-apple-system,"Segoe UI",sans-serif;font-weight:700;font-size:28px;letter-spacing:-.03em;}
.psa-app{--pink:#4cd42c;--pinkbg:rgba(76,212,44,.14);--pinktx:#8ff07a;background:var(--bg);}
.psa-settings::before,.psa-fiche::before,.psa-dhead::before,.psa-settings .tile::after{display:none!important;}
.psa-settings .psa-panel,.psa-card,.psa-app .panel,.psa-fiche-inline,.psa-srv-feed{border-radius:18px;box-shadow:0 14px 34px -26px rgba(0,0,0,.95);}
.psa-settings .tile,.psa-app .stat{background:var(--card);border-radius:16px;box-shadow:0 12px 28px -24px rgba(0,0,0,.95);}
.psa-chip{background:var(--card);border-radius:12px;}
.psa-panel{background:var(--panel);}
.psa-dhead{background:var(--card);border-radius:20px;box-shadow:0 16px 40px -28px rgba(0,0,0,.95);}
.psa-h1{font-size:32px;font-weight:700;letter-spacing:-.035em;}
.psa-dname{font-weight:700;letter-spacing:-.03em;}
.psa-fname{letter-spacing:-.02em;}
.psa-sitem{border-radius:12px;}
.psa-sitem.on{background:var(--green-dim);color:#eafce4;border:1px solid var(--green-line);}
.psa-sitem.on::before{display:none;}
.psa-logo{border-radius:13px;}
.psa-switch{width:44px;height:26px;border-radius:999px;background:rgba(255,255,255,.14);border:none;}
.psa-switch .knob{width:20px;height:20px;top:3px;left:3px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.45);}
.psa-switch.on{background:var(--green);border:none;}
.psa-switch.on .knob{left:21px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.45);}
.psa-btn,.psa-dbtn,.psa-filt,.psa-srv-delbtn,.psa-back,.psa-notebtn,.psa-sort,.psa-fs,.psa-side-search,.psa-srv-search,.psa-input,.psa-noteinp,.psa-app .sort,.psa-app .tsearch,.psa-app .ibtn,.psa-close{border-radius:11px;}
.psa-pbtn{border-radius:10px;}
.psa-galcell{border-radius:16px;}
.psa-gcell{border-radius:12px;}
.psa-galcell:hover{transform:translateY(-4px);box-shadow:0 22px 44px -26px rgba(0,0,0,.95),0 0 0 1px var(--green-line);}
.psa-srvcard{border-radius:16px;}
.bd-modal-root:has(.psa-fiche){background:#060607!important;}
/* ── psa.sec — section Comptes (vault de tokens) ── */
.psa-sec-unlock{max-width:420px;margin:24px auto;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:30px 26px;display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center;background-image:radial-gradient(500px 300px at 50% -10%,var(--green-dim),transparent 60%);}
.psa-sec-ut{font-style:italic;font-weight:800;font-size:28px;letter-spacing:-.03em;margin-top:6px;color:var(--text);}
.psa-sec-ut span{color:var(--green);}
.psa-sec-utag{font-family:var(--mono);font-size:9.5px;letter-spacing:.28em;text-transform:uppercase;color:var(--green-txt);}
.psa-sec-usub{font-size:12.5px;color:var(--muted);margin:10px 0 6px;line-height:1.5;}
.psa-sec-uin{width:100%;height:42px;border-radius:11px;border:1px solid var(--line2);background:#0d0d10;color:var(--text);padding:0 14px;font-size:14px;outline:none;font-family:var(--mono);}
.psa-sec-uin:focus{border-color:var(--green-line);}
.psa-sec-ubtn{width:100%;justify-content:center;margin-top:10px;height:42px;}
.psa-sec-uerr{color:var(--redtx);font-size:12px;min-height:16px;}
.psa-sec-addbar{display:flex;gap:10px;align-items:flex-start;background:var(--card);border:1px solid var(--line);border-radius:13px;padding:8px 8px 8px 14px;margin:16px 0;}
.psa-sec-addbar>span{color:var(--faint);margin-top:8px;}
.psa-sec-tokin{flex:1;min-height:38px;max-height:170px;resize:vertical;line-height:1.5;padding:9px 12px;border-radius:11px;border:1px solid var(--line2);background:#0d0d10;color:var(--text);font-size:14px;outline:none;font-family:var(--mono);-webkit-text-security:disc;white-space:pre;overflow:auto;}
.psa-sec-tokin:focus{border-color:var(--green-line);}
.psa-sec-addbtn{margin-top:0;flex:0 0 auto;}
.psa-sec-tools{display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;}
.psa-sec-tools .psa-btn.danger{border-color:rgba(255,69,58,.3);color:var(--redtx);}
.psa-sec-tools .psa-btn.danger:hover{background:var(--redbg);}
.psa-sec-list{display:flex;flex-direction:column;gap:10px;}
.psa-sec-empty{color:var(--faint);font-family:var(--mono);font-size:13px;padding:24px;text-align:center;border:1px dashed var(--line2);border-radius:14px;}
.psa-sec-acc{display:flex;align-items:center;gap:14px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:12px 15px;transition:.14s;}
.psa-sec-acc:hover{border-color:var(--green-line);transform:translateY(-2px);}
.psa-sec-acc.active{border-color:var(--green-line);box-shadow:0 0 0 1px var(--green-line);background:linear-gradient(90deg,var(--green-dim),var(--card) 40%);}
.psa-sec-acc.dead{opacity:.5;}
.psa-sec-acc.dead:hover{border-color:var(--line);transform:none;box-shadow:none;}
.psa-sec-av{width:46px;height:46px;border-radius:50%;background-size:cover;background-position:center;flex:0 0 auto;border:1px solid var(--line);position:relative;}
.psa-sec-pr{position:absolute;right:-1px;bottom:-1px;width:14px;height:14px;border-radius:50%;border:3px solid #0c0c0e;box-sizing:border-box;}
.psa-sec-pr.online{background:#3ba55d;}.psa-sec-pr.off{background:#5a5a63;}
.psa-sec-am{flex:1;min-width:0;}
.psa-sec-an{font-weight:700;font-size:15px;color:var(--text);display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.psa-sec-an .h{font-family:var(--mono);font-size:12px;color:var(--faint);font-weight:500;}
.psa-sec-badge{font-family:var(--mono);font-weight:700;font-size:8.5px;letter-spacing:.12em;text-transform:uppercase;padding:2px 7px;border-radius:6px;background:var(--green);color:#04120a;}
.psa-sec-as{display:flex;align-items:center;gap:8px;margin-top:5px;font-family:var(--mono);font-size:11px;color:var(--faint);flex-wrap:wrap;}
.psa-sec-tok{background:rgba(0,0,0,.3);padding:2px 7px;border-radius:6px;border:1px solid var(--line);color:var(--muted);}
.psa-sec-aa{display:flex;gap:8px;flex:0 0 auto;align-items:center;}
.psa-sec-cbtn{height:38px;display:inline-flex;align-items:center;gap:6px;padding:0 15px;border-radius:11px;border:1px solid var(--line2);background:var(--card2);color:var(--text);font-size:13.5px;font-weight:600;cursor:pointer;white-space:nowrap;}
.psa-sec-cbtn:hover{background:rgba(255,255,255,.09);}
.psa-sec-cbtn.primary{background:var(--green);border-color:transparent;color:#04120a;}
.psa-sec-cbtn.primary:hover{background:#3cc01f;}
.psa-sec-cbtn.ghost{background:transparent;opacity:.55;cursor:default;}
.psa-sec-cbtn:disabled{opacity:.5;cursor:default;}
.psa-sec-icon{width:38px;height:38px;border-radius:11px;border:1px solid var(--line2);background:transparent;color:var(--muted);cursor:pointer;font-size:14px;}
.psa-sec-icon.del:hover{background:var(--redbg);color:var(--redtx);border-color:rgba(255,69,58,.3);}
.psa-sec-note{display:flex;align-items:center;gap:9px;font-size:12px;color:var(--faint);font-family:var(--mono);margin-top:16px;}
.psa-sec-note b{color:var(--green-txt);}
`;
    }

    avatarUrl(userId) {
        try {
            const u = BdApi.Webpack.getStore("UserStore").getUser(userId);
            if (u && typeof u.getAvatarURL === "function") return u.getAvatarURL(null, 64);
        } catch (e) { /* ignore */ }
        return null;
    }

    getSettingsPanel() {
        return BdApi.React.createElement(this.dashboardComponent(true));
    }

    openBigModal(contentEl, fallbackTitle) {
        const React = BdApi.React;
        try {
            const Actions = BdApi.Webpack.getByKeys("openModal", "closeModal") || BdApi.Webpack.getByKeys("openModalLazy", "openModal");
            const Modal = BdApi.Webpack.getByKeys("ModalRoot", "ModalSize")
                || BdApi.Webpack.getByKeys("ModalRoot", "ModalCloseButton")
                || BdApi.Webpack.getByKeys("ModalRoot", "ModalHeader")
                || BdApi.Webpack.getModule(m => m && m.ModalRoot && m.ModalSize);
            if (Actions && Actions.openModal && Modal && Modal.ModalRoot) {
                const size = (Modal.ModalSize && (Modal.ModalSize.DYNAMIC || Modal.ModalSize.LARGE || Modal.ModalSize.large)) || "large";
                const body = Modal.ModalContent
                    ? React.createElement(Modal.ModalContent, { className: "psa-modal-wrap" }, contentEl)
                    : React.createElement("div", { className: "psa-modal-wrap" }, contentEl);
                Actions.openModal(props => React.createElement(Modal.ModalRoot, Object.assign({ size, className: "psa-modal-root" }, props), body));
                return;
            }
        } catch (e) { /* fallback below */ }
        BdApi.UI.showConfirmationModal(fallbackTitle || "psa", React.createElement("div", { className: "psa-modal-wrap" }, contentEl), { confirmText: "Close", cancelText: null });
    }

    openDashboard() {
        this.openBigModal(BdApi.React.createElement(this.dashboardComponent(true)), "📊 psa dashboard");
    }

    copyText(txt) {
        try { require("electron").clipboard.writeText(txt); return true; } catch (e) { /* next */ }
        try { DiscordNative.clipboard.copy(txt); return true; } catch (e) { /* next */ }
        try { navigator.clipboard.writeText(txt); return true; } catch (e) { /* next */ }
        return false;
    }

    readText() {
        try { return require("electron").clipboard.readText(); } catch (e) { /* next */ }
        try { return DiscordNative.clipboard.read(); } catch (e) { /* next */ }
        return "";
    }

    humanBytes(n) {
        if (n < 1024) return n + " B";
        if (n < 1048576) return Math.round(n / 1024) + " KB";
        const mb = n / 1048576;
        return (mb >= 10 ? Math.round(mb) : mb.toFixed(1)) + " MB";
    }

    sig() {
        const h = BdApi.React.createElement;
        const line = (k, a, b, c, d) => h("line", { key: k, x1: a, y1: b, x2: c, y2: d });
        const mol = h("svg", { key: "mol", className: "psa-mol", width: 66, height: 46, viewBox: "0 0 66 46" }, [
            line("l1", 10, 23, 24, 12), line("l2", 24, 12, 40, 16), line("l3", 40, 16, 48, 30),
            line("l4", 48, 30, 38, 40), line("l5", 38, 40, 22, 36), line("l6", 22, 36, 10, 23),
            line("l7", 48, 30, 60, 34),
            h("circle", { key: "c1", cx: 10, cy: 23, r: 3.4 }), h("circle", { key: "c2", cx: 40, cy: 16, r: 3.4 }), h("circle", { key: "c3", cx: 60, cy: 34, r: 3 })
        ]);
        const s = (k, t) => h("span", { key: k, className: "s" }, t);
        const b = (k, t) => h("b", { key: k }, t);
        const formula = h("span", { key: "f", className: "psa-formula" }, [b("b1", "C"), s("s1", "17"), b("b2", "H"), s("s2", "19"), b("b3", "NO"), s("s3", "3")]);
        const name = h("div", { key: "nm", className: "psa-sig-name" }, [
            h("span", { key: "n", className: "n" }, "psa"),
            formula
        ]);
        return h("div", { className: "psa-sig" }, [mol, name]);
    }

    diskUsage() {
        const fs = require("fs");
        const path = require("path");
        const sizeOf = (dir) => {
            let total = 0, entries;
            try { entries = fs.readdirSync(dir); } catch (e) { return 0; }
            for (const f of entries) {
                const p = path.join(dir, f);
                try { const st = fs.statSync(p); total += st.isDirectory() ? sizeOf(p) : st.size; } catch (e) { /* skip */ }
            }
            return total;
        };
        try { return sizeOf(this.blobsRoot()) + sizeOf(this.mediaRoot()) + sizeOf(this.pfpDir()) + sizeOf(this.serversRoot()); }
        catch (e) { return 0; }
    }

    treeDump(root, maxDepth) {
        const out = [];
        const walk = (el, d) => {
            const r = el.getBoundingClientRect();
            const role = el.getAttribute ? el.getAttribute("role") : null;
            const leaf = el.children.length === 0 && el.textContent ? " \"" + el.textContent.trim().slice(0, 34) + "\"" : "";
            out.push("  ".repeat(d) + el.tagName + "." + ([].slice.call(el.classList).join(".") || "-") + (role ? "[role=" + role + "]" : "") + " [" + Math.round(r.width) + "x" + Math.round(r.height) + "]" + leaf);
            if (d < maxDepth) [].slice.call(el.children).forEach(c => walk(c, d + 1));
        };
        walk(root, 0);
        return out.join("\n");
    }

    maybeDumpProfile() {
        try {
            if (this._profDumped) return;
            let tl = null;
            const lists = document.querySelectorAll('[role="tablist"]');
            for (const l of lists) {
                if (/Activity|Mutual|Activité|Serveurs|amis|friends|servers/i.test(l.textContent || "")) { tl = l; break; }
            }
            if (!tl) return;
            this._profDumped = true;
            let root = tl;
            for (let i = 0; i < 6 && root.parentElement; i++) root = root.parentElement;
            const info = "TABLIST class: " + tl.className + "\nTABLIST children: " + [].slice.call(tl.children).map(c => c.tagName + "." + c.className + " \"" + (c.textContent || "").trim().slice(0, 20) + "\"").join(" | ") + "\n\n" + this.treeDump(root, 8);
            require("fs").writeFileSync(require("path").join(this.mediaRoot(), "..", "psa-dbg-profile.txt"), info);
        } catch (e) { /* ignore */ }
    }

    dumpLayout(rootClass, outName) {
        try {
            const root = document.querySelector("." + rootClass);
            if (!root) return;
            const out = ["=== psa layout dump: ." + rootClass + " @ " + new Date().toISOString() + " ==="];
            let anc = root, chain = [];
            for (let i = 0; i < 5 && anc; i++) { const r = anc.getBoundingClientRect(); chain.push(anc.tagName + "." + ([].slice.call(anc.classList).join(".") || "-") + " " + Math.round(r.width) + "x" + Math.round(r.height)); anc = anc.parentElement; }
            out.push("ANCESTORS: " + chain.join(" < "));
            const walk = (el, d) => {
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                out.push("  ".repeat(d) + el.tagName + "." + ([].slice.call(el.classList).join(".") || "-") + " [" + Math.round(r.x) + "," + Math.round(r.y) + " " + Math.round(r.width) + "x" + Math.round(r.height) + "] disp=" + cs.display + " pos=" + cs.position + " fd=" + cs.flexDirection + " ov=" + cs.overflow);
                if (d < 5) [].slice.call(el.children).forEach(c => walk(c, d + 1));
            };
            walk(root, 0);
            require("fs").writeFileSync(require("path").join(this.mediaRoot(), "..", "psa-dbg-" + outName + ".txt"), out.join("\n"));
        } catch (e) { /* ignore */ }
    }

    getIndex() {
        try {
            const fs = require("fs");
            const path = require("path");
            const root = this.mediaRoot();
            return fs.readdirSync(root).filter(d => {
                try { return fs.statSync(path.join(root, d)).isDirectory() && fs.existsSync(path.join(root, d, "fiche.json")); }
                catch (e) { return false; }
            });
        } catch (e) { return []; }
    }

    getFiche(userId) {
        try {
            const fs = require("fs");
            const p = this.fichePath(userId);
            if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
        } catch (e) { /* fallback */ }
        return BdApi.Data.load("psa", String(userId)) || null;
    }

    bump() { this._rev = (this._rev || 0) + 1; }

    saveFiche(fiche) {
        fiche.updatedAt = Date.now();
        try {
            const fs = require("fs");
            const p = this.fichePath(fiche.userId);
            fs.mkdirSync(require("path").dirname(p), { recursive: true });
            fs.writeFileSync(p, JSON.stringify(fiche, null, 2));
        } catch (e) {
            BdApi.Data.save("psa", fiche.userId, fiche);
        }
        this._tracked = null;
        this.bump();
    }

    deleteFiche(userId) {
        this._tracked = null;
        try { require("fs").rmSync(this.userDir(userId), { recursive: true, force: true }); } catch (e) { /* ignore */ }
        try { BdApi.Data.delete("psa", String(userId)); } catch (e) { /* ignore */ }
        this.bump();
    }

    blankFiche(userId, username) {
        return { userId, username, aliases: [], notes: [], media: [], events: [], updatedAt: Date.now() };
    }

    serversRoot() {
        const dir = require("path").join(this.baseDir(), "servers");
        try { require("fs").mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
        return dir;
    }

    serverDir(gid) {
        return require("path").join(this.serversRoot(), String(gid));
    }

    serverPath(gid) {
        return require("path").join(this.serverDir(gid), "server.json");
    }

    getServer(gid) {
        try {
            const fs = require("fs");
            const p = this.serverPath(gid);
            if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
        } catch (e) { /* ignore */ }
        return null;
    }

    saveServer(s) {
        s.updatedAt = Date.now();
        try {
            const fs = require("fs");
            const p = this.serverPath(s.guildId);
            fs.mkdirSync(require("path").dirname(p), { recursive: true });
            fs.writeFileSync(p, JSON.stringify(s, null, 2));
        } catch (e) { /* ignore */ }
        this.bump();
    }

    deleteServer(gid) {
        try { require("fs").rmSync(this.serverDir(gid), { recursive: true, force: true }); } catch (e) { /* ignore */ }
        this.bump();
    }

    deleteServerMedia(gid, evId, mediaId) {
        const s = this.getServer(gid);
        if (!s || !Array.isArray(s.events)) return;
        const ev = s.events.find(e => e.id === evId);
        if (!ev || !Array.isArray(ev.media)) return;
        const m = ev.media.find(x => x.id === mediaId);
        if (m && m.file && !m.hash) { try { require("fs").unlinkSync(require("path").join(this.serverDir(gid), m.file)); } catch (e) { /* ignore */ } }
        ev.media = ev.media.filter(x => x.id !== mediaId);
        if (!ev.media.length) s.events = s.events.filter(e => e.id !== evId);
        this.saveServer(s);
    }

    getServerIndex() {
        try {
            const fs = require("fs");
            const path = require("path");
            const root = this.serversRoot();
            return fs.readdirSync(root).filter(d => {
                try { return fs.statSync(path.join(root, d)).isDirectory() && fs.existsSync(path.join(root, d, "server.json")); }
                catch (e) { return false; }
            });
        } catch (e) { return []; }
    }

    guildInfo(gid) {
        try {
            const GS = BdApi.Webpack.getStore("GuildStore");
            const g = GS && GS.getGuild(gid);
            if (g) {
                const icon = g.icon ? ("https://cdn.discordapp.com/icons/" + gid + "/" + g.icon + (String(g.icon).startsWith("a_") ? ".gif" : ".png") + "?size=64") : null;
                return { name: g.name || String(gid), icon: icon };
            }
        } catch (e) { /* ignore */ }
        return { name: String(gid), icon: null };
    }

    serverImageSources(message) {
        return this.pickSources(message).filter(s => s.kind === "image" || s.kind === "video");
    }

    logServerDelete(rec) {
        const gid = String(rec.guildId);
        let s = this.getServer(gid);
        const gi = this.guildInfo(gid);
        if (!s) s = { guildId: gid, name: gi.name, icon: gi.icon, events: [], updatedAt: Date.now() };
        s.name = gi.name || s.name;
        s.icon = gi.icon || s.icon;
        if (!Array.isArray(s.events)) s.events = [];
        const ev = {
            id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
            ts: Date.now(), channelId: rec.channelId,
            authorId: rec.authorId, authorName: rec.authorName, authorAvatar: rec.authorAvatar,
            content: rec.content || "", media: []
        };
        s.events.unshift(ev);
        if (s.events.length > 600) s.events.length = 600;
        this.saveServer(s);
        if (rec.sources && rec.sources.length) this.captureServerMedia(gid, ev.id, rec.sources);
    }

    async captureServerMedia(gid, evId, sources) {
        const existing = new Set();
        const s0 = this.getServer(gid);
        if (s0 && Array.isArray(s0.events)) for (const e of s0.events) for (const m of (e.media || [])) if (m.hash) existing.add(m.hash);
        const recs = [];
        for (const s of sources) {
            try {
                const rec = await this.fetchToBlob(s.kind, s.name, s.url);
                if (rec.hash && existing.has(rec.hash)) continue;
                if (rec.hash) existing.add(rec.hash);
                recs.push(rec);
            } catch (e) { recs.push({ id: this.newId(), url: s.url, kind: s.kind, name: s.name, dead: true }); }
        }
        const fresh = this.getServer(gid);
        if (!fresh || !Array.isArray(fresh.events)) return;
        const ev = fresh.events.find(x => x.id === evId);
        if (!ev) return;
        if (recs.length) { ev.media = recs; this.saveServer(fresh); }
        else { fresh.events = fresh.events.filter(x => x.id !== evId); this.saveServer(fresh); }
    }

    pfpDir() {
        const dir = require("path").join(this.baseDir(), "pfp");
        try { require("fs").mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
        return dir;
    }

    getPfp() {
        try {
            const fs = require("fs");
            const p = require("path").join(this.pfpDir(), "pfp.json");
            if (fs.existsSync(p)) { const a = JSON.parse(fs.readFileSync(p, "utf8")); return Array.isArray(a) ? a : []; }
        } catch (e) { /* ignore */ }
        return [];
    }

    savePfp(arr) {
        try { require("fs").writeFileSync(require("path").join(this.pfpDir(), "pfp.json"), JSON.stringify(arr, null, 2)); } catch (e) { /* ignore */ }
        this.bump();
    }

    deletePfp(id) {
        const arr = this.getPfp();
        const p = arr.find(x => x.id === id);
        if (p && p.file && !p.hash) { try { require("fs").unlinkSync(require("path").join(this.pfpDir(), p.file)); } catch (e) { /* ignore */ } }
        this.savePfp(arr.filter(x => x.id !== id));
    }

    deleteAllPfp() {
        try { for (const p of this.getPfp()) { if (p.file && !p.hash) { try { require("fs").unlinkSync(require("path").join(this.pfpDir(), p.file)); } catch (e) { /* ignore */ } } } } catch (e) { /* ignore */ }
        this.savePfp([]);
        try { this.gcBlobs(); } catch (e) { /* ignore */ }
    }

    capturePfp(u) {
        if (!this.cfg().pfp || !this._pfpSeen) return;
        if (!u || u.id == null || !u.avatar || u.bot) return;
        const uid = String(u.id);
        const hash = String(u.avatar);
        const key = uid + ":" + hash;
        if (this._pfpSeen.has(key)) return;
        this._pfpSeen.add(key);
        this._pfpQ = this._pfpQ || [];
        this._pfpQ.push({ uid: uid, username: u.global_name || u.username || uid, hash: hash, key: key });
        this._pfpDrain();
    }

    _pfpDrain() {
        this._pfpActive = this._pfpActive || 0;
        while (this._pfpActive < 3 && this._pfpQ && this._pfpQ.length) {
            const job = this._pfpQ.shift();
            this._pfpActive++;
            this.storePfp(job.uid, job.username, job.hash)
                .catch(() => { try { if (this._pfpSeen) this._pfpSeen.delete(job.key); } catch (e) { /* ignore */ } })
                .then(() => { this._pfpActive--; this._pfpDrain(); });
        }
    }

    async storePfp(uid, username, avatarHash) {
        const ext = String(avatarHash).startsWith("a_") ? "gif" : "png";
        const url = "https://cdn.discordapp.com/avatars/" + uid + "/" + avatarHash + "." + ext + "?size=256";
        const rec = await this.fetchToBlob("image", "pfp." + ext, url);
        const store = this.getPfp();
        if (rec.hash && store.some(p => p.hash === rec.hash)) return;
        store.unshift({ id: rec.id, userId: uid, username: username, avatarHash: avatarHash, hash: rec.hash, ext: rec.ext, mime: rec.mime, size: rec.size, gif: ext === "gif", ts: Date.now() });
        if (store.length > 5000) store.length = 5000;
        this.savePfp(store);
    }

    cfg() {
        if (!this._cfg) this._cfg = Object.assign({ logger: true, notify: true, intro: true, servers: true, pfp: true }, BdApi.Data.load("psa", "__config__") || {});
        return this._cfg;
    }

    saveCfg(patch) {
        this._cfg = Object.assign(this.cfg(), patch);
        BdApi.Data.save("psa", "__config__", this._cfg);
    }

    tracked() {
        if (!this._tracked) this._tracked = new Set(this.getIndex().map(String));
        return this._tracked;
    }

    findDispatcher() {
        const W = BdApi.Webpack;
        const isDisp = m => m && typeof m.dispatch === "function" && typeof m.subscribe === "function" && typeof m.unsubscribe === "function";
        try {
            const s = W.getStore("UserStore") || W.getStore("ChannelStore") || W.getStore("SelectedChannelStore");
            if (s && isDisp(s._dispatcher)) { this._dispVia = "store._dispatcher"; return s._dispatcher; }
        } catch (e) { /* next */ }
        try {
            const D = W.getModule(m => isDisp(m), { searchExports: true });
            if (isDisp(D)) { this._dispVia = "getModule.searchExports"; return D; }
        } catch (e) { /* next */ }
        try {
            const D = W.getModule(m => isDisp(m));
            if (isDisp(D)) { this._dispVia = "getModule"; return D; }
        } catch (e) { /* next */ }
        try {
            const D = W.getModule(m => m && isDisp(m.default));
            if (D && isDisp(D.default)) { this._dispVia = "default"; return D.default; }
        } catch (e) { /* next */ }
        try {
            const D = W.getByKeys("dispatch", "subscribe", "unsubscribe");
            if (isDisp(D)) { this._dispVia = "getByKeys"; return D; }
        } catch (e) { /* next */ }
        this._dispVia = "not found";
        return null;
    }

    startLogger() {
        try {
            const Disp = this.findDispatcher();
            if (!Disp) return;
            this._disp = Disp;
            this._cache = new Map();
            this._srvCache = new Map();
            this._pfpSeen = new Set(this.getPfp().map(p => p.userId + ":" + p.avatarHash));
            this._onCreate = e => this.onMsgCreate(e);
            this._onUpdate = e => this.onMsgUpdate(e);
            this._onDelete = e => this.onMsgDelete(e);
            this._onBulk = e => this.onMsgBulk(e);
            this._onMember = e => { try { const u = e.user || (e.member && e.member.user); this.snapshotIdentity(u); this.capturePfp(u); } catch (x) { /* ignore */ } };
            this._onUser = e => { try { this.snapshotIdentity(e.user); this.capturePfp(e.user); } catch (x) { /* ignore */ } };
            this._onPresence = e => { try { this.onPresence(e); } catch (x) { /* ignore */ } };
            this._presLive = {};
            Disp.subscribe("MESSAGE_CREATE", this._onCreate);
            Disp.subscribe("MESSAGE_UPDATE", this._onUpdate);
            Disp.subscribe("MESSAGE_DELETE", this._onDelete);
            Disp.subscribe("MESSAGE_DELETE_BULK", this._onBulk);
            Disp.subscribe("GUILD_MEMBER_UPDATE", this._onMember);
            Disp.subscribe("USER_UPDATE", this._onUser);
            Disp.subscribe("PRESENCE_UPDATE", this._onPresence);
        } catch (e) { /* logger off */ }
    }

    stopLogger() {
        try {
            const Disp = this._disp;
            if (Disp) {
                Disp.unsubscribe("MESSAGE_CREATE", this._onCreate);
                Disp.unsubscribe("MESSAGE_UPDATE", this._onUpdate);
                Disp.unsubscribe("MESSAGE_DELETE", this._onDelete);
                Disp.unsubscribe("MESSAGE_DELETE_BULK", this._onBulk);
                Disp.unsubscribe("GUILD_MEMBER_UPDATE", this._onMember);
                Disp.unsubscribe("USER_UPDATE", this._onUser);
                Disp.unsubscribe("PRESENCE_UPDATE", this._onPresence);
            }
        } catch (e) { /* ignore */ }
        this._disp = null;
        this._cache = null;
        this._srvCache = null;
        this._pfpQ = [];
    }

    cacheMsg(m, channelId) {
        const aid = m.author && String(m.author.id);
        if (!aid || !this.tracked().has(aid)) return null;
        const rec = { authorId: aid, channelId: channelId || m.channel_id, content: m.content || "", sources: this.pickSources(m) };
        this._cache.set(String(m.id), rec);
        if (this._cache.size > 4000) this._cache.delete(this._cache.keys().next().value);
        return rec;
    }

    channelGuild(cid) {
        try { const CS = BdApi.Webpack.getStore("ChannelStore"); const ch = CS && CS.getChannel(cid); return (ch && ch.guild_id) || null; } catch (e) { return null; }
    }

    onMsgCreate(e) {
        if (!this._cache) return;
        const m = e.message;
        if (!m || !m.id) return;
        if (this.cfg().logger) {
            const rec = this.cacheMsg(m, e.channelId);
            if (rec && m.author) this.snapshotIdentity(m.author);
        }
        if (m.author) this.capturePfp(m.author);
        if (this.cfg().servers && this._srvCache && m.author && !m.author.bot && !m.webhook_id) {
            const gid = e.guildId || m.guild_id || this.channelGuild(e.channelId || m.channel_id);
            if (gid) {
                const imgs = this.serverImageSources(m);
                if (imgs.length) {
                    this._srvCache.set(String(m.id), {
                        guildId: String(gid), channelId: e.channelId || m.channel_id,
                        authorId: String(m.author.id), authorName: m.author.global_name || m.author.username || String(m.author.id),
                        authorAvatar: m.author.avatar || null, content: m.content || "", sources: imgs
                    });
                    if (this._srvCache.size > 6000) this._srvCache.delete(this._srvCache.keys().next().value);
                }
            }
        }
    }

    onMsgUpdate(e) {
        if (!this._cache || !this.cfg().logger) return;
        const m = e.message;
        if (!m || !m.id) return;
        const prev = this._cache.get(String(m.id));
        if (!prev) { this.cacheMsg(m, e.channelId); return; }
        const next = typeof m.content === "string" ? m.content : prev.content;
        if (next === prev.content) return;
        this.logEvent(prev.authorId, { kind: "edited", channelId: prev.channelId, old: prev.content, content: next });
        prev.content = next;
        this.notify(prev.authorId, "a modifié un message");
    }

    onMsgDelete(e) {
        if (!this._cache) return;
        const id = String(e.id);
        if (this.cfg().logger) {
            const prev = this._cache.get(id);
            if (prev) {
                this._cache.delete(id);
                this.logEvent(prev.authorId, { kind: "deleted", channelId: prev.channelId, content: prev.content }, prev.sources);
                this.notify(prev.authorId, "a supprimé un message");
            }
        }
        if (this.cfg().servers && this._srvCache) {
            const srv = this._srvCache.get(id);
            if (srv) { this._srvCache.delete(id); this.logServerDelete(srv); }
        }
    }

    onMsgBulk(e) {
        for (const id of (e.ids || [])) this.onMsgDelete({ id, channelId: e.channelId });
    }

    logEvent(userId, ev, sources) {
        const fiche = this.getFiche(userId);
        if (!fiche) return;
        if (!Array.isArray(fiche.events)) fiche.events = [];
        ev.id = Date.now() + "-" + Math.random().toString(36).slice(2, 7);
        ev.ts = Date.now();
        ev.media = [];
        fiche.events.unshift(ev);
        if (fiche.events.length > 300) fiche.events.length = 300;
        this.saveFiche(fiche);
        if (sources && sources.length) this.captureEventMedia(userId, ev.id, sources);
    }

    async captureEventMedia(userId, evId, sources) {
        const recs = [];
        for (const s of sources) {
            try { recs.push(await this.fetchAndStore(userId, s.kind, s.name, s.url)); }
            catch (e) { recs.push({ id: Date.now() + "-" + Math.random().toString(36).slice(2, 7), url: s.url, kind: s.kind, name: s.name, addedAt: Date.now(), dead: true }); }
        }
        const fresh = this.getFiche(userId);
        if (!fresh || !Array.isArray(fresh.events)) return;
        const ev = fresh.events.find(x => x.id === evId);
        if (ev) { ev.media = recs; this.saveFiche(fresh); }
    }

    notify(userId, what) {
        if (!this.cfg().notify) return;
        const f = this.getFiche(userId);
        this.toast("👁 " + ((f && f.username) || userId) + " " + what, "info");
    }

    avatarUrlFromHash(uid, hash) {
        if (!hash) return null;
        const ext = String(hash).startsWith("a_") ? "gif" : "png";
        return "https://cdn.discordapp.com/avatars/" + uid + "/" + hash + "." + ext + "?size=64";
    }

    snapshotIdentity(u) {
        if (!this.cfg().logger) return;
        if (!u || u.id == null) return;
        const uid = String(u.id);
        if (!this.tracked().has(uid)) return;
        const sig = (u.username || "") + "|" + (u.global_name || u.globalName || "") + "|" + (u.avatar || "");
        const ic = (this._identCache || (this._identCache = {}));
        if (ic[uid] === sig) return;
        ic[uid] = sig;
        const fiche = this.getFiche(uid);
        if (!fiche) return;
        if (!Array.isArray(fiche.idHistory)) fiche.idHistory = [];
        if (!Array.isArray(fiche.avatars)) fiche.avatars = [];
        let changed = false;
        const now = Date.now();

        const handle = u.username != null ? String(u.username) : null;
        if (handle) {
            if (fiche.identUsername == null) { fiche.identUsername = handle; changed = true; }
            else if (handle !== fiche.identUsername) {
                fiche.idHistory.unshift({ kind: "username", old: fiche.identUsername, new: handle, ts: now });
                fiche.identUsername = handle; changed = true;
            }
        }

        const disp = u.global_name != null ? String(u.global_name) : (u.globalName != null ? String(u.globalName) : null);
        if (disp) {
            if (fiche.identDisplay == null) { fiche.identDisplay = disp; changed = true; }
            else if (disp !== fiche.identDisplay) {
                fiche.idHistory.unshift({ kind: "display", old: fiche.identDisplay, new: disp, ts: now });
                fiche.identDisplay = disp; changed = true;
            }
        }

        const av = u.avatar != null ? String(u.avatar) : null;
        const lastAv = fiche.avatars.length ? fiche.avatars[fiche.avatars.length - 1].hash : undefined;
        if (fiche.avatars.length === 0) {
            if (av) { fiche.avatars.push({ hash: av, ts: now }); changed = true; }
        } else if (av !== lastAv) {
            fiche.avatars.push({ hash: av, ts: now });
            if (fiche.avatars.length > 20) fiche.avatars.shift();
            fiche.idHistory.unshift({ kind: "avatar", old: lastAv || null, new: av || null, ts: now });
            changed = true;
        }

        if (fiche.idHistory.length > 100) fiche.idHistory.length = 100;

        const best = fiche.identDisplay || fiche.identUsername;
        if (best && best !== fiche.username) { fiche.username = best; changed = true; }

        if (changed) this.saveFiche(fiche);
    }

    onPresence(e) {
        if (!this._cache || !this.cfg().logger) return;
        const u = e.user;
        const uid = u && u.id != null ? String(u.id) : null;
        if (!uid || !this.tracked().has(uid)) return;
        const live = (this._presLive || (this._presLive = {}))[uid] || (this._presLive[uid] = {});
        const now = Date.now();
        const status = e.status || "offline";
        const acts = e.activities || [];
        const game = acts.find(a => a.type === 0);
        const gname = game ? game.name : null;
        const spotify = acts.find(a => a.type === 2);
        const ssig = spotify ? ((spotify.details || "") + " — " + (spotify.state || "")) : null;
        const custom = acts.find(a => a.type === 4);
        const ctxt = custom ? ((custom.state || "") || (custom.emoji && custom.emoji.name) || "") : "";

        const events = [];
        if (live.status !== status) { if (live.status !== undefined) events.push({ kind: "status", status: status, ts: now }); live.status = status; }
        if (gname !== live.game) {
            if (live.game) events.push({ kind: "game", name: live.game, start: live.gameSince || now, end: now, dur: now - (live.gameSince || now), ts: now });
            if (gname) live.gameSince = now;
            live.game = gname;
        }
        if (ssig && ssig !== live.spotify) { events.push({ kind: "spotify", song: spotify.details || "", artist: spotify.state || "", ts: now }); live.spotify = ssig; }
        if (!spotify) live.spotify = null;
        if (ctxt && ctxt !== live.custom) { events.push({ kind: "custom", text: ctxt, ts: now }); live.custom = ctxt; }
        if (!custom) live.custom = null;

        if (!events.length) return;
        const fiche = this.getFiche(uid);
        if (!fiche) return;
        if (!Array.isArray(fiche.presence)) fiche.presence = [];
        for (const ev of events) fiche.presence.unshift(ev);
        if (fiche.presence.length > 200) fiche.presence.length = 200;
        this.saveFiche(fiche);
    }

    hm(ts) {
        try { const d = new Date(ts); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); } catch (e) { return ""; }
    }

    dayLabel(ts) {
        const d = new Date(ts); const n = new Date();
        const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
        if (same(d, n)) return "aujourd'hui";
        const y = new Date(n); y.setDate(n.getDate() - 1);
        if (same(d, y)) return "hier";
        return d.getDate() + " " + ["jan", "fév", "mar", "avr", "mai", "juin", "juil", "aoû", "sep", "oct", "nov", "déc"][d.getMonth()];
    }

    humanDur(ms) {
        const s = Math.round(ms / 1000);
        if (s < 60) return s + "s";
        const m = Math.round(s / 60);
        if (m < 60) return m + "min";
        const h = Math.floor(m / 60), r = m % 60;
        return h + "h" + (r ? String(r).padStart(2, "0") : "");
    }

    pagerEl(page, pages, setPage, total, per, label) {
        const h = BdApi.React.createElement;
        if (pages <= 1) {
            if (!total) return null;
            return h("div", { className: "psa-pcount" }, total + " " + (label || "éléments"));
        }
        const kids = [h("div", { key: "prev", className: "psa-pbtn arrow" + (page <= 1 ? " dis" : ""), onClick: () => { if (page > 1) setPage(page - 1); } }, "‹")];
        const arr = Array.from(new Set([1, 2, pages - 1, pages, page - 1, page, page + 1])).filter(n => n >= 1 && n <= pages).sort((a, b) => a - b);
        let prev = 0;
        for (const n of arr) {
            if (n - prev > 1) kids.push(h("span", { key: "d" + n, className: "psa-pdots" }, "…"));
            kids.push(h("div", { key: "p" + n, className: "psa-pbtn" + (n === page ? " on" : ""), onClick: () => setPage(n) }, String(n)));
            prev = n;
        }
        kids.push(h("div", { key: "next", className: "psa-pbtn arrow" + (page >= pages ? " dis" : ""), onClick: () => { if (page < pages) setPage(page + 1); } }, "›"));
        const from = (page - 1) * per + 1, to = Math.min(page * per, total);
        return h("div", { key: "pgwrap" }, [
            h("div", { key: "bar", className: "psa-pager" }, kids),
            h("div", { key: "cnt", className: "psa-pcount" }, ["Page ", h("b", { key: "b" }, page + " / " + pages), " · " + (label || "éléments") + " " + from + "–" + to + " sur " + total])
        ]);
    }

    locLabel(channelId) {
        try {
            const CS = BdApi.Webpack.getStore("ChannelStore");
            const ch = CS && CS.getChannel(channelId);
            if (!ch) return { channel: "salon inconnu", guild: null, dm: true };
            if (ch.guild_id) {
                const GS = BdApi.Webpack.getStore("GuildStore");
                const g = GS && GS.getGuild(ch.guild_id);
                return { channel: "#" + (ch.name || "salon"), guild: (g && g.name) || "serveur", dm: false };
            }
            if (ch.name) return { channel: "@" + ch.name, guild: null, dm: true };
            return { channel: "direct message", guild: null, dm: true };
        } catch (e) { return { channel: "salon inconnu", guild: null, dm: true }; }
    }

    mediaThumb() {
        if (this._MediaThumb) return this._MediaThumb;
        const self = this;
        const React = BdApi.React;
        const h = React.createElement;
        this._MediaThumb = function MediaThumb(props) {
            const m = props.m;
            const uid = props.userId;
            const [src, setSrc] = React.useState("");
            const [err, setErr] = React.useState(false);
            React.useEffect(() => {
                let alive = true;
                (async () => {
                    try {
                        const fsx = require("fs");
                        let abs = (m.abs && fsx.existsSync(m.abs)) ? m.abs : (uid ? self.mediaAbs(uid, m) : null);
                        if (abs && fsx.existsSync(abs)) {
                            let of = null; try { of = require("original-fs"); } catch (e) { /* fallback */ }
                            const reader = of || fsx;
                            const mime = m.kind === "video" ? "video/mp4" : (m.mime || self.mimeForExt(m.file || m.name || abs));
                            const url = "data:" + mime + ";base64," + reader.readFileSync(abs, "base64");
                            if (alive) setSrc(url);
                        } else if (alive) { setErr(true); }
                    } catch (e) { if (alive) setErr(true); }
                })();
                return () => { alive = false; };
            }, [m.id]);
            const ext = (m.name && m.name.split(".").pop()) || m.kind || "";
            const kids = [h("span", { key: "k", className: "kd" }, String(ext).slice(0, 4))];
            if (src && m.kind === "video") kids.push(h("video", { key: "v", className: "psa-gmedia", src: src, muted: true, playsInline: true, preload: "metadata", onError: () => setErr(true) }));
            else if (src) kids.push(h("img", { key: "i", className: "psa-gmedia", src: src, onError: () => setErr(true) }));
            else if (!err) kids.push(h("span", { key: "l", className: "psa-gload" }, "◌"));
            return h("div", { className: "psa-gcell" + (m.kind === "video" ? " vid" : "") + (err ? " fail" : ""), onClick: () => { if (uid) self.openFiche(uid); }, title: m.name || "" }, kids);
        };
        return this._MediaThumb;
    }

    renderEvent(ev, key, userId) {
        const h = BdApi.React.createElement;
        const del = ev.kind === "deleted";
        const loc = this.locLabel(ev.channelId);
        const locEl = loc.dm
            ? h("span", { key: "loc", className: "psa-ev-loc" }, [h("span", { key: "h", className: "h" }, "@ "), loc.channel])
            : h("span", { key: "loc", className: "psa-ev-loc" }, [h("span", { key: "c" }, loc.channel), h("span", { key: "h", className: "h" }, " · "), h("b", { key: "g" }, loc.guild)]);
        const top = h("div", { key: "top", className: "psa-ev-top" }, [
            h("span", { key: "tag", className: "psa-tag " + (del ? "del" : "edt") }, del ? "deleted" : "edited"),
            locEl,
            h("span", { key: "w", className: "psa-ev-when" }, this.ago(ev.ts))
        ]);
        const kids = [top];
        if (del) {
            kids.push(h("div", { key: "b", className: "psa-ev-body del" }, ev.content
                ? h("span", { className: "strk" }, ev.content)
                : h("span", { className: "psa-ev-empty" }, "— média sans texte —")));
        } else {
            kids.push(h("div", { key: "d", className: "psa-diff" }, [
                h("div", { key: "m", className: "psa-diff-row minus" }, [h("span", { key: "g", className: "g" }, "−"), h("span", { key: "t" }, ev.old || "∅")]),
                h("div", { key: "p", className: "psa-diff-row plus" }, [h("span", { key: "g", className: "g" }, "+"), h("span", { key: "t" }, ev.content || "∅")])
            ]));
        }
        if (Array.isArray(ev.media) && ev.media.length) {
            const Thumb = this.mediaThumb();
            kids.push(h("div", { key: "md", className: "psa-ev-media" }, ev.media.map((m, i) => h(Thumb, { key: m.id || i, m: m, userId: userId }))));
        }
        return h("div", { key: key, className: "psa-ev " + (del ? "del" : "edt") }, [
            h("span", { key: "node", className: "psa-node" }),
            h("div", { key: "card", className: "psa-ev-card" }, kids)
        ]);
    }

    renderIdentity(userId, fiche) {
        const h = BdApi.React.createElement;
        const hist = (fiche.idHistory || []).filter(x => x.kind !== "avatar");
        const avs = fiche.avatars || [];
        if (!hist.length && avs.length < 2) return null;
        const kids = [];
        kids.push(h("div", { key: "sec", className: "psa-acth" }, [
            h("span", { key: "l", className: "psa-acth-l" }, ["Identity ", h("b", { key: "b" }, "// pseudos & avatars")]),
            h("span", { key: "r", className: "psa-acth-rule" }),
            h("span", { key: "m", className: "psa-acth-m" }, (hist.length + (avs.length > 1 ? avs.length - 1 : 0)) + " changements")
        ]));
        kids.push(h("div", { key: "now", className: "psa-idnow" }, [
            h("span", { key: "lab", className: "psa-idlab" }, "actuel"),
            h("div", { key: "v", className: "psa-idvcol" }, [
                h("div", { key: "val", className: "psa-idval" }, fiche.identDisplay || fiche.username || userId),
                h("div", { key: "sub", className: "psa-idsub" }, fiche.identUsername ? "@" + fiche.identUsername : String(userId))
            ])
        ]));
        if (hist.length) {
            kids.push(h("div", { key: "hist", className: "psa-idhist" }, hist.map((x, k) => h("div", { key: k, className: "psa-idrow" }, [
                h("span", { key: "k", className: "psa-idk" }, x.kind === "username" ? "username" : "display"),
                h("span", { key: "o", className: "psa-idold" }, (x.kind === "username" ? "@" : "") + (x.old || "?")),
                h("span", { key: "a", className: "psa-idarr" }, "→"),
                h("span", { key: "n", className: "psa-idnew" }, (x.kind === "username" ? "@" : "") + (x.new || "?")),
                h("span", { key: "w", className: "psa-idwhen" }, this.ago(x.ts))
            ]))));
        }
        if (avs.length > 1) {
            const items = [];
            avs.forEach((a, k) => {
                if (k > 0) items.push(h("span", { key: "ar" + k, className: "psa-avarr" }, "›"));
                const url = this.avatarUrlFromHash(userId, a.hash);
                items.push(h("div", { key: "av" + k, className: "psa-avitem" + (k === avs.length - 1 ? " cur" : "") }, [
                    h("div", { key: "p", className: "psa-avpic" }, url ? h("img", { src: url, alt: "" }) : "∅"),
                    h("div", { key: "d", className: "psa-avdt" }, this.ago(a.ts))
                ]));
            });
            kids.push(h("div", { key: "strip", className: "psa-avstrip" }, items));
        }
        return h("div", { key: "identity", className: "psa-identity" }, kids);
    }

    renderPresence(fiche) {
        const h = BdApi.React.createElement;
        const list = (fiche.presence || []);
        if (!list.length) return null;
        const statusLabel = { online: "en ligne", idle: "inactif", dnd: "ne pas déranger", offline: "hors ligne" };
        const kids = [];
        kids.push(h("div", { key: "sec", className: "psa-acth" }, [
            h("span", { key: "l", className: "psa-acth-l" }, ["Presence ", h("b", { key: "b" }, "// activité")]),
            h("span", { key: "r", className: "psa-acth-rule" }),
            h("span", { key: "m", className: "psa-acth-m" }, list.length + " events")
        ]));
        let curDay = null;
        list.forEach((p, k) => {
            const day = this.dayLabel(p.ts);
            if (day !== curDay) { curDay = day; kids.push(h("div", { key: "d" + k, className: "psa-pday" }, "— " + day + " —")); }
            let ico, dot, ttl, sub, badge, when = this.hm(p.ts);
            if (p.kind === "status") {
                dot = p.status || "offline";
                ttl = ["Passé ", h("b", { key: "b" }, statusLabel[p.status] || p.status)];
            } else if (p.kind === "game") {
                ico = "🎮";
                ttl = ["A joué à ", h("b", { key: "b" }, p.name || "?")];
                if (p.start && p.end) { sub = this.hm(p.start) + " → " + this.hm(p.end); badge = this.humanDur(p.dur || 0); when = ""; }
            } else if (p.kind === "spotify") {
                ico = "♫"; ttl = [h("b", { key: "b", className: "psa-spot" }, "Spotify"), " — " + (p.song || "?")]; sub = p.artist || "";
            } else if (p.kind === "custom") {
                ico = "💬"; ttl = ["Custom status ", h("b", { key: "b" }, "“" + p.text + "”")];
            } else { return; }
            const left = dot
                ? h("span", { key: "l", className: "psa-pdot " + dot })
                : h("span", { key: "l", className: "psa-pico" + (p.kind === "spotify" ? " spot" : "") }, ico);
            const main = [h("div", { key: "t", className: "psa-pttl" }, ttl)];
            if (sub) main.push(h("div", { key: "s", className: "psa-psub" }, sub));
            const row = [left, h("div", { key: "m", className: "psa-pmain" }, main)];
            if (badge) row.push(h("span", { key: "b", className: "psa-pdur" }, badge));
            if (when) row.push(h("span", { key: "w", className: "psa-pwhen" }, when));
            kids.push(h("div", { key: "p" + k, className: "psa-prow" }, row));
        });
        return h("div", { key: "presence", className: "psa-presence" }, kids);
    }

    touchUsername(fiche, username) {
        if (!username || username === fiche.username) return;
        if (fiche.username && !fiche.aliases.includes(fiche.username)) fiche.aliases.push(fiche.username);
        fiche.username = username;
    }

    createdAt(userId) {
        try {
            return Number((BigInt(userId) >> 22n) + this.EPOCH);
        } catch (e) {
            return null;
        }
    }

    ago(ms) {
        if (!ms) return "?";
        const d = Math.floor((Date.now() - ms) / 86400000);
        if (d < 1) return "today";
        if (d < 30) return d + "d ago";
        if (d < 365) return Math.floor(d / 30) + "mo ago";
        return Math.floor(d / 365) + "y ago";
    }

    toast(message, type) {
        BdApi.UI.showToast(message, { type: type || "success" });
    }

    kindOf(contentType, name) {
        const ct = contentType || "";
        if (ct.startsWith("image/") || this.IMAGE_EXT.test(name)) return "image";
        if (ct.startsWith("video/") || this.VIDEO_EXT.test(name)) return "video";
        return null;
    }

    pickSources(message) {
        const out = [];
        for (const a of (message.attachments || [])) {
            const name = a.filename || a.name || "media";
            const kind = this.kindOf(a.content_type || a.contentType, name);
            if (kind) out.push({ url: a.url || a.proxy_url, name, kind });
        }
        for (const e of (message.embeds || [])) {
            const img = (e.image && (e.image.url || e.image.proxyURL)) || (e.thumbnail && (e.thumbnail.url || e.thumbnail.proxyURL));
            if (img) out.push({ url: img, name: "embed", kind: "image" });
        }
        return out;
    }

    dataDir() {
        const path = require("path");
        try { return path.join(BdApi.Plugins.folder, "..", "data"); } catch (e) { /* fallback */ }
        return path.join(process.env.APPDATA || require("os").homedir(), "BetterDiscord", "data");
    }

    baseDir() {
        const dir = require("path").join(this.dataDir(), "psa");
        try { require("fs").mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
        return dir;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  psa.sec — gestionnaire de comptes / vault de tokens chiffré (AES-256-GCM)
    //  Fusionné dans psa : mêmes données que l'ancien plugin (data/psa.sec/vault.json).
    // ═══════════════════════════════════════════════════════════════════════
    secBaseDir() {
        const dir = require("path").join(this.dataDir(), "psa.sec");
        try { require("fs").mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
        return dir;
    }
    secVaultPath() { return require("path").join(this.secBaseDir(), "vault.json"); }

    secLoadVault() {
        try {
            const fs = require("fs");
            const p = this.secVaultPath();
            if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
        } catch (e) { /* ignore */ }
        return null;
    }
    secSaveVault(vault) {
        try {
            const fs = require("fs");
            const p = this.secVaultPath();
            const tmp = p + ".tmp";
            fs.writeFileSync(tmp, JSON.stringify(vault));
            fs.renameSync(tmp, p);
        } catch (e) { this.toast("Écriture vault échouée", "error"); }
    }

    // WebCrypto (dispo nativement dans le renderer Discord — pas de node crypto shimé)
    sec_subtle() {
        const g = (typeof globalThis !== "undefined" ? globalThis : window);
        return (g.crypto && g.crypto.subtle) ? g.crypto.subtle : null;
    }
    sec_rand(n) {
        const g = (typeof globalThis !== "undefined" ? globalThis : window);
        const a = new Uint8Array(n); g.crypto.getRandomValues(a); return a;
    }
    sec_hex(buf) { const a = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let s = ""; for (let i = 0; i < a.length; i++) s += a[i].toString(16).padStart(2, "0"); return s; }
    sec_unhex(hex) { const a = new Uint8Array(hex.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16); return a; }

    async secDeriveKey(pass, saltHex) {
        const s = this.sec_subtle();
        const base = await s.importKey("raw", new TextEncoder().encode(String(pass)), { name: "PBKDF2" }, false, ["deriveKey"]);
        return await s.deriveKey({ name: "PBKDF2", salt: this.sec_unhex(saltHex), iterations: 210000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    }
    async secEncrypt(plain, key) {
        const s = this.sec_subtle();
        const iv = this.sec_rand(12);
        const ct = await s.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(String(plain)));
        return { iv: this.sec_hex(iv), ct: this.sec_hex(ct) };
    }
    async secDecrypt(blob, key) {
        const s = this.sec_subtle();
        const pt = await s.decrypt({ name: "AES-GCM", iv: this.sec_unhex(blob.iv) }, key, this.sec_unhex(blob.ct));
        return new TextDecoder().decode(pt);
    }

    async secPersistVault() {
        if (!this._secKey || !this._secAccounts) return;
        this.secSaveVault({ v: 2, salt: this._secSalt, blob: await this.secEncrypt(JSON.stringify(this._secAccounts), this._secKey) });
    }

    async secCreateVault(pass) {
        const salt = this.sec_hex(this.sec_rand(16));
        this._secKey = await this.secDeriveKey(pass, salt);
        this._secSalt = salt;
        this._secAccounts = [];
        this.secSaveVault({ v: 2, salt, blob: await this.secEncrypt("[]", this._secKey) });
        return true;
    }

    async secUnlock(pass) {
        const vault = this.secLoadVault();
        if (!vault) return this.secCreateVault(pass);
        try {
            const key = await this.secDeriveKey(pass, vault.salt);
            const arr = JSON.parse(await this.secDecrypt(vault.blob, key));
            if (!Array.isArray(arr)) throw new Error("bad");
            this._secKey = key;
            this._secSalt = vault.salt;
            this._secAccounts = arr;
            return true;
        } catch (e) { return false; }
    }

    secCurrentUserId() {
        try { return BdApi.Webpack.getStore("UserStore").getCurrentUser()?.id || null; } catch (e) { return null; }
    }
    secAvatarUrl(id, avatar) {
        if (!id || !avatar) return null;
        const ext = String(avatar).startsWith("a_") ? "gif" : "png";
        return `https://cdn.discordapp.com/avatars/${id}/${avatar}.${ext}?size=64`;
    }
    secMaskToken(t) {
        const s = String(t || "");
        if (s.length < 12) return "••••";
        return s.slice(0, 4) + "…" + s.slice(-4);
    }

    async secApiFetch(pathname, token) {
        const url = this.SEC_API + pathname;
        const headers = { "Authorization": token, "Content-Type": "application/json" };
        try {
            if (BdApi.Net && typeof BdApi.Net.fetch === "function") {
                const r = await BdApi.Net.fetch(url, { headers });
                if (!r.ok) throw new Error("http " + r.status);
                return await r.json();
            }
        } catch (e) { /* fallback */ }
        const r = await fetch(url, { headers });
        if (!r.ok) throw new Error("http " + r.status);
        return await r.json();
    }

    // ajoute plusieurs tokens d'un coup (séparés par retour ligne / espace / virgule)
    async secAddTokens(raw, onProgress) {
        if (!this._secAccounts) return { added: 0, failed: 0, dup: 0, total: 0 };
        const toks = String(raw || "").split(/[\s,]+/).map(t => t.trim().replace(/^"|"$/g, "")).filter(t => t.length >= 20);
        const uniq = [...new Set(toks)];
        let added = 0, failed = 0, dup = 0, done = 0;
        for (const t of uniq) {
            done++;
            if (typeof onProgress === "function") { try { onProgress(done, uniq.length); } catch (e) {} }
            if (this._secAccounts.some(a => a.token === t)) { dup++; continue; }
            let me;
            try { me = await this.secApiFetch("/users/@me", t); }
            catch (e) { failed++; continue; }
            const acct = {
                id: me.id, username: me.username, global: me.global_name || null,
                discriminator: (me.discriminator && me.discriminator !== "0") ? me.discriminator : null,
                avatar: me.avatar || null, token: t, addedAt: Date.now(),
            };
            this._secAccounts = this._secAccounts.filter(a => a.id !== acct.id);
            this._secAccounts.unshift(acct);
            added++;
        }
        if (added) await this.secPersistVault();
        return { added, failed, dup, total: uniq.length };
    }

    // vérifie l'état d'un token sans s'y connecter (API /users/@me)
    async secCheckToken(token) {
        const url = this.SEC_API + "/users/@me";
        const headers = { "Authorization": token };
        try {
            let r;
            if (BdApi.Net && typeof BdApi.Net.fetch === "function") r = await BdApi.Net.fetch(url, { headers });
            else r = await fetch(url, { headers });
            const status = r.status;
            let body = null; try { body = await r.json(); } catch (e) { /* pas de JSON */ }
            if (status === 429) return { state: "ratelimit" };
            if (status === 200) {
                // Token valide. Discord expose l'état du compte sur /@me :
                //  - désactivé (ban ToS)     → me.disabled === true
                //  - verrouillé/quarantaine  → me.flags a le bit QUARANTINED, ou verif requise
                const disabled = body && (body.disabled === true || body.deleted === true);
                if (disabled) return { state: "disabled", me: body };
                const flags = (body && (body.flags || body.public_flags)) || 0;
                const QUARANTINED = 1 << 44; // best-effort ; peut ne pas être présent sur /@me
                const quarantined = typeof flags === "number" && (flags & QUARANTINED) === QUARANTINED;
                if (quarantined) return { state: "locked", me: body };
                return { state: "alive", me: body };
            }
            const code = body && body.code;
            // Codes d'erreur Discord : 20026 = compte désactivé ; 40002 = vérification requise
            if (code === 20026) return { state: "disabled" };
            if (code === 40002) return { state: "locked" };
            if (status === 403) return { state: "locked" };  // accès bloqué → compte flaggé/verrouillé
            if (status === 401) return { state: "dead" };     // token invalide (déconnexion / mdp changé)
            return { state: "unknown" };
        } catch (e) { return { state: "unknown" }; }
    }

    // vérifie TOUS les comptes, marque les morts (throttlé + gère le rate limit)
    async secCheckAll(onProgress) {
        if (!this._secAccounts) return { alive: 0, dead: 0, locked: 0, disabled: 0, unknown: 0 };
        let alive = 0, dead = 0, locked = 0, disabled = 0, unknown = 0, done = 0;
        const applyMeta = (a, me) => { if (me && me.id) { a.username = me.username || a.username; a.global = me.global_name || a.global; a.avatar = (me.avatar !== undefined ? me.avatar : a.avatar); } };
        for (const a of this._secAccounts) {
            done++;
            if (typeof onProgress === "function") { try { onProgress(done, this._secAccounts.length); } catch (e) {} }
            let r = await this.secCheckToken(a.token);
            if (r.state === "ratelimit") { await new Promise(res => setTimeout(res, 2500)); r = await this.secCheckToken(a.token); }
            a.checkedAt = Date.now();
            if (r.state === "alive") { a.state = "alive"; a.dead = false; applyMeta(a, r.me); alive++; }
            else if (r.state === "locked") { a.state = "locked"; a.dead = false; applyMeta(a, r.me); locked++; }   // token OK, compte verrouillé → récupérable
            else if (r.state === "disabled") { a.state = "disabled"; a.dead = true; disabled++; }                  // banni / désactivé
            else if (r.state === "dead") { a.state = "dead"; a.dead = true; dead++; }                              // token invalide
            else unknown++;
            await new Promise(res => setTimeout(res, 250));
        }
        await this.secPersistVault();
        return { alive, dead, locked, disabled, unknown };
    }

    secRemoveDead() {
        if (!this._secAccounts) return 0;
        const before = this._secAccounts.length;
        this._secAccounts = this._secAccounts.filter(a => !a.dead);
        this.secPersistVault().catch(() => {});
        return before - this._secAccounts.length;
    }
    secRemoveAccount(id) {
        if (!this._secAccounts) return;
        this._secAccounts = this._secAccounts.filter(a => a.id !== id);
        this.secPersistVault().catch(() => {});
    }

    secTokenModule() {
        try {
            const W = BdApi.Webpack;
            let m = W.getModule(x => x && typeof x.setToken === "function" && typeof x.getToken === "function", { searchExports: true });
            if (m && typeof m.setToken === "function") return m;
            m = W.getModule(x => x && typeof x.setToken === "function", { searchExports: true });
            if (m && typeof m.setToken === "function") return m;
        } catch (e) {}
        return null;
    }

    // récupère le vrai localStorage (Discord masque window.localStorage)
    secLocalStorage() {
        try { if (window.localStorage && window.localStorage.setItem) return window.localStorage; } catch (e) {}
        try {
            const i = document.createElement("iframe");
            i.style.display = "none";
            document.head.appendChild(i);
            const w = i.contentWindow;
            let d = Object.getOwnPropertyDescriptor(w, "localStorage")
                || (w.Window && Object.getOwnPropertyDescriptor(w.Window.prototype, "localStorage"))
                || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(w), "localStorage");
            let ls = null;
            if (d && d.get) { try { ls = d.get.call(window); } catch (e) {} }
            if (!ls) { try { ls = w.localStorage; } catch (e) {} }
            i.remove();
            return (ls && ls.setItem) ? ls : null;
        } catch (e) { return null; }
    }

    secLoginAction() {
        try {
            const W = BdApi.Webpack;
            let m = W.getModule(x => x && typeof x.loginToken === "function");
            if (m && typeof m.loginToken === "function") return m;
            m = W.getModule(x => x && typeof x.loginToken === "function", { searchExports: true });
            if (m && typeof m.loginToken === "function") return m;
            m = W.getModule(x => x && x.default && typeof x.default.loginToken === "function");
            if (m && m.default && typeof m.default.loginToken === "function") return m.default;
        } catch (e) {}
        return null;
    }

    secConnect(token) {
        const tok = String(token);
        try {
            // 1) MÉTHODE PRINCIPALE — écrire le token dans le vrai localStorage puis reload.
            //    La plus fiable toutes versions de Discord : Discord relit "token" au boot.
            //    On écrit AVANT le reload, une seule fois, sans interrompre de handshake.
            const ls = this.secLocalStorage();
            if (ls) {
                ls.setItem("token", JSON.stringify(tok));
                this.toast("Connexion…", "info");
                setTimeout(() => location.reload(), 400);
                return;
            }
            // 2) Fallback — action interne loginToken (switch live). PAS de reload forcé :
            //    Discord gère lui-même la reconnexion ; un reload manuel casse le handshake
            //    et renvoie sur la page de login. Reload de secours seulement si rien ne bouge.
            const am = this.secLoginAction();
            if (am && typeof am.loginToken === "function") {
                am.loginToken(tok);
                this.toast("Connexion…", "info");
                const before = this.secCurrentUserId();
                setTimeout(() => { if (this.secCurrentUserId() === before) location.reload(); }, 2000);
                return;
            }
            // 3) Fallback — module token interne (setToken) + reload.
            const tm = this.secTokenModule();
            if (tm && typeof tm.setToken === "function") {
                tm.setToken(tok);
                this.toast("Connexion…", "info");
                setTimeout(() => location.reload(), 400);
                return;
            }
            throw new Error("aucune méthode de connexion trouvée (webpack)");
        } catch (e) {
            this.toast("Échec du switch : " + (e.message || e), "error");
        }
    }

    secOpenExternal(url) {
        try { require("electron").shell.openExternal(url); }
        catch (e) { try { window.open(url, "_blank"); } catch (_) {} }
    }

    // Modale d'aide — instructions OFFICIELLES de récupération (compte verrouillé / désactivé)
    secGuide(state, acct) {
        const React = BdApi.React;
        const h = React.createElement;
        const link = (txt, url) => h("a", { href: "#", onClick: (e) => { e.preventDefault(); this.secOpenExternal(url); }, style: { color: "var(--green, #4cd42c)", cursor: "pointer", textDecoration: "underline" } }, txt);
        const li = (kids) => h("li", { style: { margin: "0 0 9px", lineHeight: 1.55 } }, kids);
        const wrap = (title, intro, steps, foot) => h("div", { style: { fontSize: "14px", color: "#e6e6ea", maxWidth: "560px" } }, [
            h("div", { key: "i", style: { marginBottom: "12px", color: "#c9c9d1" } }, intro),
            h("ol", { key: "s", style: { paddingLeft: "20px", margin: "0 0 6px" } }, steps),
            foot ? h("div", { key: "f", style: { marginTop: "10px", fontSize: "12.5px", color: "#9a9aa2" } }, foot) : null
        ]);

        let title, content;
        if (state === "disabled") {
            title = "Compte désactivé / banni";
            content = wrap(title,
                "Discord a désactivé ce compte (violation des CGU ou activité suspecte). Le token reste valide mais le compte est bloqué. Seul l'appel officiel peut le rétablir :",
                [
                    li(["Ouvre le ", link("formulaire d'appel Discord", "https://dis.gd/appeal"), " (ou depuis l'app : Paramètres → besoin d'aide)."]),
                    li("Connecte-toi avec l'email du compte concerné et explique ta situation."),
                    li("Fournis email + numéro de téléphone liés au compte pour prouver que c'est le tien."),
                    li(["Suis les mails de ", link("support Discord", "https://support.discord.com"), ". Réponds dans le même fil, ne réouvre pas 10 tickets."])
                ],
                "Un ban CGU définitif n'est pas toujours réversible — l'appel est le seul canal légitime.");
        } else {
            title = "Compte verrouillé — déverrouiller";
            content = wrap(title,
                "Le token est bon mais Discord a verrouillé le compte (login suspect, vérification requise). Ça se déverrouille dans l'app officielle, pas par injection de token :",
                [
                    li(["Ouvre ", link("discord.com/login", "https://discord.com/login"), " (ou l'app Discord) et connecte-toi normalement avec email + mot de passe."]),
                    li("Résous le captcha si demandé."),
                    li("Vérifie l'email : clique le lien « Vérifier l'adresse » dans le mail Discord."),
                    li("Si un numéro est demandé : ajoute/confirme le téléphone (Paramètres → Mon compte)."),
                    li("Change le mot de passe si Discord le réclame (compromission suspectée)."),
                    li(["2FA activée : garde tes codes de secours. Perdus → ", link("récupération de compte", "https://support.discord.com/hc/requests/new"), "."]),
                    li(["Toujours bloqué après vérif → ", link("contacter le support", "https://dis.gd/request"), "."])
                ],
                "Après déverrouillage, reconnecte-toi dans l'app officielle au moins une fois avant de re-switcher.");
        }
        try {
            BdApi.UI.showConfirmationModal(title, content, {
                confirmText: "Ouvrir Discord", cancelText: "Fermer",
                onConfirm: () => this.secOpenExternal("https://discord.com/login")
            });
        } catch (e) { this.toast("Impossible d'ouvrir le guide", "error"); }
    }

    // Composant React : section « Comptes » du dashboard (unlock + gestionnaire)
    secComponent() {
        const self = this;
        const React = BdApi.React;
        const h = React.createElement;

        return function SecPanel() {
            const [unlocked, setUnlocked] = React.useState(!!self._secKey);
            const [tick, setTick] = React.useState(0);
            const reload = () => setTick(t => t + 1);
            const [pass, setPass] = React.useState("");
            const [err, setErr] = React.useState("");
            const [tokinput, setTokinput] = React.useState("");
            const [busy, setBusy] = React.useState("");
            const vaultExists = React.useMemo(() => !!self.secLoadVault(), [tick]);

            const doUnlock = async () => {
                if (!pass || pass.length < 4) { setErr("Phrase trop courte (min 4)."); return; }
                if (!self.sec_subtle()) { setErr("WebCrypto indisponible dans ce client."); return; }
                setErr("");
                let ok;
                try { ok = await self.secUnlock(pass); }
                catch (e) { setErr("Crypto: " + (e.message || e)); return; }
                if (!ok) { setErr("Phrase incorrecte."); setPass(""); return; }
                setPass("");
                setUnlocked(true);
            };

            if (!unlocked) {
                return h("div", { className: "psa-sec-unlock" }, [
                    h("div", { key: "logo", className: "psa-logo" }, (function () { const u = self.launcherIconUrl(); return u ? h("img", { src: u, alt: "" }) : "🔑"; })()),
                    h("div", { key: "t", className: "psa-sec-ut" }, ["psa", h("span", { key: "s" }, ".sec")]),
                    h("div", { key: "tag", className: "psa-sec-utag" }, "vault chiffré · aes-256"),
                    h("div", { key: "sub", className: "psa-sec-usub" }, vaultExists
                        ? "Entre ta phrase secrète pour déverrouiller le vault."
                        : "Crée une phrase secrète — elle chiffre tes tokens (AES-256). Aucune récupération possible si oubliée."),
                    h("input", {
                        key: "in", className: "psa-sec-uin", type: "password", value: pass,
                        placeholder: vaultExists ? "Phrase secrète…" : "Nouvelle phrase secrète…",
                        onChange: e => setPass(e.target.value),
                        onKeyDown: e => { if (e.key === "Enter") doUnlock(); },
                        autoFocus: true
                    }),
                    h("button", { key: "btn", className: "psa-dbtn psa-sec-ubtn", onClick: doUnlock }, vaultExists ? "Déverrouiller" : "Créer le vault"),
                    err ? h("div", { key: "err", className: "psa-sec-uerr" }, err) : null
                ]);
            }

            const cur = self.secCurrentUserId();
            const accts = self._secAccounts || [];
            const valid = accts.length;
            const deadN = accts.filter(a => a.dead).length;
            const active = accts.find(a => a.id === cur);

            const doAdd = async () => {
                const v = tokinput; if (!v.trim()) return;
                setBusy("add");
                const r = await self.secAddTokens(v, () => {});
                setBusy(""); setTokinput("");
                const parts = [];
                if (r.added) parts.push(r.added + " ajouté" + (r.added > 1 ? "s" : ""));
                if (r.dup) parts.push(r.dup + " déjà là");
                if (r.failed) parts.push(r.failed + " invalide" + (r.failed > 1 ? "s" : ""));
                self.toast(parts.join(" · ") || "Aucun token valide", r.added ? "success" : (r.failed ? "error" : "info"));
                reload();
            };
            const doCheck = async () => {
                if (!accts.length) return;
                setBusy("check");
                const r = await self.secCheckAll(() => {});
                setBusy("");
                const parts = [`${r.alive} vif${r.alive > 1 ? "s" : ""}`];
                if (r.locked) parts.push(`${r.locked} verrouillé${r.locked > 1 ? "s" : ""}`);
                if (r.disabled) parts.push(`${r.disabled} banni${r.disabled > 1 ? "s" : ""}`);
                if (r.dead) parts.push(`${r.dead} mort${r.dead > 1 ? "s" : ""}`);
                if (r.unknown) parts.push(`${r.unknown} ?`);
                self.toast(parts.join(" · "), (r.disabled || r.dead) ? "warning" : (r.locked ? "warning" : "success"));
                reload();
            };
            const doRemoveDead = () => {
                BdApi.UI.showConfirmationModal("Retirer les morts", "Supprimer les " + deadN + " compte(s) au token mort ?", {
                    danger: true, confirmText: "Retirer", cancelText: "Annuler",
                    onConfirm: () => { const n = self.secRemoveDead(); self.toast(n ? ("Retiré " + n + " mort" + (n > 1 ? "s" : "")) : "Aucun mort", "info"); reload(); },
                });
            };

            function tile(cls, label, val, cap) {
                return h("div", { key: label, className: "tile" + (cls ? " " + cls : "") }, [
                    h("div", { key: "tl", className: "tl" }, [h("div", { key: "l", className: "lab" }, label), h("div", { key: "d", className: "dot" })]),
                    h("div", { key: "v", className: "val" }, String(val)),
                    h("div", { key: "c", className: "cap" }, cap)
                ]);
            }

            function card(a) {
                const isActive = a.id === cur;
                const name = a.global || a.username;
                const handle = a.discriminator ? "#" + a.discriminator : "@" + a.username;
                const av = self.secAvatarUrl(a.id, a.avatar);
                const state = a.state || (a.dead ? "dead" : "alive");
                const locked = state === "locked";
                const banned = state === "disabled";
                const isDead = state === "dead";

                let connBtn;
                if (banned) connBtn = h("button", { key: "c", className: "psa-sec-cbtn ghost", disabled: true }, "⛔ banni");
                else if (isDead) connBtn = h("button", { key: "c", className: "psa-sec-cbtn ghost", disabled: true }, "✕ mort");
                else if (isActive) connBtn = h("button", { key: "c", className: "psa-sec-cbtn ghost", disabled: true }, "● connecté");
                else connBtn = h("button", {
                    key: "c", className: "psa-sec-cbtn primary",
                    onClick: () => BdApi.UI.showConfirmationModal("Se connecter", "Basculer sur « " + name + " » ? Discord va recharger.", {
                        confirmText: "Se connecter", cancelText: "Annuler", onConfirm: () => self.secConnect(a.token)
                    })
                }, "⭘ Se connecter");

                // Bouton GUIDE (jaune) — apparaît quand le compte est verrouillé ou banni
                const guideBtn = (locked || banned)
                    ? h("button", { key: "g", className: "psa-sec-guide", title: "Instructions de récupération", onClick: () => self.secGuide(state, a) }, "GUIDE")
                    : null;

                let statePill = null;
                if (isActive) statePill = h("span", { key: "b", className: "psa-sec-badge" }, "actif");
                else if (banned) statePill = h("span", { key: "b", className: "psa-sec-banpill" }, "banni");
                else if (locked) statePill = h("span", { key: "b", className: "psa-sec-lockpill" }, "verrouillé");
                else if (isDead) statePill = h("span", { key: "b", className: "psa-sec-deadpill" }, "token mort");

                return h("div", { key: a.id, className: "psa-sec-acc" + (isActive ? " active" : "") + ((isDead || banned) ? " dead" : "") + (locked ? " locked" : "") }, [
                    h("div", { key: "av", className: "psa-sec-av", style: av ? { backgroundImage: "url(" + av + ")" } : { background: "linear-gradient(150deg,#1c2b1a,#0a0a0c)" } },
                        h("span", { className: "psa-sec-pr " + ((isActive && !isDead && !banned) ? "online" : "off") })),
                    h("div", { key: "m", className: "psa-sec-am" }, [
                        h("div", { key: "n", className: "psa-sec-an" }, [
                            name, " ",
                            h("span", { key: "h", className: "h" }, handle),
                            statePill
                        ]),
                        h("div", { key: "s", className: "psa-sec-as" }, [
                            h("span", { key: "id", className: "psa-sec-id" }, a.id),
                            h("span", { key: "t", className: "psa-sec-tok" }, self.secMaskToken(a.token))
                        ])
                    ]),
                    h("div", { key: "aa", className: "psa-sec-aa" }, [
                        connBtn,
                        guideBtn,
                        h("button", {
                            key: "del", className: "psa-sec-icon del", title: "Supprimer",
                            onClick: () => BdApi.UI.showConfirmationModal("Supprimer le compte", "Retirer « " + name + " » du vault ?", {
                                danger: true, confirmText: "Supprimer", cancelText: "Annuler",
                                onConfirm: () => { self.secRemoveAccount(a.id); reload(); }
                            })
                        }, "✕")
                    ])
                ]);
            }

            return h("div", { key: "secwrap" }, [
                h("div", { key: "stats", className: "psa-stats", style: { gridTemplateColumns: "repeat(3,1fr)" } }, [
                    tile("", "Comptes", valid, "enregistrés"),
                    tile("brand", "Actif", active ? "1" : "0", active ? (active.global || active.username) : "aucun"),
                    tile("", "Morts", deadN, deadN ? "à retirer" : "tout vif")
                ]),
                h("div", { key: "addbar", className: "psa-sec-addbar" }, [
                    h("span", { key: "k" }, "🔑"),
                    h("textarea", {
                        key: "ta", className: "psa-sec-tokin", rows: 1, spellCheck: false, value: tokinput,
                        placeholder: "Colle un ou plusieurs tokens (un par ligne)…  ·  Ctrl+Entrée pour ajouter",
                        onChange: e => setTokinput(e.target.value),
                        onKeyDown: e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doAdd(); } }
                    }),
                    h("button", { key: "b", className: "psa-dbtn psa-sec-addbtn", disabled: busy === "add", onClick: doAdd }, busy === "add" ? "…" : "＋ Ajouter")
                ]),
                h("div", { key: "tools", className: "psa-sec-tools" }, [
                    h("button", { key: "chk", className: "psa-btn", disabled: busy === "check" || !accts.length, onClick: doCheck }, busy === "check" ? "…" : "🔄 Vérifier les tokens"),
                    deadN ? h("button", { key: "dead", className: "psa-btn danger", onClick: doRemoveDead }, "🧹 Retirer les morts (" + deadN + ")") : null,
                    h("button", { key: "lock", className: "psa-btn", onClick: () => { self._secKey = null; self._secAccounts = null; self._secSalt = null; setUnlocked(false); } }, "🔒 Verrouiller")
                ]),
                accts.length
                    ? h("div", { key: "list", className: "psa-sec-list" }, accts.map(card))
                    : h("div", { key: "empty", className: "psa-sec-empty" }, "Aucun compte. Colle un token ci-dessus."),
                h("div", { key: "note", className: "psa-sec-note" }, [
                    "🔒 Tokens chiffrés ", h("b", { key: "b" }, "AES-256"), " en local — jamais en clair, jamais partagés. Tes comptes uniquement."
                ])
            ]);
        };
    }

    mediaRoot() {
        const dir = require("path").join(this.baseDir(), "fiches");
        try { require("fs").mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
        return dir;
    }

    fichePath(userId) {
        return require("path").join(this.mediaRoot(), String(userId), "fiche.json");
    }

    migrate() {
        try {
            const fs = require("fs");
            const path = require("path");
            const dd = this.dataDir();
            const base = this.baseDir();
            const mv = (from, to) => { try { if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to); } catch (e) { /* ignore */ } };
            mv(path.join(dd, "psa_media"), path.join(base, "media"));
            mv(path.join(dd, "psa_backups"), path.join(base, "backups"));
            mv(path.join(dd, "psa-icon.png"), path.join(base, "icon.png"));
            try { for (const f of fs.readdirSync(dd)) { if (/^psa-dbg-.*\.txt$/.test(f)) mv(path.join(dd, f), path.join(base, f)); } } catch (e) { /* ignore */ }

            const fichesRoot = path.join(base, "fiches");
            fs.mkdirSync(fichesRoot, { recursive: true });
            const oldMedia = path.join(base, "media");
            if (fs.existsSync(oldMedia)) {
                for (const id of fs.readdirSync(oldMedia)) {
                    const from = path.join(oldMedia, id);
                    try { if (!fs.statSync(from).isDirectory()) continue; } catch (e) { continue; }
                    const to = path.join(fichesRoot, id);
                    fs.mkdirSync(to, { recursive: true });
                    for (const f of fs.readdirSync(from)) mv(path.join(from, f), path.join(to, f));
                    try { fs.rmdirSync(from); } catch (e) { /* ignore */ }
                }
                try { fs.rmdirSync(oldMedia); } catch (e) { /* ignore */ }
            }
            const idx = BdApi.Data.load("psa", "__index__") || [];
            for (const id of idx) {
                try {
                    const f = BdApi.Data.load("psa", String(id));
                    if (!f || !f.userId) continue;
                    const p = path.join(fichesRoot, String(id), "fiche.json");
                    if (!fs.existsSync(p)) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(f, null, 2)); }
                } catch (e) { /* ignore */ }
            }
        } catch (e) { /* ignore */ }
    }

    userDir(userId) {
        const dir = require("path").join(this.mediaRoot(), String(userId));
        try { require("fs").mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
        return dir;
    }

    extFor(url, ct) {
        const map = {
            "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif",
            "image/webp": "webp", "image/bmp": "bmp", "image/avif": "avif",
            "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/x-m4v": "m4v"
        };
        const key = (ct || "").split(";")[0].trim().toLowerCase();
        if (map[key]) return map[key];
        const m = /\.([a-z0-9]{2,4})(?:[?#]|$)/i.exec(url || "");
        return m ? m[1].toLowerCase() : "bin";
    }

    hashBuf(buf) {
        try { return require("crypto").createHash("sha256").update(buf).digest("hex"); } catch (e) { return null; }
    }

    downloadNode(url, redirects) {
        redirects = redirects || 0;
        return new Promise((resolve, reject) => {
            if (redirects > 5) return reject(new Error("too many redirects"));
            let mod, u;
            try { u = new URL(url); mod = u.protocol === "http:" ? require("http") : require("https"); }
            catch (e) { return reject(e); }
            const req = mod.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, res => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    const next = new URL(res.headers.location, url).href;
                    return this.downloadNode(next, redirects + 1).then(resolve, reject);
                }
                if (res.statusCode !== 200) { res.resume(); return reject(new Error("http " + res.statusCode)); }
                const ct = res.headers["content-type"] || "";
                const chunks = [];
                let total = 0;
                res.on("data", c => {
                    total += c.length;
                    if (total > this.MAX_BYTES) { req.destroy(); reject(new Error("too big")); return; }
                    chunks.push(c);
                });
                res.on("end", () => resolve({ buf: Buffer.concat(chunks), ct }));
                res.on("error", reject);
            });
            req.on("error", reject);
        });
    }

    async download(url) {
        let buf, ct = "";
        try {
            if (BdApi.Net && typeof BdApi.Net.fetch === "function") {
                const res = await BdApi.Net.fetch(url, { redirect: "follow" });
                ct = (res.headers && res.headers.get && res.headers.get("content-type")) || "";
                buf = Buffer.from(await res.arrayBuffer());
            } else {
                throw new Error("no BdApi.Net");
            }
        } catch (e) {
            const r = await this.downloadNode(url);
            buf = r.buf; ct = r.ct;
        }
        if (!buf || !buf.length) throw new Error("empty");
        if (buf.length > this.MAX_BYTES) throw new Error("too big");
        return { buf, mime: (ct || "").split(";")[0].trim(), ext: this.extFor(url, ct), size: buf.length };
    }

    ffmpegPath() {
        if (this._ffmpeg !== undefined) return this._ffmpeg;
        this._ffmpeg = null;
        let cp, path, fs;
        try { cp = require("child_process"); path = require("path"); fs = require("fs"); } catch (e) { return null; }
        if (!cp || typeof cp.execFileSync !== "function") return null;
        const cands = ["ffmpeg"];
        const la = process.env.LOCALAPPDATA;
        if (la) {
            cands.push(path.join(la, "Microsoft", "WinGet", "Links", "ffmpeg.exe"));
            try {
                const pkgs = path.join(la, "Microsoft", "WinGet", "Packages");
                for (const d of fs.readdirSync(pkgs)) {
                    if (!/FFmpeg/i.test(d)) continue;
                    for (const sub of fs.readdirSync(path.join(pkgs, d))) {
                        const p = path.join(pkgs, d, sub, "bin", "ffmpeg.exe");
                        if (fs.existsSync(p)) cands.push(p);
                    }
                }
            } catch (e) { /* ignore */ }
        }
        for (const c of cands) {
            try { cp.execFileSync(c, ["-version"], { stdio: "ignore", timeout: 8000 }); this._ffmpeg = c; return c; } catch (e) { /* next */ }
        }
        this._ffmpeg = null;
        return null;
    }

    remux(input, output) {
        const bin = this.ffmpegPath();
        if (!bin) return false;
        const cp = require("child_process");
        const fs = require("fs");
        try {
            cp.execFileSync(bin, ["-y", "-i", input, "-c", "copy", "-movflags", "+faststart", output], { stdio: "ignore", timeout: 120000 });
            if (fs.existsSync(output) && fs.statSync(output).size > 0) return true;
        } catch (e) { /* fall through to re-encode */ }
        try {
            cp.execFileSync(bin, ["-y", "-i", input, "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", output], { stdio: "ignore", timeout: 300000 });
            return fs.existsSync(output) && fs.statSync(output).size > 0;
        } catch (e) { return false; }
    }

    // async remux (execFile, does not block the renderer) — used by the background maintenance pass
    remuxAsync(input, output) {
        return new Promise(resolve => {
            const bin = this.ffmpegPath();
            if (!bin) return resolve(false);
            let cp, fs;
            try { cp = require("child_process"); fs = require("fs"); } catch (e) { return resolve(false); }
            const ok = () => { try { return fs.existsSync(output) && fs.statSync(output).size > 0; } catch (e) { return false; } };
            cp.execFile(bin, ["-y", "-i", input, "-c", "copy", "-movflags", "+faststart", output], { timeout: 120000 }, (err) => {
                if (!err && ok()) return resolve(true);
                cp.execFile(bin, ["-y", "-i", input, "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", output], { timeout: 300000 }, () => resolve(ok()));
            });
        });
    }

    async fetchAndStore(userId, kind, name, url) {
        return this.fetchAndStoreDir(this.userDir(userId), kind, name, url);
    }

    async fetchAndStoreDir(dir, kind, name, url) {
        const fs = require("fs");
        const path = require("path");
        try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
        const dl = await this.download(url);
        const hash = this.hashBuf(dl.buf);
        const id = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
        let file = id + "." + dl.ext;
        let abs = path.join(dir, file);
        fs.writeFileSync(abs, dl.buf);
        let mime = dl.mime;
        let size = dl.size;
        if (kind === "video" && !/\.(mp4|webm)$/i.test(file)) {
            try {
                const mp4 = id + ".mp4";
                const mp4abs = path.join(dir, mp4);
                if (this.remux(abs, mp4abs)) {
                    try { fs.unlinkSync(abs); } catch (e) { /* ignore */ }
                    file = mp4; abs = mp4abs; mime = "video/mp4";
                    try { size = fs.statSync(abs).size; } catch (e) { /* ignore */ }
                }
            } catch (e) { /* remux unavailable (renderer child_process blocked) — keep original file */ }
        }
        return { id, file, abs, mime, kind, name, size, hash, addedAt: Date.now() };
    }

    removeMediaFile(userId, m) {
        if (m && m.hash) return; // content-addressed blob is shared; reclaimed by gcBlobs when unreferenced
        const abs = this.mediaAbs(userId, m);
        if (!abs) return;
        try { require("fs").unlinkSync(abs); } catch (e) { /* ignore */ }
    }

    openExternal(userId, m) {
        const abs = this.mediaAbs(userId, m);
        if (!abs) return;
        try { require("electron").shell.openPath(abs); } catch (e) { this.toast("Open failed: " + ((e && e.message) || e), "error"); }
    }

    revealFile(userId, m) {
        const abs = this.mediaAbs(userId, m);
        if (!abs) return;
        try { require("electron").shell.showItemInFolder(abs); } catch (e) { /* ignore */ }
    }

    backupsDir() {
        const dir = require("path").join(this.baseDir(), "backups");
        try { require("fs").mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
        return dir;
    }

    createBackup() {
        const fs = require("fs");
        const path = require("path");
        let of; try { of = require("original-fs"); } catch (e) { of = fs; }
        const dir = this.backupsDir();
        const fiches = this.getIndex().map(id => this.getFiche(id)).filter(Boolean);
        const media = {};   // legacy per-file (kept for compatibility)
        const blobs = {};   // content-addressed: hash -> { ext, b64 }
        const idx = this.blobIndex();
        for (const f of fiches) {
            for (const m of (f.media || [])) {
                if (m.hash) {
                    if (blobs[m.hash]) continue;
                    const ext = m.ext || (idx[m.hash] || {}).ext;
                    try { blobs[m.hash] = { ext: ext, b64: of.readFileSync(this.blobPath(m.hash, ext), "base64") }; } catch (e) { /* skip */ }
                } else if (m.file) {
                    try { media[f.userId + "/" + m.file] = of.readFileSync(path.join(this.mediaRoot(), String(f.userId), m.file), "base64"); } catch (e) { /* skip */ }
                }
            }
        }
        const stamp = new Date().toISOString().replace(/[:T]/g, "-").replace(/\..+/, "").slice(0, 16);
        const file = path.join(dir, "psa-backup-" + stamp + ".json");
        fs.writeFileSync(file, JSON.stringify({ v: 2, at: Date.now(), fiches: fiches, media: media, blobs: blobs }));
        return file;
    }

    exportUsernames() {
        const set = new Set();
        const add = (u) => { const s = String(u == null ? "" : u).trim(); if (s) set.add(s); };
        try { for (const id of this.getIndex()) { const f = this.getFiche(id); if (!f) continue; add(f.username); add(f.identUsername); add(f.identDisplay); for (const a of (f.aliases || [])) add(a); } } catch (e) { /* ignore */ }
        try { for (const p of this.getPfp()) add(p.username); } catch (e) { /* ignore */ }
        try { for (const gid of this.getServerIndex()) { const s = this.getServer(gid); if (!s) continue; for (const ev of (s.events || [])) add(ev.authorName); } } catch (e) { /* ignore */ }
        const list = [...set].sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" }));
        const p = require("path").join(this.baseDir(), "psa-usernames.txt");
        require("fs").writeFileSync(p, list.join("\n") + (list.length ? "\n" : ""), "utf8");
        return { path: p, count: list.length };
    }

    toJpeg(src) {
        return new Promise((res) => {
            try {
                const img = new Image();
                img.onload = () => {
                    try {
                        const c = document.createElement("canvas");
                        c.width = img.naturalWidth || 256;
                        c.height = img.naturalHeight || 256;
                        const ctx = c.getContext("2d");
                        ctx.fillStyle = "#000"; ctx.fillRect(0, 0, c.width, c.height);
                        ctx.drawImage(img, 0, 0);
                        res(c.toDataURL("image/jpeg", 0.9));
                    } catch (e) { res(null); }
                };
                img.onerror = () => res(null);
                img.src = src;
            } catch (e) { res(null); }
        });
    }

    async exportPfpFolder(onProgress) {
        const fs = require("fs");
        const path = require("path");
        const outDir = path.join(this.baseDir(), "pfp-export");
        fs.mkdirSync(outDir, { recursive: true });
        const all = this.getPfp();
        let done = 0, failed = 0, i = 0;
        for (const p of all) {
            i++;
            if (typeof onProgress === "function") { try { onProgress(i, all.length); } catch (e) {} }
            try {
                const url = await this.objUrl(p, this.pfpDir());
                if (!url) { failed++; continue; }
                const jpg = await this.toJpeg(url);
                if (!jpg || jpg.indexOf(",") < 0) { failed++; continue; }
                fs.writeFileSync(path.join(outDir, String(p.userId || p.hash || i) + ".jpg"), Buffer.from(jpg.split(",")[1], "base64"));
                done++;
            } catch (e) { failed++; }
        }
        return { dir: outDir, done, failed };
    }

    latestBackup() {
        try {
            const fs = require("fs");
            const dir = this.backupsDir();
            const files = fs.readdirSync(dir).filter(f => /^psa-backup-.*\.json$/.test(f));
            if (!files.length) return null;
            files.sort();
            return require("path").join(dir, files[files.length - 1]);
        } catch (e) { return null; }
    }

    restoreBackup(file) {
        const fs = require("fs");
        const path = require("path");
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        let n = 0, mn = 0;
        for (const f of (data.fiches || [])) {
            if (f && f.userId && Array.isArray(f.media)) { this.saveFiche(f); n++; }
        }
        const media = data.media || {};
        for (const key in media) {
            try {
                const i = key.indexOf("/");
                const uid = key.slice(0, i);
                const fname = key.slice(i + 1);
                const d = path.join(this.mediaRoot(), uid);
                fs.mkdirSync(d, { recursive: true });
                fs.writeFileSync(path.join(d, fname), Buffer.from(media[key], "base64"));
                mn++;
            } catch (e) { /* skip */ }
        }
        const blobs = data.blobs || {};
        const idx = this.blobIndex();
        for (const hash in blobs) {
            try {
                const b = blobs[hash];
                const ext = b.ext;
                const abs = this.blobPath(hash, ext);
                if (!this.blobFs().existsSync(abs)) this.blobFs().writeFileSync(abs, Buffer.from(b.b64, "base64"));
                if (!idx[hash]) idx[hash] = { ext: ext, mime: this.mimeForExt("x." + ext), kind: "image", size: 0, dhash: null, ts: Date.now() };
                mn++;
            } catch (e) { /* skip */ }
        }
        this.saveBlobIndex(true);
        return { n: n, mn: mn };
    }

    openBackupsFolder() {
        try { require("electron").shell.openPath(this.backupsDir()); } catch (e) { /* ignore */ }
    }

    mimeForExt(name) {
        const e = (/\.([a-z0-9]{2,4})$/i.exec(name || "") || [])[1];
        const map = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", avif: "image/avif", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/x-m4v" };
        return map[(e || "").toLowerCase()] || "application/octet-stream";
    }

    // ---------- content-addressed blob store (dedup infaillible + chargement blob URL) ----------
    newId() { return Date.now() + "-" + Math.random().toString(36).slice(2, 8); }

    blobFs() { try { return require("original-fs"); } catch (e) { return require("fs"); } }

    blobsRoot() {
        const dir = require("path").join(this.baseDir(), "blobs");
        try { this.blobFs().mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
        return dir;
    }

    blobPath(hash, ext) {
        const h = String(hash || "");
        const sub = h.slice(0, 2) || "00";
        const dir = require("path").join(this.blobsRoot(), sub);
        try { this.blobFs().mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
        return require("path").join(dir, h + (ext ? "." + ext : ""));
    }

    blobIndex() {
        if (this._bidx) return this._bidx;
        let idx = {};
        try {
            const fs = require("fs");
            const p = require("path").join(this.blobsRoot(), "index.json");
            if (fs.existsSync(p)) { const o = JSON.parse(fs.readFileSync(p, "utf8")); if (o && typeof o === "object") idx = o; }
        } catch (e) { /* ignore */ }
        this._bidx = idx;
        return idx;
    }

    saveBlobIndex(now) {
        const write = () => {
            this._bidxT = null;
            try { require("fs").writeFileSync(require("path").join(this.blobsRoot(), "index.json"), JSON.stringify(this._bidx || {})); } catch (e) { /* ignore */ }
        };
        if (now) { if (this._bidxT) { clearTimeout(this._bidxT); this._bidxT = null; } return write(); }
        if (this._bidxT) return;
        this._bidxT = setTimeout(write, 800);
    }

    blobFileExists(hash, ext) {
        try { return this.blobFs().existsSync(this.blobPath(hash, ext)); } catch (e) { return false; }
    }

    // write buffer to store; dedup by content hash — never rewrites an existing blob
    blobPut(buf, kind, name, extHint) {
        const hash = this.hashBuf(buf);
        if (!hash) throw new Error("hash fail");
        const idx = this.blobIndex();
        const prev = idx[hash];
        if (prev && this.blobFileExists(hash, prev.ext)) {
            return { hash, ext: prev.ext, mime: prev.mime, size: prev.size, kind: prev.kind || kind, dup: true };
        }
        const ext = (extHint || this.extFor(name || "", null) || "bin").toLowerCase();
        this.blobFs().writeFileSync(this.blobPath(hash, ext), buf);
        const mime = this.mimeForExt("x." + ext);
        idx[hash] = { ext, mime, kind, size: buf.length, dhash: (prev && prev.dhash) || null, ts: Date.now() };
        this.saveBlobIndex();
        return { hash, ext, mime, size: buf.length, kind, dup: false };
    }

    normUrl(url) {
        try { const u = new URL(url); return (u.origin + u.pathname).toLowerCase(); } catch (e) { return String(url || ""); }
    }

    // download (once per identical URL) → store in blob store, remux odd videos → mp4
    async fetchToBlob(kind, name, url) {
        this._urlHash = this._urlHash || new Map();
        const nurl = this.normUrl(url);
        const cached = this._urlHash.get(nurl);
        if (cached && this.blobFileExists(cached.hash, cached.ext)) {
            const e = this.blobIndex()[cached.hash] || {};
            return { id: this.newId(), hash: cached.hash, ext: cached.ext, kind, name, mime: e.mime || cached.mime, size: e.size || 0, addedAt: Date.now() };
        }
        const dl = await this.download(url);
        let meta = this.blobPut(dl.buf, kind, name, dl.ext);
        if (kind === "video" && meta.ext && !/^(mp4|webm)$/i.test(meta.ext)) {
            try {
                const inAbs = this.blobPath(meta.hash, meta.ext);
                const tmp = inAbs.replace(/\.[a-z0-9]+$/i, "") + ".remux.mp4";
                if (this.remux(inAbs, tmp)) {
                    const buf2 = this.blobFs().readFileSync(tmp);
                    try { this.blobFs().unlinkSync(tmp); } catch (e) { /* ignore */ }
                    meta = this.blobPut(buf2, "video", (name || "video") + ".mp4", "mp4");
                }
            } catch (e) { /* keep original */ }
        }
        this._urlHash.set(nurl, { hash: meta.hash, ext: meta.ext, mime: meta.mime });
        return { id: this.newId(), hash: meta.hash, ext: meta.ext, kind, name, mime: meta.mime, size: meta.size, addedAt: Date.now() };
    }

    // resolve a media record to an absolute file: blob store first, then legacy per-folder file, then legacy abs
    resolveMediaAbs(record, legacyDir) {
        if (!record) return null;
        const fs = require("fs");
        const path = require("path");
        if (record.hash) {
            const ext = record.ext || (this.blobIndex()[record.hash] || {}).ext;
            const p = this.blobPath(record.hash, ext);
            try { if (this.blobFs().existsSync(p)) return p; } catch (e) { /* next */ }
        }
        if (legacyDir && record.file) {
            const p = path.join(legacyDir, record.file);
            try { if (fs.existsSync(p)) return p; } catch (e) { /* next */ }
        }
        if (record.abs) { try { if (fs.existsSync(record.abs)) return record.abs; } catch (e) { /* next */ } }
        return null;
    }

    // read a media record into a cached data: URL (Discord CSP blocks blob: in img/media-src), retry once, LRU-capped
    async objUrl(record, legacyDir) {
        if (record && record.dataUrl) return record.dataUrl;
        this._obj = this._obj || new Map();
        const key = (record && (record.hash || record.file || record.abs || record.url)) || "";
        if (this._obj.has(key)) { const v = this._obj.get(key); this._obj.delete(key); this._obj.set(key, v); return v; }
        const abs = this.resolveMediaAbs(record, legacyDir);
        if (!abs) return null;
        const reader = this.blobFs();
        const mime = (record.kind === "video")
            ? (record.mime || "video/mp4")
            : (record.mime || this.mimeForExt(record.ext ? ("x." + record.ext) : (record.file || abs)));
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const url = "data:" + mime + ";base64," + reader.readFileSync(abs, "base64");
                if (this._obj.size > 240) { const k0 = this._obj.keys().next().value; this._obj.delete(k0); }
                this._obj.set(key, url);
                return url;
            } catch (e) { if (attempt === 1) return null; }
        }
        return null;
    }

    revokeObjUrls() {
        try { if (this._obj) for (const u of this._obj.values()) { if (typeof u === "string" && u.indexOf("blob:") === 0) { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } } } } catch (e) { /* ignore */ }
        this._obj = new Map();
    }

    // perceptual hash (dHash 64-bit) via canvas — catches resized / re-encoded near-duplicates
    dhashFromObjUrl(url) {
        return new Promise(resolve => {
            try {
                const img = new Image();
                img.onload = () => {
                    try {
                        const W = 9, H = 8;
                        const c = document.createElement("canvas"); c.width = W; c.height = H;
                        const ctx = c.getContext("2d");
                        ctx.drawImage(img, 0, 0, W, H);
                        const d = ctx.getImageData(0, 0, W, H).data;
                        const g = [];
                        for (let i = 0; i < W * H; i++) { const o = i * 4; g.push(0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2]); }
                        let bits = "";
                        for (let y = 0; y < H; y++) for (let x = 0; x < W - 1; x++) bits += (g[y * W + x] < g[y * W + x + 1]) ? "1" : "0";
                        let hex = "";
                        for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
                        resolve(hex);
                    } catch (e) { resolve(null); }
                };
                img.onerror = () => resolve(null);
                img.src = url;
            } catch (e) { resolve(null); }
        });
    }

    hamming(a, b) {
        if (!a || !b || a.length !== b.length) return 64;
        let d = 0;
        for (let i = 0; i < a.length; i++) { let x = (parseInt(a[i], 16) || 0) ^ (parseInt(b[i], 16) || 0); while (x) { d += x & 1; x >>= 1; } }
        return d;
    }

    async ensureDhash(hash, objurl) {
        if (!hash || !objurl) return null;
        const idx = this.blobIndex();
        const e = idx[hash];
        if (!e || e.dhash || e.kind === "video") return e ? e.dhash : null;
        const dh = await this.dhashFromObjUrl(objurl);
        if (dh && idx[hash]) { idx[hash].dhash = dh; this.saveBlobIndex(); }
        return dh;
    }

    // cluster a list of {key, hash} by exact hash or near dHash (assisted dedup: badge only, no auto-delete)
    groupSimilar(records) {
        const idx = this.blobIndex();
        const THRESH = 4;
        const groups = [], assigned = {}, sizeByKey = {};
        for (let i = 0; i < records.length; i++) {
            const ri = records[i]; if (!ri || assigned[ri.key] != null) continue;
            const gi = groups.length; groups.push([ri.key]); assigned[ri.key] = gi;
            const di = ri.hash && idx[ri.hash] ? idx[ri.hash].dhash : null;
            for (let j = i + 1; j < records.length; j++) {
                const rj = records[j]; if (!rj || assigned[rj.key] != null) continue;
                if (ri.hash && rj.hash === ri.hash) { groups[gi].push(rj.key); assigned[rj.key] = gi; continue; }
                const dj = rj.hash && idx[rj.hash] ? idx[rj.hash].dhash : null;
                if (di && dj && this.hamming(di, dj) <= THRESH) { groups[gi].push(rj.key); assigned[rj.key] = gi; }
            }
        }
        for (const k in assigned) sizeByKey[k] = groups[assigned[k]].length;
        return { groups, assigned, sizeByKey };
    }

    // delete blobs no record references any more (safe reachability GC — no refcount drift)
    gcBlobs() {
        try {
            const idx = this.blobIndex();
            const used = new Set();
            const add = m => { if (m && m.hash) used.add(m.hash); };
            for (const p of this.getPfp()) add(p);
            for (const id of this.getIndex()) { const f = this.getFiche(id); if (f) for (const m of (f.media || [])) add(m); }
            for (const gid of this.getServerIndex()) { const s = this.getServer(gid); if (s) for (const ev of (s.events || [])) for (const m of (ev.media || [])) add(m); }
            let changed = false;
            for (const hash of Object.keys(idx)) {
                if (!used.has(hash)) {
                    try { this.blobFs().unlinkSync(this.blobPath(hash, idx[hash].ext)); } catch (e) { /* ignore */ }
                    delete idx[hash]; changed = true;
                }
            }
            if (changed) this.saveBlobIndex(true);
        } catch (e) { /* ignore */ }
    }

    // repoint every record from one blob hash to another (used after remux mov -> mp4)
    remapHash(oldHash, meta) {
        const upd = m => {
            if (!m || m.hash !== oldHash) return false;
            m.hash = meta.hash; m.ext = meta.ext; m.mime = meta.mime; m.kind = "video"; m.size = meta.size;
            return true;
        };
        try { const a = this.getPfp(); let ch = false; for (const p of a) if (upd(p)) ch = true; if (ch) this.savePfp(a); } catch (e) { /* ignore */ }
        try { for (const id of this.getIndex()) { const f = this.getFiche(id); if (!f) continue; let ch = false; for (const m of (f.media || [])) if (upd(m)) ch = true; if (ch) this.saveFiche(f); } } catch (e) { /* ignore */ }
        try { for (const gid of this.getServerIndex()) { const s = this.getServer(gid); if (!s) continue; let ch = false; for (const ev of (s.events || [])) for (const m of (ev.media || [])) if (upd(m)) ch = true; if (ch) this.saveServer(s); } } catch (e) { /* ignore */ }
    }

    // background: convert stored .mov (and other non-web) videos to mp4 so Chromium can play them
    async remuxLegacyVideos() {
        const idx = this.blobIndex();
        const jobs = Object.keys(idx).filter(h => idx[h] && idx[h].kind === "video" && !/^(mp4|webm)$/i.test(idx[h].ext || ""));
        if (!jobs.length || !this.ffmpegPath()) return;
        for (const oldHash of jobs) {
            const e = idx[oldHash]; if (!e) continue;
            if (!this.blobFileExists(oldHash, e.ext)) continue;
            const inAbs = this.blobPath(oldHash, e.ext);
            const out = inAbs.replace(/\.[a-z0-9]+$/i, "") + ".remux.mp4";
            let ok = false;
            try { ok = await this.remuxAsync(inAbs, out); } catch (x) { ok = false; }
            if (ok) {
                try {
                    const buf2 = this.blobFs().readFileSync(out);
                    const meta = this.blobPut(buf2, "video", "video.mp4", "mp4");
                    this.remapHash(oldHash, meta);
                    try { this.blobFs().unlinkSync(inAbs); } catch (x) { /* ignore */ }
                    if (idx[oldHash]) delete idx[oldHash];
                    this.saveBlobIndex();
                    this.bump();
                } catch (x) { /* ignore */ }
            }
            try { this.blobFs().unlinkSync(out); } catch (x) { /* ignore */ }
            await new Promise(r => setTimeout(r, 120));
        }
        this.saveBlobIndex(true);
    }

    // background: compute a perceptual hash for every image so near-duplicate grouping is complete
    async precomputeDhash() {
        const idx = this.blobIndex();
        const jobs = Object.keys(idx).filter(h => idx[h] && idx[h].kind === "image" && !idx[h].dhash);
        if (!jobs.length) return;
        let done = 0;
        for (const hash of jobs) {
            const e = idx[hash]; if (!e || e.dhash) continue;
            try {
                const url = await this.objUrl({ hash: hash, ext: e.ext, kind: "image", mime: e.mime });
                if (url) { const dh = await this.dhashFromObjUrl(url); if (dh && idx[hash]) idx[hash].dhash = dh; }
            } catch (x) { /* skip */ }
            if (++done % 24 === 0) { this.saveBlobIndex(); this.bump(); }
            await new Promise(r => setTimeout(r, 15));
        }
        this.saveBlobIndex(true);
        this.bump();
    }

    async runBlobMaintenance() {
        if (this._maintRunning) return;
        this._maintRunning = true;
        try { await this.remuxLegacyVideos(); } catch (e) { /* ignore */ }
        try { await this.precomputeDhash(); } catch (e) { /* ignore */ }
        this._maintRunning = false;
    }

    // one-time move of legacy per-folder media into the content-addressed store (auto-backup first)
    migrateToBlobs() {
        const fs = require("fs");
        const path = require("path");
        const marker = path.join(this.blobsRoot(), ".migrated");
        try { if (fs.existsSync(marker)) return; } catch (e) { return; }
        try { this.backupManifests("pre-blob"); } catch (e) { /* ignore */ }
        const bfs = this.blobFs();
        const idx = this.blobIndex();
        const migRec = (m, dir) => {
            if (!m || m.dead || !m.file) return false;
            const src = path.join(dir, m.file);
            let buf; try { buf = bfs.readFileSync(src); } catch (e) { return false; }
            const hash = this.hashBuf(buf);
            const ext = (m.file.split(".").pop() || "bin").toLowerCase();
            const dst = this.blobPath(hash, ext);
            try {
                if (!bfs.existsSync(dst)) bfs.renameSync(src, dst);
                else { try { bfs.unlinkSync(src); } catch (e) { /* ignore */ } }
            } catch (e) {
                try { bfs.writeFileSync(dst, buf); try { bfs.unlinkSync(src); } catch (e2) { /* ignore */ } }
                catch (e3) { return false; }
            }
            if (!idx[hash]) idx[hash] = { ext, mime: this.mimeForExt("x." + ext), kind: m.kind || (this.IMAGE_EXT.test(m.file) ? "image" : "video"), size: buf.length, dhash: null, ts: Date.now() };
            m.hash = hash; m.ext = ext; m.mime = idx[hash].mime; m.size = buf.length;
            delete m.file; delete m.abs;
            return true;
        };
        try {
            const arr = this.getPfp(); let ch = false;
            for (const p of arr) if (migRec(p, this.pfpDir())) ch = true;
            if (ch) this.savePfp(arr);
        } catch (e) { /* ignore */ }
        try {
            for (const id of this.getIndex()) {
                const f = this.getFiche(id); if (!f) continue; let ch = false;
                for (const m of (f.media || [])) if (migRec(m, this.userDir(id))) ch = true;
                if (ch) this.saveFiche(f);
            }
        } catch (e) { /* ignore */ }
        try {
            for (const gid of this.getServerIndex()) {
                const s = this.getServer(gid); if (!s) continue; let ch = false;
                const seen = new Set();
                for (const ev of (s.events || [])) {
                    const keep = [];
                    for (const m of (ev.media || [])) {
                        if (migRec(m, this.serverDir(gid))) ch = true;
                        if (m.hash) { if (seen.has(m.hash)) { ch = true; continue; } seen.add(m.hash); }
                        keep.push(m);
                    }
                    ev.media = keep;
                }
                s.events = (s.events || []).filter(ev => (ev.media || []).length);
                if (ch) this.saveServer(s);
            }
        } catch (e) { /* ignore */ }
        this.saveBlobIndex(true);
        try { fs.writeFileSync(marker, String(Date.now())); } catch (e) { /* ignore */ }
    }

    // snapshot the small JSON manifests before migration (media files are only moved, never deleted unless byte-dup)
    backupManifests(tag) {
        try {
            const fs = require("fs");
            const path = require("path");
            const stamp = new Date().toISOString().replace(/[:T]/g, "-").replace(/\..+/, "").slice(0, 16);
            const dir = path.join(this.backupsDir(), (tag || "bak") + "-" + stamp);
            fs.mkdirSync(dir, { recursive: true });
            const cp = (src, rel) => { try { if (fs.existsSync(src)) { const d = path.join(dir, rel); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(src, d); } } catch (e) { /* ignore */ } };
            cp(path.join(this.pfpDir(), "pfp.json"), "pfp.json");
            for (const id of this.getIndex()) cp(this.fichePath(id), path.join("fiches", String(id), "fiche.json"));
            for (const gid of this.getServerIndex()) cp(this.serverPath(gid), path.join("servers", String(gid), "server.json"));
            return dir;
        } catch (e) { return null; }
    }

    mediaAbs(userId, m) {
        return this.resolveMediaAbs(m, require("path").join(this.mediaRoot(), String(userId)));
    }

    mediaSrc(userId, m) {
        if (!m) return "";
        if (m.dataUrl) return m.dataUrl;
        const abs = this.mediaAbs(userId, m);
        if (abs) {
            try {
                const buf = require("fs").readFileSync(abs);
                const mime = m.mime || this.mimeForExt(m.file || abs);
                return "data:" + mime + ";base64," + buf.toString("base64");
            } catch (e) {
                try { console.warn("[psa] read fail", abs, e && e.message); } catch (e2) { /* ignore */ }
                return m.url || "";
            }
        }
        return m.url || "";
    }

    async saveSources(userId, username, sources) {
        const fiche = this.getFiche(userId) || this.blankFiche(userId, username);
        this.touchUsername(fiche, username);
        const res = { saved: 0, files: 0, links: 0, err: null };
        for (const s of sources) {
            try {
                const rec = await this.fetchToBlob(s.kind, s.name, s.url);
                if (rec.hash && fiche.media.some(m => m.hash === rec.hash)) continue;
                fiche.media.push(rec);
                res.saved++; res.files++;
            } catch (e) {
                res.err = (e && e.message) || String(e);
                if (fiche.media.some(m => m.url === s.url)) continue;
                fiche.media.push({ id: this.newId(), url: s.url, kind: s.kind, name: s.name, addedAt: Date.now() });
                res.saved++; res.links++;
            }
        }
        this.saveFiche(fiche);
        return res;
    }

    ficheComponent(userId) {
        const self = this;
        const React = BdApi.React;
        const h = React.createElement;

        return function Body() {
            const [fiche, setFiche] = React.useState(() => self.getFiche(userId));
            const [i, setI] = React.useState(0);
            const media = (fiche && fiche.media) || [];
            const cur = media[i];
            const created = self.createdAt(userId);
            const uname = (fiche && fiche.username) || userId;
            const avaUrl = self.avatarUrl(userId);

            const [src, setSrc] = React.useState("");
            const [err, setErr] = React.useState(false);
            React.useEffect(() => {
                let alive = true;
                (async () => {
                    setErr(false);
                    if (!cur) { setSrc(""); return; }
                    if (!cur.hash && !cur.dataUrl && cur.url && !cur.dead) {
                        try {
                            const st = await self.fetchToBlob(cur.kind, cur.name, cur.url);
                            const fresh = self.getFiche(userId);
                            const rec = fresh && fresh.media.find(x => x.id === cur.id);
                            if (rec) { delete rec.url; delete rec.file; delete rec.abs; rec.hash = st.hash; rec.ext = st.ext; rec.mime = st.mime; rec.size = st.size; self.saveFiche(fresh); }
                            cur.hash = st.hash; cur.ext = st.ext; cur.mime = st.mime; cur.size = st.size;
                        } catch (e) { /* stays a link */ }
                    }
                    if (!alive) return;
                    const out = cur.dataUrl || await self.objUrl(cur, self.userDir(userId));
                    if (!alive) return;
                    if (out) { setSrc(out); self.ensureDhash(cur.hash, out); } else { setErr(true); }
                })();
                return () => { alive = false; };
            }, [cur && cur.id]);

            function go(d) { setI(p => (p + d + media.length) % media.length); }
            function remove() {
                if (!cur) return;
                self.removeMediaFile(userId, cur);
                const next = Object.assign({}, fiche, { media: fiche.media.filter(m => m.id !== cur.id) });
                if (next.media.length === 0) {
                    self.deleteFiche(userId);
                    self.toast("Fiche emptied — deleted", "info");
                    setFiche(null);
                    return;
                }
                self.saveFiche(next);
                setFiche(next);
                setI(p => Math.max(0, Math.min(p, next.media.length - 1)));
            }

            const head = h("div", { key: "head", className: "psa-fhead" }, [
                h("div", { key: "av", className: "psa-fav" }, avaUrl ? h("img", { src: avaUrl, alt: "" }) : uname.slice(0, 1).toUpperCase()),
                h("div", { key: "meta", className: "psa-fmeta" }, [
                    h("div", { key: "n", className: "psa-fname" }, uname),
                    h("div", { key: "s", className: "psa-fsub" }, userId + " · account " + self.ago(created))
                ]),
                h("div", { key: "stat", className: "psa-fstat" }, media.length + " media · " + ((fiche && fiche.notes.length) || 0) + " notes")
            ]);

            if (!fiche) {
                return h("div", { className: "psa-fiche" }, [head, h("div", { key: "e", className: "psa-empty" }, "No fiche for this ID yet.")]);
            }

            const parts = [head];
            if (fiche.aliases.length) {
                parts.push(h("div", { key: "alias", className: "psa-alias" }, fiche.aliases.map((a, k) => h("span", { key: k, className: "p" }, "@" + a))));
            }

            let stageInner;
            if (!cur) {
                stageInner = h("div", { key: "se", className: "psa-stageempty" }, "No media saved.");
            } else if (err) {
                stageInner = h("div", { key: "sf", className: "psa-stagefail" }, [
                    h("div", { key: "ic", className: "psa-failic" }, cur.kind === "video" ? "🎬" : "🖼️"),
                    h("div", { key: "t", className: "psa-failt" }, cur.kind === "video" ? "Ce format vidéo ne se lit pas dans Discord (.mov). Ouvre-le dans ton lecteur." : "Aperçu impossible ici."),
                    h("div", { key: "b", className: "psa-failb" }, [
                        h("button", { key: "o", className: "psa-btn psa-pink", onClick: () => self.openExternal(userId, cur) }, "▶ Ouvrir dans le lecteur"),
                        h("button", { key: "f", className: "psa-btn", onClick: () => self.revealFile(userId, cur) }, "📁 Voir le fichier")
                    ])
                ]);
            } else {
                stageInner = cur.kind === "video"
                    ? h("video", { key: "v", className: "psa-stagemedia", src: src, controls: true, onError: () => setErr(true) })
                    : h("img", { key: "im", className: "psa-stagemedia", src: src, onError: () => setErr(true) });
            }
            const stageChildren = [stageInner];
            if (cur && media.length > 1) {
                stageChildren.push(h("button", { key: "l", className: "psa-pgr l", onClick: () => go(-1) }, "‹"));
                stageChildren.push(h("button", { key: "r", className: "psa-pgr r", onClick: () => go(1) }, "›"));
                stageChildren.push(h("div", { key: "c", className: "psa-counter" }, (i + 1) + " / " + media.length));
            }
            parts.push(h("div", { key: "stage", className: "psa-stage" }, stageChildren));
            if (cur) parts.push(h("div", { key: "cap", className: "psa-cap" }, cur.name || ""));

            const actions = [];
            if (cur) actions.push(h("button", { key: "o", className: "psa-btn", onClick: () => self.openExternal(userId, cur) }, "⤓ Open"));
            if (cur) actions.push(h("button", { key: "d", className: "psa-btn psa-red", onClick: remove }, "🗑 Delete"));
            if (actions.length) parts.push(h("div", { key: "act", className: "psa-factions" }, actions));

            if (fiche.notes.length) {
                parts.push(h("div", { key: "nt", className: "psa-notes-t" }, "Notes"));
                parts.push(h("div", { key: "nl" }, fiche.notes.map((n, k) => h("div", { key: k, className: "psa-note" }, n))));
            }

            const identityEl = self.renderIdentity(userId, fiche);
            if (identityEl) parts.push(identityEl);

            const presenceEl = self.renderPresence(fiche);
            if (presenceEl) parts.push(presenceEl);

            const events = (fiche.events && fiche.events.slice()) || [];
            if (events.length) {
                const delN = events.filter(e => e.kind === "deleted").length;
                const edtN = events.length - delN;
                parts.push(h("div", { key: "acth", className: "psa-acth" }, [
                    h("span", { key: "l", className: "psa-acth-l" }, ["Activity ", h("b", { key: "b" }, "// intercept log")]),
                    h("span", { key: "rule", className: "psa-acth-rule" }),
                    h("span", { key: "m", className: "psa-acth-m" }, delN + " del · " + edtN + " edit")
                ]));
                parts.push(h("div", { key: "tl", className: "psa-tl" }, events.map((ev, k) => self.renderEvent(ev, ev.id || k, userId))));
            }

            parts.push(h("div", { key: "foot", className: "psa-foot" }, self.sig()));

            return h("div", { className: "psa-fiche" }, parts);
        };
    }

    ficheDetail(userId) {
        const self = this;
        const React = BdApi.React;
        const h = React.createElement;

        function Thumb(props) {
            const m = props.m;
            const [src, setSrc] = React.useState("");
            const [err, setErr] = React.useState(false);
            React.useEffect(() => {
                let alive = true;
                (async () => {
                    const url = await self.objUrl(m, self.userDir(userId));
                    if (!alive) return;
                    if (url) { setSrc(url); self.ensureDhash(m.hash, url); } else setErr(true);
                })();
                return () => { alive = false; };
            }, [m.id]);
            const ext = (m.name && m.name.split(".").pop()) || m.kind || "";
            const kids = [h("span", { key: "k", className: "kd" }, String(ext).slice(0, 4))];
            if (src && m.kind === "video") kids.push(h("video", { key: "v", className: "psa-gmedia", src: src, muted: true, playsInline: true, preload: "metadata", onError: () => setErr(true) }));
            else if (src) kids.push(h("img", { key: "i", className: "psa-gmedia", src: src, onError: () => setErr(true) }));
            else if (!err) kids.push(h("span", { key: "l", className: "psa-gload" }, "◌"));
            return h("div", { className: "psa-gcell" + (m.kind === "video" ? " vid" : "") + (err ? " fail" : ""), onClick: () => self.openFiche(userId), title: m.name || "" }, kids);
        }

        return function Detail() {
            const [tick, setTick] = React.useState(0);
            const reload = () => setTick(t => t + 1);
            const fiche = React.useMemo(() => self.getFiche(userId), [tick]);
            const [note, setNote] = React.useState("");
            const [mpage, setMpage] = React.useState(1);
            const [epage, setEpage] = React.useState(1);
            if (!fiche) return h("div", { className: "psa-detail" }, h("div", { className: "psa-dt-empty" }, "Fiche introuvable."));

            const media = fiche.media || [];
            const events = fiche.events || [];
            const del = events.filter(e => e.kind === "deleted").length;
            const edt = events.length - del;
            const idHist = (fiche.idHistory || []).filter(x => x.kind !== "avatar");
            const avs = fiche.avatars || [];
            const idc = idHist.length + (avs.length > 1 ? avs.length - 1 : 0);
            const presence = fiche.presence || [];
            const created = self.createdAt(userId);
            const uname = fiche.identDisplay || fiche.username || userId;
            const handle = fiche.identUsername;
            const avaUrl = self.avatarUrl(userId);
            const lastStatus = (presence.find(p => p.kind === "status") || {}).status || null;
            const statusLabel = { online: "en ligne", idle: "inactif", dnd: "ne pas déranger", offline: "hors ligne" };

            function addNote() {
                const t = note.trim(); if (!t) return;
                const f = self.getFiche(userId) || self.blankFiche(userId, uname);
                if (!Array.isArray(f.notes)) f.notes = [];
                f.notes.push(t); self.saveFiche(f); setNote(""); reload();
            }
            function delNote(k) {
                const f = self.getFiche(userId);
                if (!f || !Array.isArray(f.notes)) return;
                f.notes.splice(k, 1); self.saveFiche(f); reload();
            }
            function chip(cls, label, val) {
                return h("div", { key: label, className: "psa-chip " + cls }, [
                    h("span", { key: "v", className: "cv" }, String(val)),
                    h("span", { key: "l", className: "cl" }, label)
                ]);
            }

            const header = h("div", { key: "hd", className: "psa-dhead" }, [
                h("div", { key: "av", className: "psa-dav" }, [
                    avaUrl ? h("img", { key: "i", src: avaUrl, alt: "" }) : h("span", { key: "n" }, String(uname).slice(0, 1).toUpperCase()),
                    lastStatus ? h("span", { key: "p", className: "pr " + lastStatus }) : null
                ]),
                h("div", { key: "meta", className: "psa-dhmeta" }, [
                    h("div", { key: "n", className: "psa-dname" }, [uname, handle ? h("span", { key: "h", className: "h" }, "@" + handle) : null]),
                    h("div", { key: "m", className: "psa-dmeta" }, [userId + " · compte " + self.ago(created), lastStatus ? h("span", { key: "s", className: "stt " + lastStatus }, " · ● " + (statusLabel[lastStatus] || lastStatus)) : null])
                ]),
                h("div", { key: "chips", className: "psa-chips" }, [
                    chip("med", "media", media.length),
                    chip("", "notes", fiche.notes.length),
                    chip("del", "deleted", del),
                    chip("edt", "edited", edt),
                    chip("", "identity", idc)
                ])
            ]);

            function card(key, title, count, body) {
                return h("div", { key: key, className: "psa-card" }, [
                    h("div", { key: "h", className: "psa-chd" }, [h("span", { key: "t", className: "t" }, title), count != null ? h("span", { key: "n", className: "n" }, count) : null]),
                    h("div", { key: "b", className: "psa-cbody" }, body)
                ]);
            }

            const leftCards = [];
            if (media.length) {
                const MPER = 24;
                const mpages = Math.max(1, Math.ceil(media.length / MPER));
                const mc = Math.min(mpage, mpages);
                const mslice = media.slice((mc - 1) * MPER, mc * MPER);
                leftCards.push(card("media", "Media", media.length + " fichiers", [
                    h("div", { key: "g", className: "psa-gal" }, mslice.map((m, k) => h(Thumb, { key: m.id || k, m: m }))),
                    self.pagerEl(mc, mpages, setMpage, media.length, MPER, "médias")
                ]));
            }
            if (events.length) {
                const EPER = 20;
                const epages = Math.max(1, Math.ceil(events.length / EPER));
                const ec = Math.min(epage, epages);
                const eslice = events.slice((ec - 1) * EPER, ec * EPER);
                leftCards.push(card("msg", "Messages // intercept log", del + " del · " + edt + " edit", [
                    h("div", { key: "tl", className: "psa-tl" }, eslice.map((ev, k) => self.renderEvent(ev, ev.id || k, userId))),
                    self.pagerEl(ec, epages, setEpage, events.length, EPER, "events")
                ]));
            }

            const idBody = [h("div", { key: "now", className: "psa-idnow" }, [
                h("span", { key: "l", className: "psa-idlab" }, "actuel"),
                h("div", { key: "v", className: "psa-idvcol" }, [h("div", { key: "a", className: "psa-idval" }, uname), h("div", { key: "b", className: "psa-idsub" }, handle ? "@" + handle : String(userId))])
            ])];
            if (idHist.length) idBody.push(h("div", { key: "hist", className: "psa-idhist" }, idHist.map((x, k) => h("div", { key: k, className: "psa-idrow" }, [
                h("span", { key: "k", className: "psa-idk" }, x.kind === "username" ? "username" : "display"),
                h("span", { key: "o", className: "psa-idold" }, (x.kind === "username" ? "@" : "") + (x.old || "?")),
                h("span", { key: "a", className: "psa-idarr" }, "→"),
                h("span", { key: "n", className: "psa-idnew" }, (x.kind === "username" ? "@" : "") + (x.new || "?")),
                h("span", { key: "w", className: "psa-idwhen" }, self.ago(x.ts))
            ]))));
            if (avs.length > 1) {
                const items = [];
                avs.forEach((a, k) => {
                    if (k > 0) items.push(h("span", { key: "ar" + k, className: "psa-avarr" }, "›"));
                    const url = self.avatarUrlFromHash(userId, a.hash);
                    items.push(h("div", { key: "av" + k, className: "psa-avitem" + (k === avs.length - 1 ? " cur" : "") }, [h("div", { key: "p", className: "psa-avpic" }, url ? h("img", { src: url, alt: "" }) : "∅"), h("div", { key: "d", className: "psa-avdt" }, self.ago(a.ts))]));
                });
                idBody.push(h("div", { key: "strip", className: "psa-avstrip" }, items));
            }

            const presBody = [];
            if (presence.length) {
                let curDay = null;
                presence.forEach((p, k) => {
                    const day = self.dayLabel(p.ts);
                    if (day !== curDay) { curDay = day; presBody.push(h("div", { key: "d" + k, className: "psa-pday" }, "— " + day + " —")); }
                    let ico, dot, ttl, sub, badge, when = self.hm(p.ts);
                    if (p.kind === "status") { dot = p.status || "offline"; ttl = ["Passé ", h("b", { key: "b" }, statusLabel[p.status] || p.status)]; }
                    else if (p.kind === "game") { ico = "🎮"; ttl = ["A joué à ", h("b", { key: "b" }, p.name || "?")]; if (p.start && p.end) { sub = self.hm(p.start) + " → " + self.hm(p.end); badge = self.humanDur(p.dur || 0); when = ""; } }
                    else if (p.kind === "spotify") { ico = "♫"; ttl = [h("b", { key: "b", className: "psa-spot" }, "Spotify"), " — " + (p.song || "?")]; sub = p.artist || ""; }
                    else if (p.kind === "custom") { ico = "💬"; ttl = ["Custom ", h("b", { key: "b" }, "“" + p.text + "”")]; }
                    else return;
                    const left = dot ? h("span", { key: "l", className: "psa-pdot " + dot }) : h("span", { key: "l", className: "psa-pico" + (p.kind === "spotify" ? " spot" : "") }, ico);
                    const main = [h("div", { key: "t", className: "psa-pttl" }, ttl)];
                    if (sub) main.push(h("div", { key: "s", className: "psa-psub" }, sub));
                    const row = [left, h("div", { key: "m", className: "psa-pmain" }, main)];
                    if (badge) row.push(h("span", { key: "bd", className: "psa-pdur" }, badge));
                    if (when) row.push(h("span", { key: "w", className: "psa-pwhen" }, when));
                    presBody.push(h("div", { key: "p" + k, className: "psa-prow" }, row));
                });
            } else presBody.push(h("div", { className: "psa-dt-muted" }, "Aucune activité captée."));

            const notesBody = [];
            if (fiche.notes.length) notesBody.push(h("div", { key: "list" }, fiche.notes.map((n, k) => h("div", { key: k, className: "psa-note" }, [
                h("span", { key: "t", className: "psa-note-t" }, n),
                h("button", { key: "x", className: "psa-note-del", title: "Supprimer", onClick: () => delNote(k) }, "✕")
            ]))));
            notesBody.push(h("div", { key: "add", className: "psa-noteadd" }, [
                h("input", { key: "i", className: "psa-noteinp", value: note, placeholder: "Ajouter une note…", onChange: e => setNote(e.target.value), onKeyDown: e => { if (e.key === "Enter") addNote(); } }),
                h("button", { key: "b", className: "psa-notebtn", onClick: addNote }, "Add")
            ]));

            const rightCards = [
                card("id", "Identity", idc + " chg", idBody),
                card("pres", "Presence", presence.length ? presence.length + " events" : null, presBody),
                card("notes", "Notes", fiche.notes.length, notesBody)
            ];

            return h("div", { className: "psa-detail" }, [
                header,
                h("div", { key: "grid", className: "psa-dgrid" }, [
                    h("div", { key: "l", className: "psa-dcol" }, leftCards.length ? leftCards : h("div", { className: "psa-dt-muted" }, "Aucun média ni message capté.")),
                    h("div", { key: "r", className: "psa-dcol" }, rightCards)
                ])
            ]);
        };
    }

    serverDetail(guildId) {
        const self = this;
        const React = BdApi.React;
        const h = React.createElement;

        function useMediaSrc(m) {
            const [src, setSrc] = React.useState("");
            React.useEffect(() => {
                let alive = true;
                (async () => {
                    const url = await self.objUrl(m, self.serverDir(guildId));
                    if (!alive) return;
                    if (url) { setSrc(url); self.ensureDhash(m.hash, url); } else setSrc("");
                })();
                return () => { alive = false; };
            }, [m.id]);
            return src;
        }

        function Cell(props) {
            const it = props.item; const m = it.m; const ev = it.ev;
            const src = useMediaSrc(m);
            const loc = self.locLabel(ev.channelId);
            const avaUrl = ev.authorAvatar ? self.avatarUrlFromHash(ev.authorId, ev.authorAvatar) : null;
            const ext = (m.name && m.name.split(".").pop()) || m.kind || "";
            return h("div", { className: "psa-galcell", onClick: () => props.onOpen(props.index), title: ev.content || "" }, [
                m.dead
                    ? h("span", { key: "l", className: "psa-galload", title: "Téléchargement échoué — lien Discord expiré" }, "⚠")
                    : (src ? (m.kind === "video" ? h("video", { key: "v", className: "psa-galmedia", src: src, muted: true, playsInline: true, preload: "metadata" }) : h("img", { key: "i", className: "psa-galmedia", src: src })) : h("span", { key: "l", className: "psa-galload" }, "◌")),
                h("span", { key: "tag", className: "psa-galtag" }, "deleted"),
                (props.simN > 1) ? h("span", { key: "sim", className: "psa-galtag", style: { top: 24, left: 6, background: "rgba(255,176,32,.9)", color: "#201400", fontWeight: 700 }, title: props.simN + " images similaires (SHA/perceptuel)" }, "≈" + props.simN) : null,
                h("button", { key: "del", className: "psa-galdel", title: "Supprimer ce média", onClick: e => { e.stopPropagation(); props.onDel(ev.id, m.id); } }, "✕"),
                h("span", { key: "kd", className: "psa-galkd" }, String(ext).slice(0, 4)),
                m.kind === "video" ? h("span", { key: "p", className: "psa-galplay" }, "▶") : null,
                h("div", { key: "meta", className: "psa-galmeta" }, [
                    h("div", { key: "w", className: "psa-galwho" }, [
                        h("div", { key: "a", className: "psa-galav" }, avaUrl ? h("img", { src: avaUrl, alt: "" }) : String(ev.authorName || "?").slice(0, 1).toUpperCase()),
                        h("div", { key: "n", className: "psa-galnm" }, ev.authorName || ev.authorId)
                    ]),
                    h("div", { key: "s", className: "psa-galsub" }, [
                        h("span", { key: "c", className: "ch" }, "#" + (loc.channel || "salon").replace(/^[#@]/, "")),
                        h("span", { key: "d", className: "dot" }), h("span", { key: "t" }, self.ago(ev.ts))
                    ])
                ])
            ]);
        }

        function Lightbox(props) {
            const items = props.items;
            const [idx, setIdx] = React.useState(props.start);
            const it = items[idx];
            const src = useMediaSrc(it ? it.m : { id: "none" });
            if (!it) return null;
            const m = it.m; const ev = it.ev;
            const loc = self.locLabel(ev.channelId);
            const go = d => setIdx(p => (p + d + items.length) % items.length);
            const stage = [
                src ? (m.kind === "video" ? h("video", { key: "v", className: "psa-lb-media", src: src, controls: true, autoPlay: true }) : h("img", { key: "i", className: "psa-lb-media", src: src })) : h("div", { key: "l", className: "psa-galload" }, "chargement…"),
                h("div", { key: "info", className: "psa-lb-info" }, [
                    h("span", { key: "n", className: "nm" }, ev.authorName || ev.authorId),
                    h("span", { key: "c", className: "ch" }, "#" + (loc.channel || "salon").replace(/^[#@]/, "")),
                    h("span", { key: "t", className: "tm" }, self.ago(ev.ts)),
                    ev.content ? h("span", { key: "tx", className: "tx" }, ev.content) : null,
                    items.length > 1 ? h("span", { key: "cnt", className: "cnt" }, (idx + 1) + " / " + items.length) : null
                ])
            ];
            return h("div", { className: "psa-lb", onClick: props.onClose }, [
                h("button", { key: "x", className: "psa-lb-x", onClick: props.onClose }, "✕"),
                items.length > 1 ? h("button", { key: "l", className: "psa-lb-nav l", onClick: e => { e.stopPropagation(); go(-1); } }, "‹") : null,
                items.length > 1 ? h("button", { key: "r", className: "psa-lb-nav r", onClick: e => { e.stopPropagation(); go(1); } }, "›") : null,
                h("div", { key: "stage", className: "psa-lb-stage", onClick: e => e.stopPropagation() }, stage)
            ]);
        }

        return function SrvDetail(props) {
            const [tick, setTick] = React.useState(0);
            const reload = () => setTick(t => t + 1);
            const [q, setQ] = React.useState("");
            const [filt, setFilt] = React.useState("all");
            const [lb, setLb] = React.useState(null);
            const [page, setPage] = React.useState(1);
            React.useEffect(() => { setPage(1); }, [q, filt]);
            React.useEffect(() => { let last = self._rev || 0; const iv = setInterval(() => { const r = self._rev || 0; if (r !== last) { last = r; setTick(t => t + 1); } }, 2000); return () => clearInterval(iv); }, []);
            const s = React.useMemo(() => self.getServer(guildId), [tick]);
            if (!s) return h("div", { className: "psa-detail" }, h("div", { className: "psa-dt-empty" }, "Serveur introuvable."));
            const events = s.events || [];
            const channels = new Set(events.map(e => e.channelId)).size;
            const authors = new Set(events.map(e => e.authorId)).size;
            const totalMedia = events.reduce((n, e) => n + ((e.media || []).length), 0);
            const gi = self.guildInfo(guildId);
            const icon = s.icon || gi.icon;
            const query = q.trim().toLowerCase();
            const items = [];
            for (const ev of events) {
                for (const m of (ev.media || [])) {
                    if (filt === "image" && m.kind !== "image") continue;
                    if (filt === "video" && m.kind !== "video") continue;
                    if (query) {
                        const loc = self.locLabel(ev.channelId);
                        const hay = ((ev.authorName || "") + " " + (ev.authorId || "") + " " + (ev.content || "") + " " + (loc.channel || "")).toLowerCase();
                        if (!hay.includes(query)) continue;
                    }
                    items.push({ ev: ev, m: m });
                }
            }
            const sim = self.groupSimilar(items.map(it => ({ key: it.m.id, hash: it.m.hash })));
            const shown = (filt === "sim") ? items.filter(it => (sim.sizeByKey[it.m.id] || 1) > 1) : items;
            const simTotal = items.filter(it => (sim.sizeByKey[it.m.id] || 1) > 1).length;
            const simGroups = new Set(items.filter(it => (sim.sizeByKey[it.m.id] || 1) > 1).map(it => sim.assigned[it.m.id])).size;
            const simDeletable = Math.max(0, simTotal - simGroups);
            function delDupsSim() {
                const order = items.slice().sort((a, b) => (b.ev.ts || 0) - (a.ev.ts || 0));
                const kept = {}, toDel = [];
                for (const it of order) {
                    if ((sim.sizeByKey[it.m.id] || 1) <= 1) continue;
                    const g = sim.assigned[it.m.id];
                    if (kept[g] == null) kept[g] = it.m.id; else toDel.push(it);
                }
                if (!toDel.length) return self.toast("Aucun doublon", "info");
                BdApi.UI.showConfirmationModal("Supprimer les doublons", "Supprimer " + toDel.length + " doublon(s) similaire(s) ? On garde 1 image par groupe (la plus récente). Irréversible.", {
                    danger: true, confirmText: "Supprimer " + toDel.length, cancelText: "Annuler",
                    onConfirm: () => { for (const it of toDel) self.deleteServerMedia(guildId, it.ev.id, it.m.id); self.toast("Supprimé " + toDel.length + " doublons"); reload(); }
                });
            }
            function chip(cls, val, label) { return h("div", { key: label, className: "psa-chip " + cls }, [h("span", { key: "v", className: "cv" }, String(val)), h("span", { key: "l", className: "cl" }, label)]); }
            const header = h("div", { key: "hd", className: "psa-dhead" }, [
                h("div", { key: "ic", className: "psa-shic", style: icon ? { backgroundImage: "url(" + icon + ")", backgroundSize: "cover", color: "transparent" } : { background: "linear-gradient(135deg,#153a0d,#0a0a0d)" } }, icon ? "" : String(s.name || "?").slice(0, 2).toUpperCase()),
                h("div", { key: "m", className: "psa-dhmeta" }, [
                    h("div", { key: "n", className: "psa-dname" }, s.name || String(guildId)),
                    h("div", { key: "s", className: "psa-dmeta" }, guildId + " · " + channels + " salons")
                ]),
                h("div", { key: "chips", className: "psa-chips" }, [chip("del", totalMedia, "médias"), chip("", channels, "salons"), chip("", authors, "auteurs")])
            ]);
            function filtBtn(id, label) { return h("div", { key: id, className: "psa-filt" + (filt === id ? " on" : ""), onClick: () => setFilt(id) }, label); }
            function confirmWipe() {
                BdApi.UI.showConfirmationModal("Vider le serveur", "Supprimer TOUS les médias supprimés capturés de « " + (s.name || guildId) + " » ? Irréversible.", {
                    danger: true, confirmText: "Vider", cancelText: "Annuler",
                    onConfirm: () => { self.deleteServer(guildId); self.toast("Serveur vidé"); if (props && props.onExit) props.onExit(); }
                });
            }
            const onDel = (evId, mid) => { self.deleteServerMedia(guildId, evId, mid); reload(); };
            const toolbar = h("div", { key: "tb", className: "psa-srv-tb" }, [
                h("input", { key: "s", className: "psa-srv-search", value: q, placeholder: "Chercher auteur, salon, ID…", onChange: e => setQ(e.target.value) }),
                filtBtn("all", "Tous"), filtBtn("image", "🖼 Images"), filtBtn("video", "🎬 Vidéos"),
                simTotal ? filtBtn("sim", "≈ Similaires (" + simTotal + ")") : null,
                simDeletable ? h("button", { key: "ddup", className: "psa-srv-delbtn", onClick: delDupsSim, title: "Supprimer les doublons (garde 1 par groupe)" }, "🧹 Doublons (" + simDeletable + ")") : null,
                h("button", { key: "wipe", className: "psa-srv-delbtn", onClick: confirmWipe, title: "Vider ce serveur" }, "🗑 Vider")
            ]);
            const PER = 48;
            const pages = Math.max(1, Math.ceil(shown.length / PER));
            const cur = Math.min(page, pages);
            const pageItems = shown.slice((cur - 1) * PER, cur * PER);
            const gallery = shown.length
                ? h("div", { key: "g", className: "psa-galgrid" }, pageItems.map((it, i) => h(Cell, { key: (it.m && it.m.id) || i, item: it, index: (cur - 1) * PER + i, simN: (sim.sizeByKey[it.m.id] || 1), onOpen: setLb, onDel: onDel })))
                : h("div", { key: "e", className: "psa-dt-muted", style: { padding: 18 } }, totalMedia ? "Aucun résultat." : "Aucun média supprimé capté sur ce serveur.");
            return h("div", { className: "psa-detail" }, [
                header, toolbar, gallery,
                self.pagerEl(cur, pages, setPage, shown.length, PER, "médias"),
                lb != null ? h(Lightbox, { key: "lb" + lb, items: shown, start: lb, onClose: () => setLb(null) }) : null
            ]);
        };
    }

    pfpComponent() {
        const self = this;
        const React = BdApi.React;
        const h = React.createElement;
        function useSrc(p) {
            const [src, setSrc] = React.useState("");
            React.useEffect(() => {
                let alive = true;
                (async () => {
                    const url = await self.objUrl(p, self.pfpDir());
                    if (!alive) return;
                    if (url) { setSrc(url); self.ensureDhash(p.hash, url); } else setSrc("");
                })();
                return () => { alive = false; };
            }, [p.id]);
            return src;
        }
        function Cell(props) {
            const p = props.p; const src = useSrc(p);
            return h("div", { className: "psa-galcell", onClick: () => props.onOpen(props.index), title: (p.username || "") + " · " + p.userId }, [
                src ? h("img", { key: "i", className: "psa-galmedia", src: src }) : h("span", { key: "l", className: "psa-galload" }, "◌"),
                p.gif ? h("span", { key: "g", className: "psa-galgif" }, "gif") : null,
                (props.simN > 1) ? h("span", { key: "sim", className: "psa-galtag", style: { top: 6, left: 6, background: "rgba(255,176,32,.9)", color: "#201400", fontWeight: 700 }, title: props.simN + " avatars similaires" }, "≈" + props.simN) : null,
                h("button", { key: "d", className: "psa-galdel", title: "Supprimer", onClick: e => { e.stopPropagation(); props.onDel(p.id); } }, "✕"),
                h("div", { key: "m", className: "psa-galmeta" }, [
                    h("div", { key: "n", className: "psa-galnm" }, p.username || p.userId),
                    h("div", { key: "s", className: "psa-galsub" }, [h("span", { key: "id", className: "pid" }, String(p.userId).slice(0, 8) + "…"), h("span", { key: "d", className: "dot" }), h("span", { key: "t", className: "s" }, self.ago(p.ts))])
                ])
            ]);
        }
        function Lightbox(props) {
            const items = props.items;
            const [idx, setIdx] = React.useState(props.start);
            const it = items[idx];
            const src = useSrc(it || { id: "none", file: "" });
            if (!it) return null;
            const go = d => setIdx(p => (p + d + items.length) % items.length);
            return h("div", { className: "psa-lb", onClick: props.onClose }, [
                h("button", { key: "x", className: "psa-lb-x", onClick: props.onClose }, "✕"),
                items.length > 1 ? h("button", { key: "l", className: "psa-lb-nav l", onClick: e => { e.stopPropagation(); go(-1); } }, "‹") : null,
                items.length > 1 ? h("button", { key: "r", className: "psa-lb-nav r", onClick: e => { e.stopPropagation(); go(1); } }, "›") : null,
                h("div", { key: "stage", className: "psa-lb-stage", onClick: e => e.stopPropagation() }, [
                    src ? h("img", { key: "i", className: "psa-lb-media", src: src }) : h("div", { key: "l", className: "psa-galload" }, "chargement…"),
                    h("div", { key: "info", className: "psa-lb-info" }, [
                        h("span", { key: "n", className: "nm" }, it.username || it.userId),
                        h("span", { key: "c", className: "ch" }, it.userId),
                        h("span", { key: "t", className: "tm" }, "vu " + self.ago(it.ts)),
                        items.length > 1 ? h("span", { key: "cnt", className: "cnt" }, (idx + 1) + " / " + items.length) : null
                    ])
                ])
            ]);
        }
        return function Pfp() {
            const [tick, setTick] = React.useState(0);
            const reload = () => setTick(t => t + 1);
            React.useEffect(() => { let last = self._rev || 0; const iv = setInterval(() => { const r = self._rev || 0; if (r !== last) { last = r; setTick(t => t + 1); } }, 2000); return () => clearInterval(iv); }, []);
            const [q, setQ] = React.useState("");
            const [sort, setSort] = React.useState("recent");
            const [simOnly, setSimOnly] = React.useState(false);
            const [lb, setLb] = React.useState(null);
            const [page, setPage] = React.useState(1);
            React.useEffect(() => { setPage(1); }, [q, sort, simOnly]);
            const all = React.useMemo(() => self.getPfp(), [tick]);
            const persons = new Set(all.map(p => p.userId)).size;
            const today = all.filter(p => (Date.now() - (p.ts || 0)) < 86400000).length;
            const query = q.trim().toLowerCase();
            let list = query ? all.filter(p => (p.username || "").toLowerCase().includes(query) || String(p.userId || "").includes(query)) : all.slice();
            if (sort === "name") list.sort((a, b) => (a.username || "").localeCompare(b.username || ""));
            else list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
            const sim = self.groupSimilar(list.map(p => ({ key: p.id, hash: p.hash })));
            const simTotal = list.filter(p => (sim.sizeByKey[p.id] || 1) > 1).length;
            const simGroups = new Set(list.filter(p => (sim.sizeByKey[p.id] || 1) > 1).map(p => sim.assigned[p.id])).size;
            const simDeletable = Math.max(0, simTotal - simGroups);
            const shown = simOnly ? list.filter(p => (sim.sizeByKey[p.id] || 1) > 1) : list;
            function delDupsSim() {
                const order = list.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
                const kept = {}, toDel = [];
                for (const pp of order) { if ((sim.sizeByKey[pp.id] || 1) <= 1) continue; const g = sim.assigned[pp.id]; if (kept[g] == null) kept[g] = pp.id; else toDel.push(pp.id); }
                if (!toDel.length) return self.toast("Aucun doublon", "info");
                BdApi.UI.showConfirmationModal("Supprimer les doublons", "Supprimer " + toDel.length + " avatar(s) similaire(s) ? On garde 1 par groupe (le plus récent).", {
                    danger: true, confirmText: "Supprimer " + toDel.length, cancelText: "Annuler",
                    onConfirm: () => { for (const id of toDel) self.deletePfp(id); self.toast("Supprimé " + toDel.length + " doublons"); reload(); }
                });
            }
            function tile(label, val, cap) { return h("div", { key: label, className: "tile" }, [h("div", { key: "l", className: "lab" }, label), h("div", { key: "v", className: "val" }, String(val)), h("div", { key: "c", className: "cap" }, cap)]); }
            const stats = h("div", { key: "st", className: "psa-stats", style: { gridTemplateColumns: "repeat(3,1fr)" } }, [
                tile("Pfp", all.length, "avatars uniques"), tile("Personnes", persons, "IDs distincts"), tile("Aujourd'hui", today, "nouvelles")
            ]);
            const toolbar = h("div", { key: "tb", className: "psa-srv-tb" }, [
                h("input", { key: "s", className: "psa-srv-search", value: q, placeholder: "Chercher nom ou ID…", onChange: e => setQ(e.target.value) }),
                h("div", { key: "so", className: "psa-filt" + (sort === "recent" ? " on" : ""), onClick: () => setSort("recent") }, "Récent"),
                h("div", { key: "sn", className: "psa-filt" + (sort === "name" ? " on" : ""), onClick: () => setSort("name") }, "A–Z"),
                simTotal ? h("div", { key: "sm", className: "psa-filt" + (simOnly ? " on" : ""), onClick: () => setSimOnly(v => !v) }, "≈ Similaires (" + simTotal + ")") : null,
                simDeletable ? h("button", { key: "ddup", className: "psa-srv-delbtn", onClick: delDupsSim, title: "Supprimer les doublons (garde 1 par groupe)" }, "🧹 Doublons (" + simDeletable + ")") : null,
                all.length ? h("button", { key: "wipeall", className: "psa-srv-delbtn", onClick: wipeAll, title: "Supprimer tous les avatars captés" }, "🗑 Tout vider") : null
            ]);
            const onDel = id => { self.deletePfp(id); reload(); };
            function wipeAll() {
                if (!all.length) return;
                BdApi.UI.showConfirmationModal("Tout supprimer", "Supprimer les " + all.length + " avatars captés ? Irréversible.", {
                    danger: true, confirmText: "Tout supprimer (" + all.length + ")", cancelText: "Annuler",
                    onConfirm: () => { self.deleteAllPfp(); self.toast("Pfp vidés"); setSimOnly(false); setPage(1); reload(); }
                });
            }
            const PER = 48;
            const pages = Math.max(1, Math.ceil(shown.length / PER));
            const cur = Math.min(page, pages);
            const pageItems = shown.slice((cur - 1) * PER, cur * PER);
            const grid = shown.length
                ? h("div", { key: "g", className: "psa-galgrid" }, pageItems.map((p, i) => h(Cell, { key: p.id, p: p, index: (cur - 1) * PER + i, simN: (sim.sizeByKey[p.id] || 1), onOpen: setLb, onDel: onDel })))
                : h("div", { key: "e", className: "psa-dt-muted", style: { padding: 18 } }, all.length ? "Aucun résultat." : "Aucune pfp captée. Reste sur Discord — les avatars des gens croisés s'archivent ici.");
            return h("div", { className: "psa-detail" }, [stats, toolbar, grid, self.pagerEl(cur, pages, setPage, shown.length, PER, "avatars"), lb != null ? h(Lightbox, { key: "lb" + lb, items: shown, start: lb, onClose: () => setLb(null) }) : null]);
        };
    }

    openFiche(userId) {
        this.openBigModal(BdApi.React.createElement(this.ficheComponent(userId)), "📖 Fiche");
    }

    openNote(userId, username) {
        const self = this;
        const React = BdApi.React;
        const h = React.createElement;
        const box = { value: "" };

        function Body() {
            const [v, setV] = React.useState("");
            return h("div", { className: "psa-fiche", style: { minWidth: 380 } }, [
                h("input", {
                    key: "in",
                    className: "psa-input",
                    autoFocus: true,
                    value: v,
                    placeholder: "Add a note…",
                    onChange: e => { setV(e.target.value); box.value = e.target.value; }
                }),
                h("div", { key: "brand", className: "psa-foot" }, self.sig())
            ]);
        }

        BdApi.UI.showConfirmationModal("📝 Add note — " + username, h(Body), {
            confirmText: "Save",
            cancelText: "Cancel",
            onConfirm: () => {
                const text = box.value.trim();
                if (!text) return;
                const fiche = self.getFiche(userId) || self.blankFiche(userId, username);
                self.touchUsername(fiche, username);
                fiche.notes.push(text);
                self.saveFiche(fiche);
                self.toast("Note added");
            }
        });
    }

    dashboardComponent(showHeader) {
        const self = this;
        const React = BdApi.React;
        const h = React.createElement;

        return function Dashboard() {
            const [query, setQuery] = React.useState("");
            const [tick, setTick] = React.useState(0);
            const reload = () => setTick(t => t + 1);
            React.useEffect(() => { let last = self._rev || 0; const iv = setInterval(() => { const r = self._rev || 0; if (r !== last) { last = r; setTick(t => t + 1); } }, 2000); return () => clearInterval(iv); }, []);

            const [sort, setSort] = React.useState("newest");
            const [section, setSection] = React.useState("overview");
            const [fpage, setFpage] = React.useState(1);
            React.useEffect(() => { setFpage(1); }, [query, sort, section]);
            const [viewUser, setViewUser] = React.useState(null);
            const [serverView, setServerView] = React.useState(null);

            const base = React.useMemo(() => {
                const ids = self.getIndex();
                return ids.map(id => self.getFiche(id)).filter(Boolean);
            }, [tick]);

            const servers = React.useMemo(() => {
                return self.getServerIndex().map(gid => self.getServer(gid)).filter(Boolean).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
            }, [tick]);

            const FicheComp = React.useMemo(() => viewUser ? self.ficheDetail(viewUser) : null, [viewUser]);
            const SrvComp = React.useMemo(() => serverView ? self.serverDetail(serverView) : null, [serverView]);
            const PfpComp = React.useMemo(() => self.pfpComponent(), []);
            const SecComp = React.useMemo(() => self.secComponent(), []);

            const all = React.useMemo(() => {
                const list = base.slice();
                if (sort === "media") list.sort((a, b) => b.media.length - a.media.length);
                else if (sort === "name") list.sort((a, b) => (a.username || a.userId).localeCompare(b.username || b.userId));
                else list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
                return list;
            }, [base, sort]);

            const q = query.trim().toLowerCase();
            const filtered = q
                ? all.filter(f => (f.username || "").toLowerCase().includes(q) || f.userId.includes(q))
                : all;

            const totalMedia = all.reduce((s, f) => s + f.media.length, 0);
            const totalNotes = all.reduce((s, f) => s + f.notes.length, 0);
            const evCount = (f, k) => ((f.events || []).filter(e => e.kind === k).length);
            const totalDeleted = all.reduce((s, f) => s + evCount(f, "deleted"), 0);
            const totalEdited = all.reduce((s, f) => s + evCount(f, "edited"), 0);
            const bytes = React.useMemo(() => self.diskUsage(), [tick]);
            const sortLabel = sort === "media" ? "Média" : sort === "name" ? "Nom A–Z" : "Récent";
            function cycleSort() { setSort(s => s === "newest" ? "media" : s === "media" ? "name" : "newest"); }

            function statCard(brand, ico, label, val, sub) {
                return h("div", { key: label, className: "tile" + (brand ? " brand" : "") }, [
                    h("div", { key: "tl", className: "tl" }, [
                        h("div", { key: "l", className: "lab" }, label),
                        h("div", { key: "d", className: "dot" })
                    ]),
                    h("div", { key: "v", className: "val" }, String(val)),
                    h("div", { key: "c", className: "cap" }, sub)
                ]);
            }

            function confirmDelete(f) {
                BdApi.UI.showConfirmationModal("Delete fiche", "Delete " + (f.username || f.userId) + " and all its media?", {
                    danger: true, confirmText: "Delete", cancelText: "Cancel",
                    onConfirm: () => { self.deleteFiche(f.userId); self.toast("Deleted"); reload(); }
                });
            }

            function exportAll() {
                if (!all.length) return self.toast("Nothing to export", "info");
                const json = JSON.stringify({ v: 1, fiches: all });
                if (self.copyText(json)) self.toast("Exported " + all.length + " fiches to clipboard");
                else self.toast("Export failed", "error");
            }

            function importAll() {
                let parsed;
                try {
                    parsed = JSON.parse(self.readText());
                } catch (e) {
                    return self.toast("Import failed — clipboard is not valid psa JSON", "error");
                }
                const arr = (parsed && parsed.fiches) || [];
                let n = 0;
                for (const f of arr) {
                    if (f && f.userId && Array.isArray(f.media)) { self.saveFiche(f); n++; }
                }
                self.toast("Imported " + n + " fiches");
                reload();
            }

            function avatarNode(f) {
                const url = self.avatarUrl(f.userId);
                return url ? h("img", { key: "img", src: url, alt: "" }) : h("span", { key: "ini" }, (f.username || f.userId).slice(0, 1).toUpperCase());
            }
            function lastStatus(f) {
                const p = (f.presence || []).find(x => x.kind === "status");
                return p ? p.status : null;
            }
            function idChanges(f) {
                const hh = (f.idHistory || []).filter(x => x.kind !== "avatar").length;
                const aa = (f.avatars && f.avatars.length > 1) ? f.avatars.length - 1 : 0;
                return hh + aa;
            }

            function rowEl(f) {
                const hasMedia = f.media.length > 0;
                const st = lastStatus(f);
                const del = evCount(f, "deleted");
                const edt = evCount(f, "edited");
                const idc = idChanges(f);
                const nameLine = [f.username || f.userId];
                if (idc) nameLine.push(h("span", { key: "c", className: "idchip", title: idc + " changements d'identité" }, "@" + idc));
                return h("tr", { key: f.userId }, [
                    h("td", { key: "n" }, h("div", { className: "who" }, [
                        h("div", { key: "av", className: "av" }, [avatarNode(f), st ? h("span", { key: "p", className: "rpres " + st }) : null]),
                        h("div", { key: "m", className: "m" }, [
                            h("div", { key: "n", className: "n" }, nameLine),
                            h("div", { key: "id", className: "id" }, f.userId)
                        ])
                    ])),
                    h("td", { key: "me", className: "num" }, String(f.media.length)),
                    h("td", { key: "no", className: "num dim" }, String(f.notes.length)),
                    h("td", { key: "de", className: "num" }, del ? h("span", { className: "cnt del" }, String(del)) : h("span", { className: "dim" }, "0")),
                    h("td", { key: "ed", className: "num" }, edt ? h("span", { className: "cnt edt" }, String(edt)) : h("span", { className: "dim" }, "0")),
                    h("td", { key: "ls", className: "dim" }, self.ago(f.updatedAt)),
                    h("td", { key: "st" }, hasMedia
                        ? h("span", { className: "pill g" }, [h("span", { key: "d", className: "d" }), f.media.length + " media"])
                        : h("span", { className: "pill a" }, "notes only")),
                    h("td", { key: "ac" }, h("div", { className: "acts" }, [
                        h("button", { key: "v", className: "ibtn", title: "View", onClick: () => setViewUser(f.userId) }, "👁"),
                        h("button", { key: "d", className: "ibtn del", title: "Delete", onClick: () => confirmDelete(f) }, "🗑")
                    ]))
                ]);
            }

            const FPER = 14;
            const fpages = Math.max(1, Math.ceil(filtered.length / FPER));
            const fcur = Math.min(fpage, fpages);
            const pageFiches = filtered.slice((fcur - 1) * FPER, fcur * FPER);
            const bodyRows = filtered.length
                ? pageFiches.map(rowEl)
                : [h("tr", { key: "empty" }, h("td", { colSpan: 8 }, h("div", { className: "empty" }, base.length ? "Aucun résultat." : "Aucune fiche. Clic-droit sur un message → Enregistrer dans une fiche.")))];

            const cw = ["27%", "8%", "8%", "8%", "8%", "12%", "17%", "12%"];
            const table = h("table", {}, [
                h("colgroup", { key: "cg" }, cw.map((w, k) => h("col", { key: k, style: { width: w } }))),
                h("thead", { key: "th" }, h("tr", {}, [
                    h("th", { key: 1 }, "Nom"), h("th", { key: 2 }, "Média"), h("th", { key: 3 }, "Notes"),
                    h("th", { key: 4 }, "Suppr."), h("th", { key: 5 }, "Édit."),
                    h("th", { key: 6 }, "Vu"), h("th", { key: 7 }, "Statut"), h("th", { key: 8, className: "r" }, "Actions")
                ])),
                h("tbody", { key: "tb" }, bodyRows)
            ]);

            function closeModal() {
                try {
                    const b = document.querySelector(".bd-modal-footer .bd-button") || document.querySelector(".bd-modal-footer button");
                    if (b) { b.click(); return; }
                } catch (e) { /* ignore */ }
                try { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, which: 27, bubbles: true })); } catch (e) { /* ignore */ }
            }

            function navItem(id, ic, label) {
                return h("div", { key: id, className: (!viewUser && !serverView && section === id) ? "psa-sitem on" : "psa-sitem", onClick: () => { setViewUser(null); setServerView(null); setSection(id); } }, [
                    h("span", { key: "i", className: "psa-sitem-ic psa-mi" }, ic), h("span", { key: "l" }, label)
                ]);
            }

            const side = h("div", { key: "side", className: "psa-side" }, [
                h("div", { key: "brand", className: "psa-brand" }, [
                    h("div", { key: "l", className: "psa-logo" }, (function () { const u = self.launcherIconUrl(); return u ? h("img", { src: u, alt: "" }) : "📓"; })()),
                    h("div", { key: "t" }, [h("div", { key: "a", className: "psa-bt" }, "psa"), h("div", { key: "b", className: "psa-bs" }, "le monde chico")])
                ]),
                h("input", { key: "s", className: "psa-side-search", value: query, placeholder: "Rechercher…", onChange: e => setQuery(e.target.value) }),
                h("div", { key: "g1", className: "psa-grp" }, "Archive"),
                navItem("overview", "grid_view", "Vue d'ensemble"),
                navItem("fiches", "folder_shared", "Fiches"),
                navItem("servers", "dns", "Serveurs"),
                navItem("pfp", "account_circle", "Avatars"),
                h("div", { key: "g2", className: "psa-grp" }, "Comptes"),
                navItem("sec", "vpn_key", "Comptes"),
                h("div", { key: "g3", className: "psa-grp" }, "Système"),
                navItem("settings", "tune", "Réglages"),
                h("div", { key: "f", className: "psa-side-foot" }, self.sig())
            ]);

            const panelEl = h("div", { key: "panel", className: "psa-panel" }, [
                h("div", { key: "ph", className: "psa-phead" }, [
                    h("div", { key: "l" }, [
                        h("div", { key: "t", className: "psa-pt" }, section === "overview" ? "Fiches récentes" : "Toutes les fiches"),
                        h("div", { key: "s", className: "psa-ps" }, all.length + " suivies")
                    ]),
                    h("div", { key: "tools", className: "psa-fld" }, [
                        h("input", { key: "se", className: "psa-fs", value: query, placeholder: "Nom ou ID…", onChange: e => setQuery(e.target.value) }),
                        h("div", { key: "so", className: "psa-sort", onClick: cycleSort }, ["Tri : ", h("b", { key: "b" }, sortLabel), " ▾"])
                    ])
                ]),
                h("div", { key: "tw", className: "psa-twrap" }, table),
                self.pagerEl(fcur, fpages, setFpage, filtered.length, FPER, "fiches")
            ]);

            const titles = { overview: "Vue d'ensemble", fiches: "Fiches", servers: "Serveurs", pfp: "Avatars", sec: "Comptes", settings: "Réglages" };
            const subs = { overview: "Ton registre local en un coup d'œil.", fiches: all.length + " identifiants suivis", servers: "Médias supprimés captés sur tes serveurs, stockés en local et dédupliqués.", pfp: "Tous les avatars croisés — image ou gif brut, sans doublon.", sec: "Tes comptes. Connecte-toi en un clic, ajoute ou retire des tokens. Vault chiffré en local.", settings: "Diagnostics et infos." };
            const eyebrows = { overview: "Registre local", fiches: "Registre local", servers: "Intercept log", pfp: "Galerie", sec: "Vault chiffré", settings: "Système" };

            function serverCard(s) {
                const gi = self.guildInfo(s.guildId);
                const icon = s.icon || gi.icon;
                const ev = s.events || [];
                const chans = new Set(ev.map(e => e.channelId)).size;
                return h("div", { key: s.guildId, className: "psa-srvcard", onClick: () => setServerView(s.guildId) }, [
                    h("div", { key: "ic", className: "psa-srvic", style: icon ? { backgroundImage: "url(" + icon + ")", backgroundSize: "cover", color: "transparent" } : { background: "linear-gradient(135deg,#153a0d,#0a0a0d)" } }, [
                        icon ? "" : String(s.name || "?").slice(0, 2).toUpperCase(),
                        h("span", { key: "d", className: "psa-srvic-dot" })
                    ]),
                    h("div", { key: "m", className: "psa-srvcard-m" }, [
                        h("div", { key: "n", className: "psa-srvcard-n" }, s.name || String(s.guildId)),
                        h("div", { key: "s", className: "psa-srvcard-s" }, chans + " salons · " + self.ago(s.updatedAt))
                    ]),
                    h("div", { key: "c", className: "psa-srvcard-c" }, [
                        h("div", { key: "n", className: "n" }, String(ev.length)),
                        h("div", { key: "x", className: "x" }, "del")
                    ])
                ]);
            }
            const totalSrvDel = servers.reduce((n, s) => n + ((s.events || []).length), 0);
            const todaySrvDel = servers.reduce((n, s) => n + ((s.events || []).filter(e => (Date.now() - e.ts) < 86400000).length), 0);
            const serversList = [
                h("div", { key: "stats", className: "psa-stats", style: { gridTemplateColumns: "repeat(3,1fr)" } }, [
                    statCard(false, "🖥️", "Serveurs", servers.length, "avec activité"),
                    statCard(false, "🗑", "Supprimés", totalSrvDel, "images & vidéos"),
                    statCard(false, "⏱", "Aujourd'hui", todaySrvDel, "dernières 24h")
                ]),
                servers.length
                    ? h("div", { key: "grid", className: "psa-srvgrid" }, servers.map(serverCard))
                    : h("div", { key: "empty", className: "psa-panel psa-spad", style: { color: "var(--muted)" } }, "Aucun média supprimé capté. Reste sur Discord — les images & vidéos supprimées de tes serveurs apparaîtront ici.")
            ];

            const cfg = self.cfg();
            function toggleRow(key, label, desc) {
                const on = !!cfg[key];
                return h("div", { key: key, className: "psa-tgl", onClick: () => { self.saveCfg({ [key]: !on }); reload(); } }, [
                    h("div", { key: "tx", className: "psa-tgl-tx" }, [
                        h("div", { key: "l", className: "psa-tgl-l" }, label),
                        h("div", { key: "d", className: "psa-tgl-d" }, desc)
                    ]),
                    h("div", { key: "sw", className: "psa-switch" + (on ? " on" : "") }, h("span", { key: "k", className: "knob" }))
                ]);
            }
            const loggerOn = !!self._disp && !!cfg.logger;
            const loggerPanel = h("div", { key: "logp", className: "psa-panel psa-spad", style: { marginBottom: 16 } }, [
                h("div", { key: "h", className: "psa-spanel-h" }, [
                    h("div", { key: "t", className: "psa-pt" }, "Message logging"),
                    h("div", { key: "st", className: "psa-status" + (loggerOn ? " on" : "") }, [h("span", { key: "d", className: "d" }), loggerOn ? "actif" : "inactif"])
                ]),
                h("div", { key: "d", className: "psa-about" }, "Capture messages supprimés/édités, pseudos/avatars et présence (statut, jeux, Spotify) des IDs en fiche. Client-side — seulement ce que ton compte reçoit, serveurs/DM partagés, Discord ouvert."),
                toggleRow("logger", "Logger complet", "Messages + identité + présence → fiche"),
                toggleRow("notify", "Toast en direct", "Notif quand une cible supprime ou édite"),
                toggleRow("servers", "Serveurs — médias supprimés", "Capture les images & vidéos supprimées de tous tes serveurs"),
                toggleRow("pfp", "Pfp — photos de profil", "Archive les avatars des gens que tu croises (dédup)")
            ]);

            const uiPanel = h("div", { key: "uip", className: "psa-panel psa-spad", style: { marginBottom: 16 } }, [
                h("div", { key: "t", className: "psa-pt" }, "Interface"),
                h("div", { key: "d", className: "psa-about" }, "Options d'affichage du plugin."),
                toggleRow("intro", "Intro à l'ouverture", "Joue l'anim du logo psa quand tu ouvres le dashboard")
            ]);

            const backupPanel = h("div", { key: "bkp", className: "psa-panel psa-spad", style: { marginBottom: 16 } }, [
                h("div", { key: "t", className: "psa-pt" }, "Backup"),
                h("div", { key: "d", className: "psa-about" }, "Sauvegarde complète (fiches + médias) dans un fichier. La restauration fusionne dans ta registry actuelle."),
                h("div", { key: "btns", style: { display: "flex", gap: 8, flexWrap: "wrap" } }, [
                    h("button", { key: "mk", className: "psa-dbtn", onClick: () => { try { const f = self.createBackup(); self.toast("Backup créé → " + f.split(/[\\/]/).pop()); } catch (e) { self.toast("Backup failed: " + ((e && e.message) || e), "error"); } } }, "💾 Créer un backup"),
                    h("button", { key: "rs", className: "psa-dbtn", onClick: () => { const f = self.latestBackup(); if (!f) return self.toast("Aucun backup trouvé", "info"); BdApi.UI.showConfirmationModal("Restaurer", "Restaurer la dernière sauvegarde (" + f.split(/[\\/]/).pop() + ") ? Fusionne dans ta registry.", { confirmText: "Restaurer", cancelText: "Annuler", onConfirm: () => { try { const r = self.restoreBackup(f); self.toast("Restauré: " + r.n + " fiches, " + r.mn + " médias"); reload(); } catch (e) { self.toast("Restore failed: " + ((e && e.message) || e), "error"); } } }); } }, "↺ Restaurer (dernier)"),
                    h("button", { key: "of", className: "psa-dbtn", onClick: () => self.openBackupsFolder() }, "📁 Dossier backups"),
                    h("button", { key: "un", className: "psa-dbtn", onClick: () => { try { const r = self.exportUsernames(); self.toast("Pseudos exportés (" + r.count + ") → " + r.path.split(/[\\/]/).pop()); try { require("electron").shell.openPath(r.path); } catch (e) { /* ignore */ } } catch (e) { self.toast("Export failed: " + ((e && e.message) || e), "error"); } } }, "📝 Pseudos (.txt)"),
                    h("button", { key: "pf", className: "psa-dbtn", onClick: async (e) => { const btn = e.currentTarget; btn.disabled = true; self.toast("Export pfp…", "info"); try { const r = await self.exportPfpFolder((i, t) => { try { btn.textContent = "… " + i + "/" + t; } catch (_) {} }); self.toast("Pfp exportées : " + r.done + " .jpg" + (r.failed ? (" · " + r.failed + " ratées") : "")); try { require("electron").shell.openPath(r.dir); } catch (e2) {} } catch (e2) { self.toast("Export pfp failed: " + ((e2 && e2.message) || e2), "error"); } btn.disabled = false; btn.textContent = "🖼 Scrap pfp (.jpg)"; } }, "🖼 Scrap pfp (.jpg)")
                ])
            ]);

            const settingsPanel = h("div", { key: "setp", className: "psa-panel psa-spad" }, [
                h("div", { key: "t", className: "psa-pt" }, "Diagnostics"),
                h("div", { key: "d", className: "psa-about" }, "Écrit le layout rendu (positions, tailles, styles) dans un fichier — pour debug et adaptation à Discord."),
                h("div", { key: "btns", style: { display: "flex", gap: 8, flexWrap: "wrap" } }, [
                    h("button", { key: "dump", className: "psa-dbtn", onClick: () => { self.dumpLayout("psa-settings", "dashboard"); self.dumpLayout("psa-fiche", "fiche"); self.toast("Layout exporté → data/psa-dbg-*.txt"); } }, "⧉ Dump layout"),
                    h("button", { key: "dumpd", className: "psa-dbtn", onClick: () => self.dumpDiscord() }, "⧉ Dump Discord")
                ]),
                h("div", { key: "about", className: "psa-about", style: { marginTop: 20 } }, [
                    h("div", { key: "1" }, self.sig()),
                    h("div", { key: "2" }, all.length + " fiches · " + totalMedia + " media · " + totalNotes + " notes · " + self.humanBytes(bytes)),
                    h("div", { key: "3" }, "Stockage local: %AppData%/BetterDiscord/data/psa/")
                ])
            ]);

            let mainKids;
            if (viewUser) {
                mainKids = [
                    h("button", { key: "x", className: "psa-close", title: "Close", onClick: closeModal }, "✕"),
                    h("button", { key: "back", className: "psa-back", onClick: () => { setViewUser(null); reload(); } }, "‹ Registry"),
                    h(FicheComp, { key: "detail" })
                ];
            } else if (serverView) {
                mainKids = [
                    h("button", { key: "x", className: "psa-close", title: "Close", onClick: closeModal }, "✕"),
                    h("button", { key: "back", className: "psa-back", onClick: () => { setServerView(null); reload(); } }, "‹ Serveurs"),
                    h(SrvComp, { key: "srvdetail", onExit: () => { setServerView(null); reload(); } })
                ];
            } else {
                mainKids = [
                    h("button", { key: "x", className: "psa-close", title: "Close", onClick: closeModal }, "✕"),
                    h("div", { key: "eb", className: "psa-eyebrow" }, eyebrows[section] || "Registre local"),
                    h("h1", { key: "h", className: "psa-h1" }, titles[section] || "Vue d'ensemble"),
                    h("div", { key: "sub", className: "psa-sub" }, subs[section] || "")
                ];
                if (section === "overview") {
                    mainKids.push(h("div", { key: "stats", className: "psa-stats" }, [
                        statCard(false, "", "Fiches", all.length, "identifiants suivis"),
                        statCard(false, "", "Média", totalMedia, "images + vidéos"),
                        statCard(false, "", "Notes", totalNotes, "notes enregistrées"),
                        statCard(false, "", "Supprimés", totalDeleted, "messages captés"),
                        statCard(false, "", "Édités", totalEdited, "messages modifiés"),
                        statCard(true, "", "Stockage", self.humanBytes(bytes), "sur cet appareil")
                    ]));
                    mainKids.push(panelEl);
                } else if (section === "servers") {
                    for (const el of serversList) mainKids.push(el);
                } else if (section === "pfp") {
                    mainKids.push(h(PfpComp, { key: "pfp" }));
                } else if (section === "sec") {
                    mainKids.push(h(SecComp, { key: "sec" }));
                } else if (section === "settings") {
                    mainKids.push(loggerPanel);
                    mainKids.push(uiPanel);
                    mainKids.push(backupPanel);
                    mainKids.push(settingsPanel);
                } else {
                    mainKids.push(panelEl);
                }
            }

            return h("div", { className: "psa-settings" }, [side, h("div", { key: "main", className: "psa-main" }, mainKids)]);
        };
    }

    walkTree(node, predicate, depth) {
        depth = depth || 0;
        if (!node || depth > 14) return null;
        if (predicate(node)) return node;
        if (Array.isArray(node)) {
            for (const c of node) {
                const r = this.walkTree(c, predicate, depth + 1);
                if (r) return r;
            }
            return null;
        }
        if (typeof node !== "object") return null;
        if (node.props) {
            const r = this.walkTree(node.props, predicate, depth + 1);
            if (r) return r;
        }
        if (node.children) {
            const r = this.walkTree(node.children, predicate, depth + 1);
            if (r) return r;
        }
        return null;
    }

    findMenuChildren(ret, navId) {
        let node = this.walkTree(ret, n => n && typeof n === "object" && n.navId === navId);
        let list = node && node.children;
        if (Array.isArray(list)) return list;
        if (ret && ret.props && Array.isArray(ret.props.children)) return ret.props.children;
        return null;
    }

    pushGroup(menu, items) {
        if (!items.length) return;
        try {
            menu.push(BdApi.ContextMenu.buildMenuChildren([{ type: "group", items }]));
        } catch (e) {
            for (const it of items) menu.push(BdApi.ContextMenu.buildItem(it));
        }
    }

    userMenu(ret, props) {
        const user = props && props.user;
        if (!user) return;
        const menu = this.findMenuChildren(ret, "user-context");
        if (!menu) return;
        const username = user.globalName || user.username || user.id;
        this.pushGroup(menu, [
            { label: "View fiche", action: () => this.openFiche(user.id) },
            { label: "Add note", action: () => this.openNote(user.id, username) },
            { label: "Dashboard", action: () => this.openDashboard() }
        ]);
    }

    messageMenu(ret, props) {
        const message = props && props.message;
        if (!message) return;
        const menu = this.findMenuChildren(ret, "message");
        if (!menu) return;
        const sources = this.pickSources(message);
        const author = message.author || {};
        const username = author.globalName || author.username || author.id;

        const items = [];
        if (sources.length) {
            items.push({
                label: "Save to fiche (" + sources.length + ")",
                action: async () => {
                    try {
                        const r = await this.saveSources(author.id, username, sources);
                        if (r.saved === 0) this.toast("Nothing new (dupes)", "info");
                        else if (r.links > 0) this.toast("Saved " + r.saved + " (⚠ " + r.links + " link-only, download failed: " + (r.err || "?") + ")", "warning");
                        else this.toast("Saved " + r.files + " file" + (r.files > 1 ? "s" : "") + " to " + username, "success");
                    } catch (e) {
                        this.toast("Failed: " + (e && e.message || "error"), "error");
                    }
                }
            });
        }
        items.push({ label: "View author fiche", action: () => this.openFiche(author.id) });
        this.pushGroup(menu, items);
    }
};
