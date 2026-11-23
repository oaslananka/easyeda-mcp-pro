/** Hosted-only, dependency-free assets. These remain embedded in the Node package build. */
export const CLOUD_CSS = String.raw`
:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color-scheme:dark;background:#070b14;color:#f8fafc;line-height:1.55;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;min-height:100vh;background:radial-gradient(ellipse 65% 45% at 90% 0%,rgba(14,165,233,0.08),transparent 75%),radial-gradient(ellipse 55% 40% at 10% 15%,rgba(99,102,241,0.06),transparent 70%),#070b14;color:#f8fafc}
body:before{content:"";position:fixed;inset:0;pointer-events:none;z-index:-1;opacity:.12;background-image:radial-gradient(rgba(148,163,184,0.3) 1px,transparent 1px);background-size:24px 24px;mask-image:linear-gradient(to bottom,#000 30%,transparent 85%)}
a{color:#38bdf8;text-decoration:none;transition:color .15s}a:hover{color:#7dd3fc}a:focus-visible,button:focus-visible{outline:2px solid #38bdf8;outline-offset:3px}button{font:inherit}
.wrap{width:min(100% - 48px,1180px);margin:0 auto}
.nav{min-height:80px;display:flex;align-items:center;justify-content:space-between;gap:18px;border-bottom:1px solid rgba(255,255,255,0.06)}
.brand{display:inline-flex;align-items:center;gap:12px;font-size:16px;font-weight:700;color:#f8fafc;letter-spacing:-.02em}.brand:hover{color:#fff}.brand-name span{color:#94a3b8;font-weight:500}
.mark{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;color:#38bdf8;background:linear-gradient(145deg,rgba(14,165,233,0.15),rgba(37,99,235,0.08));border:1px solid rgba(56,189,248,0.25);box-shadow:0 0 20px rgba(14,165,233,0.15)}
.nav-right{display:flex;align-items:center;gap:18px}.tag,.step-indicator{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#94a3b8}
.tag{display:inline-flex;gap:8px;align-items:center;border:1px solid rgba(255,255,255,0.08);border-radius:99px;padding:6px 12px;background:rgba(255,255,255,0.03)}
.tag-dot{width:6px;height:6px;background:#10b981;border-radius:50%;box-shadow:0 0 8px #10b981}
.nav-link{font-size:13px;color:#94a3b8;font-weight:600;display:inline-flex;align-items:center;gap:4px}.nav-link:hover{color:#f8fafc}.nav-arrow{font-size:11px}
main{padding:54px 0 68px}
.eyebrow{font-size:11px;text-transform:uppercase;letter-spacing:.15em;color:#38bdf8;font-weight:750;margin:0 0 16px}
.hero{font-size:clamp(32px,4vw,56px);font-weight:800;letter-spacing:-.03em;line-height:1.14;margin:0 0 20px;max-width:720px;color:#f8fafc}
.subtitle{color:#94a3b8;font-size:16px;max-width:600px;margin:0 0 32px;line-height:1.65}
.landing-grid{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(330px,.8fr);gap:clamp(36px,5vw,72px);align-items:center;min-height:520px}
.landing-intro{min-width:0}.journey{display:grid;gap:0;max-width:540px}
.journey-step{display:flex;align-items:center;gap:16px;padding:14px 0;border-top:1px solid rgba(255,255,255,0.06)}
.journey-step:last-child{border-bottom:1px solid rgba(255,255,255,0.06)}
.step-num{font-size:12px;font-weight:800;color:#38bdf8;background:rgba(56,189,248,0.1);width:36px;height:36px;display:grid;place-items:center;border:1px solid rgba(56,189,248,0.25);border-radius:10px;flex-shrink:0}
.journey-step strong,.journey-step small{display:block}
.journey-step strong{font-size:14px;font-weight:700;color:#f1f5f9}
.journey-step small{font-size:12px;color:#94a3b8;margin-top:2px}
.auth-card,.panel{border:1px solid rgba(255,255,255,0.08);background:linear-gradient(180deg,rgba(15,23,42,0.7) 0%,rgba(10,15,30,0.85) 100%);box-shadow:0 20px 45px rgba(0,0,0,0.5),inset 0 1px 0 rgba(255,255,255,0.06);border-radius:20px}
.auth-card{padding:clamp(24px,3vw,36px);position:relative;overflow:hidden}
.auth-card:before{content:"";position:absolute;inset:0 0 auto;height:2px;background:linear-gradient(90deg,#38bdf8,#6366f1)}
.auth-card-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:28px}
.auth-icon{background:rgba(56,189,248,0.1);border:1px solid rgba(56,189,248,0.25);color:#38bdf8;width:48px;height:48px;border-radius:14px;display:grid;place-items:center}
.auth-card h2{margin:0;font-size:26px;letter-spacing:-.025em;color:#f8fafc}
.auth-description{color:#94a3b8;font-size:14px;margin:6px 0 24px}
.auth-buttons{display:grid;gap:12px}
.btn{min-height:44px;display:inline-flex;align-items:center;justify-content:center;gap:10px;cursor:pointer;border:1px solid transparent;border-radius:11px;padding:10px 18px;background:linear-gradient(135deg,#0ea5e9,#2563eb);color:#fff;font-weight:650;font-size:14px;text-decoration:none;transition:all .18s ease;box-shadow:0 2px 10px rgba(14,165,233,0.25)}
.btn:hover{background:linear-gradient(135deg,#38bdf8,#3b82f6);transform:translateY(-1px);box-shadow:0 4px 16px rgba(14,165,233,0.35)}
.btn:active{transform:translateY(0);box-shadow:none}
.btn.secondary{background:rgba(255,255,255,0.04);color:#f1f5f9;border-color:rgba(255,255,255,0.1);box-shadow:none}
.btn.secondary:hover{background:rgba(255,255,255,0.08);border-color:rgba(255,255,255,0.18);transform:translateY(-1px)}
.btn.subtle{background:rgba(255,255,255,0.03);color:#cbd5e1;border-color:rgba(255,255,255,0.08);box-shadow:none}
.btn.subtle:hover{background:rgba(255,255,255,0.06);border-color:rgba(255,255,255,0.14);color:#f8fafc}
.btn.small{min-height:36px;padding:6px 14px;font-size:12px;border-radius:8px}
.btn.danger{background:rgba(244,63,94,0.12);color:#fda4af;border-color:rgba(244,63,94,0.3);box-shadow:none}
.btn.danger:hover{background:rgba(244,63,94,0.22);border-color:rgba(244,63,94,0.45);color:#fff}
.btn:disabled{opacity:.45;cursor:not-allowed;transform:none!important;box-shadow:none!important}
.provider-button{min-height:54px;display:grid;grid-template-columns:32px 1fr 18px;text-align:left;align-items:center;width:100%;padding:8px 16px}
.provider-button .provider-mark{display:grid;place-items:center;width:30px;height:30px;border-radius:8px;background:rgba(0,0,0,0.3);color:#fff}
.provider-button.secondary .provider-mark{background:transparent}
.provider-button .button-arrow{justify-self:end;display:grid;place-items:center;color:#94a3b8}
.auth-card-foot{display:flex;gap:12px;align-items:flex-start;border-top:1px solid rgba(255,255,255,0.06);margin-top:24px;padding-top:20px;color:#94a3b8;font-size:12px;line-height:1.6}
.privacy-icon{flex-shrink:0;display:grid;place-items:center;width:20px;height:20px;background:rgba(16,185,129,0.15);color:#10b981;border-radius:50%;margin-top:1px}
.trust-strip{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin-top:54px;gap:18px}
.trust-strip>div{display:flex;gap:14px;align-items:center;border:1px solid rgba(255,255,255,0.06);background:rgba(15,23,42,0.4);border-radius:14px;padding:16px 18px}
.trust-mark{display:grid;place-items:center;border:1px solid rgba(56,189,248,0.2);background:rgba(56,189,248,0.08);color:#38bdf8;border-radius:10px;min-width:38px;height:38px}
.trust-strip strong,.trust-strip small{display:block}
.trust-strip strong{font-size:13px;color:#f1f5f9;font-weight:700}
.trust-strip small{font-size:12px;color:#94a3b8;line-height:1.45;margin-top:2px}
footer{padding:28px 0 36px;display:flex;align-items:center;justify-content:space-between;gap:15px;border-top:1px solid rgba(255,255,255,0.06);font-size:12px;color:#64748b}
footer a{color:#94a3b8}footer a:hover{color:#e2e8f0}
.workspace-head{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-bottom:28px}
.workspace-title{font-size:clamp(30px,3.5vw,42px);line-height:1.15;letter-spacing:-.03em;margin:0 0 8px;color:#f8fafc}
.workspace-desc{color:#94a3b8;font-size:15px;max-width:640px;margin:0;line-height:1.6}
.account-identity{border:1px solid rgba(255,255,255,0.08);background:rgba(15,23,42,0.6);border-radius:12px;padding:10px 14px;display:flex;gap:11px;align-items:center;min-width:190px}
.account-identity small,.account-identity strong{display:block}
.account-identity small{font-size:11px;color:#64748b}
.account-identity strong{font-size:13px;color:#f1f5f9;word-break:break-word}
.identity-avatar{color:#38bdf8;background:rgba(56,189,248,0.1);display:grid;place-items:center;width:34px;height:34px;border-radius:9px;border:1px solid rgba(56,189,248,0.2)}
.workspace-grid{display:grid;grid-template-columns:minmax(0,1.22fr) minmax(320px,.78fr);align-items:start;gap:20px}
.panel{padding:24px;max-width:none}
.panel h2{font-size:18px;letter-spacing:-.02em;margin:0;line-height:1.3;color:#f8fafc;font-weight:700}
.section-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}
.section-kicker{margin:0 0 4px;color:#38bdf8;letter-spacing:.12em;font-size:10px;font-weight:750;text-transform:uppercase}
.section-description{color:#94a3b8;font-size:13px;line-height:1.6;margin:10px 0 20px}
.count{display:inline-flex;vertical-align:middle;margin-left:8px;padding:2px 8px;border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:#cbd5e1;font-size:11px;font-weight:650;background:rgba(255,255,255,0.03)}
.device-history{border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:8px 12px;background:rgba(10,15,28,0.5)}
.device-history>summary{cursor:pointer;color:#94a3b8;font-weight:650;font-size:13px;padding:8px 4px;min-height:38px;display:flex;align-items:center}
.device-history>summary:hover{color:#f1f5f9}
.device-history>summary:focus-visible{outline:2px solid #38bdf8;outline-offset:2px}
.device-history[open]{display:grid;gap:10px}
.device-history .session{margin-top:4px}
.device-history-note{color:#64748b;font-size:12px;line-height:1.5;margin:2px 4px 6px}
.device-list{display:grid;gap:12px}
.empty{padding:24px 20px;background:rgba(10,15,28,0.4);border:1px dashed rgba(255,255,255,0.12);border-radius:14px;color:#94a3b8;font-size:13px;line-height:1.6}
.device-list .empty{min-height:120px;display:flex;align-items:center;justify-content:center;text-align:center}
.session{display:flex;gap:16px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;background:rgba(10,15,28,0.6);border:1px solid rgba(255,255,255,0.07);border-radius:14px;padding:16px}
.session strong{font-size:14px;color:#f8fafc;word-break:break-word}
.session p{color:#94a3b8;font-size:12px;margin:4px 0}
.session>div{min-width:0}
.session-revoke-confirm{flex:1 0 100%;border-top:1px solid rgba(255,255,255,0.06);padding-top:12px;margin-top:6px}
.session-revoke-confirm p{margin:0 0 10px;color:#fda4af;font-size:12px;line-height:1.55}
.client-permission{display:inline-flex;align-items:center;border:1px solid rgba(16,185,129,0.3);background:rgba(16,185,129,0.1);color:#6ee7b7;border-radius:999px;padding:3px 10px;font-size:11px;font-weight:700;margin:8px 0 2px}
.client-permission.limited{border-color:rgba(56,189,248,0.25);background:rgba(56,189,248,0.08);color:#7dd3fc}
.session p.client-permission-help{line-height:1.55;max-width:560px;color:#94a3b8;margin-top:8px}
.session-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.session .btn{min-height:36px;font-size:12px;padding:6px 12px}
.status{display:inline-flex;gap:6px;align-items:center;font-size:11px;font-weight:700;padding:3px 9px;border:1px solid rgba(16,185,129,0.3);border-radius:999px;background:rgba(16,185,129,0.1);color:#6ee7b7}
.status:before{content:"";width:6px;height:6px;border-radius:50%;background:#10b981;box-shadow:0 0 6px #10b981}
.status.off{border-color:rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);color:#94a3b8}
.status.off:before{background:#64748b;box-shadow:none}
.setup-steps{display:grid;gap:0;margin:16px 0}
.setup-steps p{display:grid;grid-template-columns:26px minmax(0,1fr);align-items:start;gap:12px;border-bottom:1px solid rgba(255,255,255,0.05);margin:0;padding:12px 0;font-size:13px;color:#94a3b8}
.setup-steps strong{color:#f1f5f9;font-weight:650}
.setup-steps p>span:first-child{border:1px solid rgba(56,189,248,0.25);background:rgba(56,189,248,0.1);color:#38bdf8;width:24px;height:24px;border-radius:7px;display:grid;place-items:center;font-weight:800;font-size:11px}
.setup-steps .step-copy{min-width:0;line-height:1.6;overflow-wrap:break-word}
.setup-steps .step-copy a{font-weight:650;text-underline-offset:3px}
.pair-button{width:100%;justify-content:space-between;padding:12px 16px;margin:6px 0 14px}
.pairing-actions{display:flex;align-items:center;flex-wrap:wrap;gap:10px}
.code{display:inline-flex;align-items:center;justify-content:center;max-width:100%;letter-spacing:.12em;font-size:22px;font-weight:800;color:#38bdf8;background:#050914;border:1px solid rgba(56,189,248,0.25);border-radius:10px;min-height:50px;padding:6px 16px;margin:0;user-select:all;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.muted,.meta{color:#64748b;font-size:12px}
.pairing-panel .muted{line-height:1.6}
.usage-panel{margin-top:20px}
.usage-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.usage-stat{padding:16px;background:rgba(10,15,28,0.6);border:1px solid rgba(255,255,255,0.07);border-radius:12px}
.usage-stat strong{display:block;font-size:28px;line-height:1.1;letter-spacing:-.04em;color:#f8fafc;font-variant-numeric:tabular-nums;font-weight:800}
.usage-stat span{display:block;color:#94a3b8;font-size:12px;margin-top:6px}
.usage-panel .muted{margin:12px 0 0}
.clients-panel{margin-top:20px}
.clients-panel .empty{padding:16px}
.account-actions{display:flex;justify-content:flex-end;margin-top:24px}
.notice{background:rgba(15,23,42,0.8);border:1px solid rgba(56,189,248,0.25);color:#cbd5e1;border-radius:11px;padding:12px 16px;font-size:13px}
.notice.error{background:rgba(244,63,94,0.1);border-color:rgba(244,63,94,0.3);color:#fda4af}
#notice{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:1000;background:rgba(15,23,42,0.92);backdrop-filter:blur(16px);border:1px solid rgba(56,189,248,0.35);color:#f8fafc;padding:10px 22px;border-radius:9999px;box-shadow:0 12px 36px rgba(0,0,0,0.6),0 0 24px rgba(56,189,248,0.18);font-size:13px;font-weight:550;max-width:90vw;text-align:center;pointer-events:none}
#notice:empty{display:none!important}
#notice.error{border-color:rgba(244,63,94,0.45);background:rgba(36,12,22,0.94);color:#ffe4e6;box-shadow:0 12px 36px rgba(0,0,0,0.6),0 0 24px rgba(244,63,94,0.2)}
.scopes{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;list-style:none;padding:0;margin:18px 0}
.scopes li{border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:12px 14px;background:rgba(10,15,28,0.6);font-size:13px;transition:border-color .15s}
.scopes li:hover{border-color:rgba(56,189,248,0.3)}
.scopes li strong,.scopes li small,.scopes li code{display:block}
.scope-option{display:flex;gap:12px;align-items:flex-start;cursor:pointer;min-height:44px}
.scope-option input{width:18px;height:18px;accent-color:#0ea5e9;flex:0 0 18px;margin:3px 0 0}
.scope-option input:focus-visible{outline:2px solid #38bdf8;outline-offset:3px}
.scope-option span{min-width:0}
.scopes li strong{color:#f8fafc;font-size:13px;font-weight:650}
.scopes li small{color:#94a3b8;font-size:12px;line-height:1.5;margin-top:4px}
.scopes li code{color:#64748b;font-size:10px;overflow-wrap:anywhere;margin-top:8px}
.segment{border-top:1px solid rgba(255,255,255,0.06);margin-top:20px;padding-top:20px}
[hidden]{display:none!important}

.panel{position:relative;overflow:hidden}
.panel:before{content:"";position:absolute;inset:0 0 auto;height:2px;background:linear-gradient(90deg,rgba(56,189,248,0.4),rgba(99,102,241,0.2),transparent 80%)}
.client-manage{width:100%;margin-top:8px;border-top:1px solid rgba(255,255,255,0.06);padding-top:10px}
.client-manage summary{cursor:pointer;display:inline-flex;align-items:center;color:#38bdf8;font-size:12px;font-weight:700;padding:8px 2px;min-height:38px}
.client-manage summary:hover{color:#7dd3fc}
.client-manage summary:focus-visible{outline:2px solid #38bdf8;outline-offset:3px}
.client-scope-grid{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
.client-scope{border:1px solid rgba(255,255,255,0.08);color:#64748b;padding:5px 10px;border-radius:7px;font-size:12px}
.client-scope.granted{border-color:rgba(16,185,129,0.3);background:rgba(16,185,129,0.08);color:#6ee7b7}
.client-manage .btn.danger{margin-top:10px}

.guided-panel{padding:clamp(20px,2.5vw,30px);margin-bottom:20px}
.guided-panel .section-heading{margin-bottom:6px}
.guided-panel .section-description{max-width:720px;margin:0 0 18px}
.guided-progress{padding:0;margin:0 0 22px;list-style:none;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.guided-progress li{display:flex;gap:9px;align-items:center;min-width:0;font-size:12px;color:#64748b;padding:10px;border:1px solid rgba(255,255,255,0.06);border-radius:10px;background:rgba(10,15,28,0.5)}
.guided-progress .guided-number{flex-shrink:0;display:grid;place-items:center;width:24px;height:24px;border-radius:7px;background:rgba(255,255,255,0.06);font-weight:800;font-size:11px}
.guided-progress li[data-state="done"]{border-color:rgba(16,185,129,0.3);background:rgba(16,185,129,0.08);color:#6ee7b7}
.guided-progress li[data-state="done"] .guided-number{background:rgba(16,185,129,0.2);color:#6ee7b7}
.guided-progress li[data-state="current"]{border-color:rgba(56,189,248,0.4);background:rgba(56,189,248,0.1);color:#f8fafc}
.guided-progress li[data-state="current"] .guided-number{background:#0ea5e9;color:#fff}
.guided-grid{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,.8fr);gap:20px}
.guided-choice,.guided-status{min-width:0}
.guided-choice h3{font-size:14px;margin:0 0 10px;font-weight:700;color:#f8fafc}
.client-chooser{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.client-choice{border:1px solid rgba(255,255,255,0.08);border-radius:9px;background:rgba(255,255,255,0.03);color:#94a3b8;padding:8px 13px;min-height:40px;cursor:pointer;font-size:13px;font-weight:650;transition:all .15s}
.client-choice:hover{border-color:rgba(255,255,255,0.16);color:#f1f5f9}
.client-choice[aria-pressed="true"]{background:linear-gradient(135deg,#0ea5e9,#2563eb);color:#fff;border-color:transparent;box-shadow:0 2px 10px rgba(14,165,233,0.3)}
.client-choice:focus-visible{outline:2px solid #38bdf8;outline-offset:2px}
.guided-instructions{border:1px solid rgba(255,255,255,0.07);background:rgba(10,15,28,0.6);border-radius:12px;padding:16px;min-width:0}
.guided-instructions strong{font-size:14px;color:#f8fafc}
.guided-instructions p{line-height:1.55;margin:6px 0 12px;color:#94a3b8}
.guided-config{display:block;white-space:pre-wrap;overflow-wrap:anywhere;background:#050914;color:#7dd3fc;border:1px solid rgba(56,189,248,0.2);border-radius:9px;font-size:12px;max-height:160px;overflow:auto;padding:12px;user-select:all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.guided-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.guided-actions .btn{min-height:38px}
.guided-status{border:1px solid rgba(255,255,255,0.07);border-radius:12px;background:rgba(10,15,28,0.6);padding:4px 16px}
.guided-status-line{padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.05);display:flex;flex-direction:column;align-items:flex-start;gap:4px}
.guided-status-line:last-child{border-bottom:0}
.guided-status-line>span{font-size:10px;text-transform:uppercase;color:#64748b;font-weight:750;letter-spacing:.08em}
.guided-status-line strong{font-size:13px;color:#f8fafc}
.guided-status-line a{font-size:12px;text-underline-offset:3px}
.guided-status-line p{margin:2px 0 6px;font-size:12px;color:#94a3b8}
.guided-hint{margin:16px 0 0;border-top:1px solid rgba(255,255,255,0.06);padding-top:12px;color:#7dd3fc;font-size:13px}
.consent-advanced{border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:12px 16px;margin:12px 0 18px;background:rgba(10,15,28,0.6)}
.consent-advanced summary{cursor:pointer;min-height:28px;font-size:13px;font-weight:700;color:#38bdf8}
.consent-advanced summary:hover{color:#7dd3fc}
.consent-advanced summary:focus-visible{outline:2px solid #38bdf8;outline-offset:3px}

@media(max-width:960px){
  .guided-grid{grid-template-columns:1fr}
  .landing-grid{grid-template-columns:1fr;gap:32px;min-height:0}
  .landing-intro{max-width:690px}
  .auth-card{max-width:600px}
  .workspace-grid{grid-template-columns:1fr}
  .trust-strip{margin-top:36px}
}
@media(max-width:640px){
  .guided-progress{grid-template-columns:repeat(2,minmax(0,1fr))}
  .guided-progress li{padding:8px}
  .guided-panel{padding:18px}
  .guided-actions>.btn{flex:1 1 140px}
  .landing-intro .journey{display:none}
  .workspace-grid[data-empty="true"] .pairing-panel{grid-row:1}
  .workspace-grid[data-empty="true"] .device-panel{grid-row:2}
  .wrap{width:min(100% - 28px,1180px)}
  .nav{min-height:70px}
  .nav-right{gap:9px}
  .tag{display:none}
  .nav-link{font-size:12px}
  main{padding:32px 0 48px}
  .hero{font-size:clamp(30px,8vw,42px)}
  .subtitle{font-size:14px}
  .auth-card,.panel{padding:20px;border-radius:16px}
  .trust-strip{grid-template-columns:1fr;gap:10px}
  .workspace-head{flex-direction:column;align-items:stretch}
  .account-identity{width:100%}
  .session{flex-direction:column;align-items:stretch}
  .session button{width:100%}
  .session-actions{width:100%;flex-direction:column;align-items:stretch}
  .code{font-size:18px}
  .usage-grid{grid-template-columns:1fr 1fr 1fr;gap:8px}
  .usage-stat{padding:12px}
  .usage-stat strong{font-size:22px}
  .usage-stat span{font-size:10px}
  footer{flex-direction:column;align-items:flex-start}
}
@media(max-width:400px){
  main{padding-top:20px}
  .hero{font-size:clamp(26px,8.5vw,32px)}
  .auth-card,.panel{padding:16px}
}
@media(prefers-reduced-motion:reduce){*,*:before,*:after{scroll-behavior:auto!important;transition:none!important}}
`;

export const CLOUD_JS = String.raw`
(() => {
  "use strict";
  const root = document.getElementById('cloud-root');
  if (!root) return;
  const page = root.dataset.page;
  const query = window.location.search.slice(1);
  const get = (id) => document.getElementById(id);
  const setText = (id, value) => { const el = get(id); if (el) { el.textContent = String(value); if (id === 'notice') el.classList.remove('error'); } };
  const fail = (error) => { setText('notice', error instanceof Error ? error.message : 'The request failed. Please retry.'); const n = get('notice'); if (n) n.classList.add('error'); };
  const request = async (url, options) => {
    let response;
    try {
      response = await fetch(url, { credentials: 'same-origin', ...options });
    } catch {
      throw new Error('Cannot reach EasyEDA Cloud. Check your connection and any separate access sign-in, then refresh.');
    }
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(typeof result?.message === 'string' ? result.message : 'Request failed (' + response.status + ').');
      error.status = response.status;
      throw error;
    }
    return result;
  };
  const post = (url, body) => request(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  const el = (tag, className, value) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = String(value);
    return node;
  };
  const showLocation = (data) => {
    if (data?.url && data?.redirect === false) throw new Error('Unable to open the authorization page.');
    if (typeof data?.url !== 'string') throw new Error('Authorization did not return a destination.');
    window.location.assign(data.url);
  };
  if (page === 'sign-in') {
    document.querySelectorAll('[data-provider]').forEach((button) => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        setText('notice', 'Opening ' + button.dataset.provider + ' sign-in…');
        try {
          const body = { provider: button.dataset.provider };
          if (query) body.oauth_query = query;
          else body.callbackURL = '/cloud';
          const result = await post('/api/auth/sign-in/social', body);
          showLocation(result);
        } catch (error) {
          fail(error);
          button.disabled = false;
        }
      });
    });
  }
  if (page === 'consent') {
    document.querySelectorAll('[data-consent]').forEach((button) => {
      button.addEventListener('click', async () => {
        document.querySelectorAll('[data-consent]').forEach((b) => {b.disabled = true;});
        setText('notice', 'Processing your decision…');
        try {
          const accepted = button.dataset.consent === 'allow';
          const selected = accepted
            ? Array.from(document.querySelectorAll('input[name="cloud-scope"]:checked'),
                (input) => input.value).filter((value) => typeof value === 'string')
            : [];
          if (accepted && selected.length === 0) {
            throw new Error('Select at least one permission, or deny access.');
          }
          const result = await post('/api/auth/oauth2/consent', {
            accept: accepted,
            oauth_query: query,
            ...(accepted ? { scope: selected.join(' ') } : {}),
          });
          showLocation(result);
        } catch (error) {
          fail(error);
          document.querySelectorAll('[data-consent]').forEach((b) => {b.disabled = false;});
        }
      });
    });
  }
  if (page === 'account') {
    // The URL is public configuration, never a bearer token or extension WSS link.
    const mcpUrl = (window.location.origin || 'https://easyeda-mcp-pro.oaslananka.dev') + '/mcp';
    const firstQuestion = 'Inspect the focused schematic and explain its power connections. Do not change anything.';
    const clientOptions = {
      chatgpt: {
        name: 'ChatGPT', instructions: 'In ChatGPT Plugins, choose Add custom MCP server. Paste this URL and approve Read access when prompted.',
        link: 'https://chatgpt.com/plugins', linkText: 'Open ChatGPT Plugins', format: 'url',
      },
      claude: {
        name: 'Claude', instructions: 'In Claude, open Customize → Connectors → Add custom connector. Paste this URL, then authorize Read.',
        link: 'https://claude.ai/', linkText: 'Open Claude', format: 'url',
      },
      cursor: {
        name: 'Cursor', instructions: 'Add the remote MCP server in Cursor. Use one-click install where supported, then complete the OAuth Read approval.',
        link: 'https://cursor.com/docs/mcp', linkText: 'Cursor MCP guide', format: 'cursor',
      },
      codex: {
        name: 'Codex', instructions: 'Run this command in a terminal with Codex installed. Codex will open OAuth when you connect.',
        link: 'https://developers.openai.com/codex/mcp', linkText: 'Codex MCP guide', format: 'command',
      },
      other: {
        name: 'MCP client', instructions: 'Add a remote HTTP MCP server in your app with this URL and authorize Read access. Your client must support the server OAuth flow.',
        link: 'https://modelcontextprotocol.io/', linkText: 'MCP documentation', format: 'url',
      },
    };
    let selectedClient = 'chatgpt';
    let deviceLoaded = false;
    let clientsLoaded = false;
    let deviceStatusUnavailable = false;
    let clientStatusUnavailable = false;
    let hasOnlineDevice = false;
    let hasPreviousPairings = false;
    let hasSelectedDesign = false;
    let readClientCount = 0;
    let readClientNames = [];
    // OAuth grants are authoritative; client display names are only a UI cue,
    // never a security boundary or proof that the selected app is connected.
    const selectedClientHasReadAccess = () => clientsLoaded && readClientCount > 0 &&
      (selectedClient === 'other' || readClientNames.some((name) =>
        name.toLowerCase().includes(selectedClient)));
    // The connection guide is also shown to returning owners with a selected
    // design. Keep its next action aligned with the actual connection state.
    const guidedPresentation = (readyForQuestion) => {
      if (deviceStatusUnavailable) return {
        kicker: 'STATUS UNAVAILABLE', title: 'Verify your EasyEDA connection', phase: 'RETRY CONNECTION CHECK',
      };
      if (clientStatusUnavailable && hasSelectedDesign) return {
        kicker: 'VERIFY PERMISSIONS', title: 'Check MCP authorization', phase: 'RETRY ACCESS CHECK',
      };
      if (readyForQuestion) return {
        kicker: 'DESIGN SELECTED', title: 'Your EasyEDA workspace', phase: 'NEXT: ASK A QUESTION',
      };
      if (hasSelectedDesign) return {
        kicker: 'AUTHORIZE ACCESS', title: 'Connect your AI assistant', phase: 'APP ACCESS REQUIRED',
      };
      if (hasOnlineDevice) return {
        kicker: 'SELECT A DESIGN', title: 'Choose your open design', phase: 'DESIGN NOT SELECTED',
      };
      if (hasPreviousPairings) return {
        kicker: 'RECONNECT', title: 'Reconnect EasyEDA', phase: 'CONNECT YOUR DEVICE',
      };
      return {
        kicker: 'FIRST CONNECTION', title: 'Start using EasyEDA MCP Pro', phase: 'GUIDED SETUP',
      };
    };
    const updateGuided = () => {
      const chosenClientName = clientOptions[selectedClient].name;
      const chosenClientHasReadAccess = selectedClientHasReadAccess();
      const presentation = guidedPresentation(hasSelectedDesign && chosenClientHasReadAccess);
      setText('guided-kicker', presentation.kicker);
      setText('guided-title', presentation.title);
      setText('guided-phase', presentation.phase);
      const deviceStage = get('progress-device');
      const accessStage = get('progress-access');
      const questionStage = get('progress-ask');
      if (deviceStage) deviceStage.dataset.state = hasSelectedDesign ? 'done' : 'current';
      if (accessStage) accessStage.dataset.state = chosenClientHasReadAccess && hasSelectedDesign ? 'done' : hasSelectedDesign ? 'current' : 'waiting';
      // The sample question still needs to be asked inside the actual MCP client.
      if (questionStage) questionStage.dataset.state = hasSelectedDesign && chosenClientHasReadAccess ? 'current' : 'waiting';
      setText('guided-device-status', deviceStatusUnavailable ? 'Connection unavailable · refresh to retry' :
        !deviceLoaded ? 'Checking connection…' :
        hasSelectedDesign ? 'Connected · design selected' : hasOnlineDevice ? 'Connected · choose a design below' :
        hasPreviousPairings ? 'Saved pairing offline' : 'Not connected');
      setText('guided-access-status', clientStatusUnavailable ? 'Authorization unavailable · refresh to retry' :
        !clientsLoaded ? 'Checking authorization…' :
        readClientCount ? 'Read access: ' + readClientNames.slice(0, 2).join(' · ') +
          (readClientCount > 2 ? ' +' + (readClientCount - 2) : '') : 'No MCP client authorized yet');
      const prompt = get('copy-first-question');
      if (prompt) prompt.disabled = !hasSelectedDesign || !chosenClientHasReadAccess;
      const connect = get('guided-connect-link');
      if (connect) {
        connect.textContent = hasSelectedDesign ? 'View selected design ↓' :
          hasOnlineDevice ? 'Choose the open design ↓' :
          hasPreviousPairings ? 'Reconnect EasyEDA ↓' : 'Connect EasyEDA ↓';
        connect.href = hasOnlineDevice || hasPreviousPairings ? '#extensions-title' : '#pair-title';
      }
      setText('guided-hint', deviceStatusUnavailable ?
        'Cloud could not verify the connected EasyEDA device. Refresh Devices before starting an MCP operation.' :
        clientStatusUnavailable ?
          'Cloud could not verify your MCP client permissions. Refresh Permissions before sending a question.' :
        !deviceLoaded || !clientsLoaded ? 'Checking your connection and permissions…' :
        !hasOnlineDevice && hasPreviousPairings ?
          'A saved pairing is offline. Reopen EasyEDA and let MCP Bridge reconnect; pair again only if access expired or was removed.' :
        !hasOnlineDevice ? 'Next: install the bridge once, then pair EasyEDA below.' :
        !hasSelectedDesign ? 'Next: choose the open schematic or PCB on your device card. No new pairing needed.' :
        !readClientCount ? 'Next: add the MCP server in your AI app and approve Read access. Write and Export can be added later.' :
        !chosenClientHasReadAccess ? chosenClientName + ' is not listed as Read-authorized. Check Authorized MCP clients, or choose Other MCP app for a custom-named connector.' :
        selectedClient === 'other' ?
          'Read access is listed for ' + readClientNames[0] + '. Confirm that this is your MCP client in Permissions, then try the sample question.' :
          'A client with a ' + chosenClientName + ' label has Read access. Check its identity in Permissions, then try the sample question.');
    };
    const selectClient = (key) => {
      const choice = clientOptions[key];
      if (!choice) return;
      selectedClient = key;
      Object.keys(clientOptions).forEach((name) => {
        const button = get('client-' + name);
        if (button) button.setAttribute('aria-pressed', String(name === key));
      });
      const text = choice.format === 'command' ? 'codex mcp add easyeda-mcp-pro --url ' + mcpUrl :
        choice.format === 'cursor' ? JSON.stringify({url:mcpUrl}, null, 2) : mcpUrl;
      setText('client-instructions-title', 'Connect ' + choice.name);
      setText('client-instructions', choice.instructions);
      setText('client-config', text);
      setText('copy-client-config', choice.format === 'command' ? 'Copy Codex command' : choice.format === 'cursor' ? 'Copy Cursor config' : 'Copy server URL');
      const link = get('open-client');
      if (link) {
        link.href = choice.link;
        link.textContent = choice.linkText + ' ↗';
        if (key === 'cursor' && typeof window.btoa === 'function') {
          link.href = 'cursor://anysphere.cursor-deeplink/mcp/install?name=easyeda-mcp-pro&config=' +
            encodeURIComponent(window.btoa(JSON.stringify({url:mcpUrl})));
          link.textContent = 'Add to Cursor ↗';
        }
      }
      updateGuided();
    };
    Object.keys(clientOptions).forEach((key) => {
      const button = get('client-' + key);
      if (button) button.addEventListener('click', () => selectClient(key));
    });
    const copyGuided = async (value, message) => {
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard is unavailable');
        await navigator.clipboard.writeText(value);
        setText('notice', message);
      } catch {
        setText('notice', 'Clipboard unavailable. Select the displayed text to copy it manually.');
      }
    };
    get('copy-client-config')?.addEventListener('click', () =>
      copyGuided(get('client-config')?.textContent || mcpUrl, 'Connection details copied. Add them in your AI app and approve Read access.'));
    get('copy-first-question')?.addEventListener('click', () => {
      if (hasSelectedDesign && selectedClientHasReadAccess())
        void copyGuided(firstQuestion, 'Question copied. Ask it in the selected, authorized MCP client.');
    });
    selectClient(selectedClient);
    updateGuided();
    const list = get('extensions');
    let selected = null;
    let visibleSessionIds = new Set();
    let hasLoadedSessionList = false;
    let previousConnectionsOpen = false;
    const addSession = (s) => {
      const card = el('div','session');
      const info = el('div');
      info.appendChild(el('strong','', s.activeProject?.projectName || 'EasyEDA extension'));
      info.appendChild(el('p','', 'Version ' + s.extensionVersion + ' · ' + (s.mode === 'hosted' ? 'Cloud relay' : 'Remote relay')));
      const isExpired = !s.connected && typeof s.expiresAt === 'string' &&
        Date.parse(s.expiresAt) <= Date.now();
      const state = el('span','status' + (s.connected ? '' : ' off'),
        s.connected ? 'Connected' : isExpired ? 'Session expired' : 'Disconnected');
      info.appendChild(state);
      if (isExpired) info.appendChild(el('p','',
        'Open EasyEDA to reconnect. A remembered device can reconnect automatically while its trust remains valid. Select the document again after reconnecting; otherwise pair with a new code.'));
      card.appendChild(info);
      if (s.connected && (s.activeProject?.projectId || s.activeProject?.projectName)) {
        const isSelected = selected?.sessionId === s.sessionId &&
          selected.projectId === s.activeProject.projectId &&
          selected.documentId === s.activeProject.documentId;
        const focus = s.activeProject.documentType === 'pcb' ? 'PCB' :
          s.activeProject.documentType === 'schematic' ? 'schematic' : 'document';
        const choose = el('button','btn secondary', isSelected ? 'Selected ' + focus : 'Use this ' + focus);
        choose.type = 'button';
        choose.disabled = isSelected;
        choose.addEventListener('click', async () => {
          choose.disabled = true;
          try {
            await request('/cloud/api/selection', {
              method: 'PUT',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({sessionId:s.sessionId}),
            });
            await refreshExtensions();
            setText('notice', 'Document selected. MCP calls will target this extension and its currently focused document.');
          } catch(error) { fail(error); choose.disabled = false; }
        });
        card.appendChild(choose);
      }
      const revoke = el('button','btn danger', 'Remove access');
      revoke.type = 'button';
      const confirmation = el('div','session-revoke-confirm');
      confirmation.hidden = true;
      confirmation.appendChild(el('p','',
        s.connected
          ? 'This disconnects the device from Cloud. Pair it again to reconnect. Your EasyEDA designs are not deleted.'
          : 'This removes the saved Cloud pairing. Your EasyEDA designs are not deleted.'));
      const keep = el('button','btn secondary small','Keep access');
      keep.type = 'button';
      keep.addEventListener('click', () => {
        confirmingRemoval = false;
        revoke.textContent = 'Remove access';
        confirmation.hidden = true;
      });
      confirmation.appendChild(keep);
      let confirmingRemoval = false;
      revoke.addEventListener('click', async () => {
        if (revoke.disabled) return;
        if (!confirmingRemoval) {
          confirmingRemoval = true;
          revoke.textContent = 'Confirm removal';
          confirmation.hidden = false;
          return;
        }
        revoke.disabled = true;
        keep.disabled = true;
        try {
          await request('/cloud/api/extensions/' + encodeURIComponent(s.sessionId), { method: 'DELETE' });
          await refreshExtensions();
          setText('notice','Extension access removed.');
        } catch (error) { fail(error); revoke.disabled = false; keep.disabled = false; }
      });
      card.appendChild(revoke);
      card.appendChild(confirmation);
      return card;
    };
    const refreshExtensions = async () => {
      let data;
      try {
        data = await request('/cloud/api/extensions');
      } catch (error) {
        // An old success may no longer describe the connected device. Do not
        // imply the previous selection is still ready when Cloud is unreachable.
        deviceStatusUnavailable = true;
        deviceLoaded = false;
        hasOnlineDevice = false;
        hasPreviousPairings = false;
        hasSelectedDesign = false;
        selected = null;
        visibleSessionIds = new Set();
        hasLoadedSessionList = false;
        setText('device-count', 'Connection unavailable');
        list.replaceChildren(el('div', 'empty', 'Could not verify device connections. Select Refresh to retry.'));
        updateGuided();
        throw error;
      }
      deviceStatusUnavailable = false;
      selected = data.selection;
      visibleSessionIds = new Set((Array.isArray(data.sessions) ? data.sessions : []).map((session) => session.sessionId));
      hasLoadedSessionList = true;
      // A remembered pairing is not a live connection or an authorized document.
      const sessions = Array.isArray(data.sessions) ? data.sessions : [];
      const online = sessions.filter((session) => session.connected);
      const offline = sessions.filter((session) => !session.connected);
      const selectedOnline = online.some((session) =>
        selected?.sessionId === session.sessionId &&
        selected.projectId === session.activeProject?.projectId &&
        selected.documentId === session.activeProject?.documentId);
      deviceLoaded = true;
      hasOnlineDevice = online.length > 0;
      hasPreviousPairings = offline.length > 0;
      hasSelectedDesign = selectedOnline;
      updateGuided();
      const pairingStatus = get('pairing-code');
      if (!online.length && pairingStatus?.textContent === 'Connected') {
        setText('pairing-code', 'Disconnected');
        setText('pairing-hint', 'EasyEDA is offline. An existing Cloud pairing can reconnect automatically. Generate a new code only if access was removed or pairing expired.');
      } else if (online.length && (pairingStatus?.textContent === 'Disconnected' || pairingStatus?.textContent === 'Connected')) {
        setText('pairing-code', 'Connected');
        setText('pairing-hint', selectedOnline
          ? 'Your EasyEDA device and selected design are ready for MCP calls.'
          : 'Your EasyEDA device is connected, but MCP access needs a project selection. Choose "Use this schematic" or "Use this PCB" on its device card; no new pairing code is needed.');
      }
      const workspaceGrid = get('workspace-grid');
      if (workspaceGrid) workspaceGrid.dataset.empty = online.length ? 'false' : 'true';
      setText('device-count', online.length + ' connected');
      list.replaceChildren();
      if (!sessions.length) {
        list.appendChild(el('div', 'empty', 'No devices connected. Select Generate pairing code in Connect EasyEDA to add your extension.'));
        return sessions;
      }
      if (!online.length && offline.length > 1) {
        list.appendChild(el('div', 'empty', 'No devices online. Reopen EasyEDA to reconnect a saved pairing, then choose the active design.'));
      }
      online.forEach((session) => list.appendChild(addSession(session)));
      if (offline.length && (online.length || offline.length > 1)) {
        const previous = el('details', 'device-history');
        previous.open = previousConnectionsOpen;
        previous.appendChild(el('summary', '', 'Previous connections (' + offline.length + ')'));
        previous.appendChild(el('p', 'device-history-note', 'Offline connections cannot receive tool calls. Remove access here to revoke an old pairing.'));
        offline.forEach((session) => previous.appendChild(addSession(session)));
        previous.addEventListener('toggle', () => { previousConnectionsOpen = previous.open; });
        list.appendChild(previous);
      } else {
        offline.forEach((session) => list.appendChild(addSession(session)));
      }
      return sessions;
    };
    let usagePending = false;
    const loadUsage = async () => {
      // A manual refresh and scheduled refresh must not race or duplicate API calls.
      if (usagePending) return;
      usagePending = true;
      try {
        const data = await request('/cloud/api/usage');
        if (!['total', 'succeeded', 'failed'].every((key) =>
          Number.isSafeInteger(data?.[key]) && data[key] >= 0) ||
          data.total !== data.succeeded + data.failed) {
          throw new Error('Unexpected Cloud usage response.');
        }
        setText('usage-total', data.total.toLocaleString());
        setText('usage-success', data.succeeded.toLocaleString());
        setText('usage-failed', data.failed.toLocaleString());
        const last = typeof data.lastCallAt === 'string' ? new Date(data.lastCallAt) : null;
        setText('usage-hint', last && !Number.isNaN(last.getTime())
          ? 'Last completed call: ' + last.toLocaleString()
          : 'No tool calls have completed yet.');
      } catch {
        setText('usage-hint', 'Usage is unavailable. Select Refresh to retry.');
      } finally {
        usagePending = false;
      }
    };
    let clientsPending = false;
    const loadClients = async () => {
      if (clientsPending) return;
      clientsPending = true;
      const dest = get('clients');
      try {
        const data = await request('/cloud/api/clients');
        const consents = Array.isArray(data?.clients) ? data.clients : [];
        clientsLoaded = true;
        clientStatusUnavailable = false;
        const readableClients = consents.filter((consent) => Array.isArray(consent?.scopes) &&
          (consent.scopes.includes('easyeda.read') || consent.scopes.includes('easyeda.project_admin')));
        readClientCount = readableClients.length;
        readClientNames = readableClients.map((consent) =>
          typeof consent.name === 'string' && consent.name.trim() ?
            consent.name.trim().slice(0, 64) : 'Unrecognized MCP client');
        updateGuided();
        dest.replaceChildren();
        if (!consents.length) { dest.appendChild(el('div','empty','No MCP clients have your authorization yet.')); return; }
        consents.forEach((consent) => {
          const card = el('div','session');
          const info = el('div');
          info.appendChild(el('strong','',consent.name || 'Unrecognized MCP client'));
          const scopes = new Set(Array.isArray(consent.scopes) ? consent.scopes.filter((s) => typeof s === 'string') : []);
          const hasAdmin = scopes.has('easyeda.project_admin');
          const canRead = scopes.has('easyeda.read') || hasAdmin;
          const canWrite = scopes.has('easyeda.write') || hasAdmin;
          const canExport = scopes.has('easyeda.export') || hasAdmin;
          const access = [canRead && 'Read', canWrite && 'Write', canExport && 'Export', hasAdmin && 'Admin'].filter(Boolean).join(' · ') || 'No EasyEDA scopes';
          info.appendChild(el('span', 'client-permission' + (canWrite && canExport ? '' : ' limited'), access));
          const absent = [!canWrite && 'easyeda.write', !canExport && 'easyeda.export'].filter(Boolean);
          info.appendChild(el('p', 'client-permission-help', absent.length
            ? 'To enable ' + (absent.length === 2 ? 'write and export' : (canWrite ? 'export' : 'write')) +
              ', reconnect from your MCP client requesting ' + absent.join(' and ') +
              '. Approve the new permissions when prompted. Eligible routine operations need one native approval per 30-minute project session.'
            : 'Write and export are authorized. EasyEDA asks once per project session for routine edits and local exports (separate grants, max 30 min). High-risk actions still require individual approval.'));
          card.appendChild(info);
          const manage = el('details', 'client-manage');
          manage.appendChild(el('summary', '', 'Manage access'));
          const permissions = el('div', 'client-scope-grid');
          [['Read', canRead], ['Write', canWrite], ['Export', canExport], ['Admin', hasAdmin]].forEach(([name, enabled]) => {
            permissions.appendChild(el('span', 'client-scope' + (enabled ? ' granted' : ''), name + (enabled ? ' ✓' : ' —')));
          });
          manage.appendChild(permissions);
          manage.appendChild(el('p', 'client-permission-help',
            'To change scopes, revoke this authorization and reconnect your MCP client. Revoking the client or device ends effective access. Native session approvals only cover verified, selected projects for up to 30 minutes; high-risk actions always ask again.'));
          if (typeof consent.id === 'string') {
            const revoke = el('button', 'btn danger small', 'Revoke access');
            revoke.type = 'button';
            let confirmRevoke = false;
            revoke.addEventListener('click', async () => {
              if (!confirmRevoke) {
                confirmRevoke = true;
                revoke.textContent = 'Confirm revoke';
                return;
              }
              revoke.disabled = true;
              try {
                await post('/api/auth/oauth2/delete-consent', { id: consent.id });
                await loadClients();
                setText('notice', 'MCP client access revoked. Reconnect it to authorize new permissions.');
              } catch (error) { fail(error); revoke.disabled = false; }
            });
            manage.appendChild(revoke);
          }
          card.appendChild(manage);
          dest.appendChild(card);
        });
      } catch (error) {
        clientsLoaded = false;
        clientStatusUnavailable = true;
        readClientCount = 0;
        readClientNames = [];
        updateGuided();
        dest.replaceChildren(el('div','empty','Client authorizations could not be loaded. Select Refresh to retry.'));
        throw error;
      } finally {
        clientsPending = false;
      }
    };
    (async () => {
      let ownerSignedIn = false;
      try {
        const me = await request('/cloud/api/me');
        ownerSignedIn = true;
        setText('account-name',me.user.name || me.user.email || 'Your account');
        const initialLoad = await Promise.allSettled([refreshExtensions(), loadClients(), loadUsage()]);
        if (initialLoad[0].status === 'rejected') fail(initialLoad[0].reason);
        if (initialLoad[1].status === 'rejected') fail(initialLoad[1].reason);
        // Refresh permission grants made in another OAuth tab when the owner
        // returns, as well as on the existing foreground polling interval.
        const refreshVisibleClients = () => {
          if (!document.hidden) void loadClients().catch(() => {
            // The Permissions card retains its manual Refresh fallback.
          });
        };
        document.addEventListener('visibilitychange', refreshVisibleClients);
        window.addEventListener('focus', refreshVisibleClients);
        // No polling in background tabs or after leaving the workspace.
        const usageTimer = setInterval(() => {
          if (!document.hidden) {
            void loadUsage();
            refreshVisibleClients();
            // A device can disconnect while this page remains open.
            void refreshExtensions().catch(() => {
              // Manual Refresh is available when a status poll fails.
            });
          }
        }, 30000);
        window.addEventListener('pagehide', () => {
          clearInterval(usageTimer);
          document.removeEventListener('visibilitychange', refreshVisibleClients);
          window.removeEventListener('focus', refreshVisibleClients);
        }, { once: true });
        const pair = get('generate-pairing');
        const copy = get('copy-pairing');
        let currentCode = '';
        let codeExpiresAt = 0;
        let expiryTimer = null;
        let lastPairingRefreshAt = 0;
        let pairingRefreshPending = false;
        let sessionsBeforePairing = null;
        const expireCode = () => {
          if (expiryTimer !== null) { clearInterval(expiryTimer); expiryTimer = null; }
          currentCode = '';
          codeExpiresAt = 0;
          setText('pairing-code', 'Expired');
          setText('pairing-hint', 'This code has expired. Generate a new code to pair your extension.');
          copy.disabled = true;
          copy.hidden = true;
        };
        const markPairingComplete = () => {
          if (expiryTimer !== null) { clearInterval(expiryTimer); expiryTimer = null; }
          currentCode = '';
          codeExpiresAt = 0;
          setText('pairing-code', 'Connected');
          setText('pairing-hint', 'Your EasyEDA device is connected. Choose its schematic or PCB to allow MCP access.');
          copy.disabled = true;
          copy.hidden = true;
          setText('notice', 'EasyEDA connected. Select the schematic or PCB you want to use.');
        };
        const updateExpiry = () => {
          const now = Date.now();
          const remaining = Math.max(0, Math.ceil((codeExpiresAt - now) / 1000));
          if (remaining === 0) { expireCode(); return; }
          const countdown = Math.floor(remaining / 60) + ':' + String(remaining % 60).padStart(2, '0');
          setText('pairing-hint', 'Expires in ' + countdown + '. Paste the code into EasyEDA. Your device appears automatically; then choose its schematic or PCB.');
          // Poll only while an owner-generated pairing code is live; no permanent background polling.
          if (now - lastPairingRefreshAt >= 5000 && !pairingRefreshPending) {
            lastPairingRefreshAt = now;
            pairingRefreshPending = true;
            void refreshExtensions().then((sessions) => {
              if (!currentCode || Date.now() >= codeExpiresAt) return;
              if (sessionsBeforePairing && sessions?.some((session) => session.connected &&
                  !sessionsBeforePairing.has(session.sessionId))) markPairingComplete();
            }).catch(() => {
              // Manual Refresh remains available if an intermittent network request fails.
            }).finally(() => {
              pairingRefreshPending = false;
            });
          }
        };
        copy.addEventListener('click', async () => {
          if (!currentCode || Date.now() >= codeExpiresAt) { expireCode(); return; }
          try {
            if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
            await navigator.clipboard.writeText(currentCode);
            setText('notice', 'Code copied. Paste it into EasyEDA MCP Bridge > Connect EasyEDA MCP Pro Cloud.');
          } catch {
            setText('notice', 'Clipboard unavailable. Select the displayed code to copy it manually.');
          }
        });
        pair.addEventListener('click',async () => {
          pair.disabled=true;
          try {
            const data=await post('/cloud/api/pairing-code',{});
            if (typeof data?.code !== 'string' || !/^EDA-[A-F0-9]{8}$/.test(data.code) ||
                !Number.isFinite(data.expiresInSeconds) || data.expiresInSeconds <= 0) {
              throw new Error('Cloud did not provide a valid pairing code.');
            }
            if (expiryTimer !== null) clearInterval(expiryTimer);
            sessionsBeforePairing = hasLoadedSessionList ? new Set(visibleSessionIds) : null;
            currentCode = data.code;
            codeExpiresAt = Date.now() + data.expiresInSeconds * 1000;
            lastPairingRefreshAt = Date.now();
            setText('pairing-code', currentCode);
            copy.disabled = false;
            copy.hidden = false;
            updateExpiry();
            expiryTimer = setInterval(updateExpiry, 1000);
            setText('notice','Pairing code created. Use it before it expires.');
          } catch(error) { fail(error); }
          finally { pair.disabled=false; }
        });
        get('refresh-clients').addEventListener('click', async () => {
          const button = get('refresh-clients');
          button.disabled = true;
          try {
            await loadClients();
            setText('notice', 'MCP client permissions updated.');
          } catch (error) { fail(error); }
          finally { button.disabled = false; }
        });
        get('refresh-usage').addEventListener('click', async () => {
          const button = get('refresh-usage');
          button.disabled = true;
          try { await loadUsage(); }
          finally { button.disabled = false; }
        });
        get('refresh-extensions').addEventListener('click', async () => {
          try { await refreshExtensions(); setText('notice', 'Device connections updated.'); }
          catch(error) { fail(error); }
        });
        get('sign-out').addEventListener('click',async () => {
          try {await post('/api/auth/sign-out',{});window.location.assign('/sign-in');}
          catch(error){fail(error);}
        });
      } catch (error) {
        if (!ownerSignedIn && error?.status === 401) window.location.assign('/sign-in');
        else fail(error);
      }
    })();
  }
})();
`;
