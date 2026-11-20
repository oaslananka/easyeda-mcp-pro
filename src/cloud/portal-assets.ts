/** Hosted-only, dependency-free assets. These remain embedded in the Node package build. */
export const CLOUD_CSS = String.raw`
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:dark;background:#080e1a;color:#f0f5ff;line-height:1.55}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;min-height:100vh;background:radial-gradient(ellipse 55% 48% at 95% 3%,#172e4b8c,transparent 88%),radial-gradient(ellipse 42% 42% at -10% 18%,#222b59a6,transparent 86%),#080e1a}
body:before{content:"";position:fixed;inset:0;pointer-events:none;z-index:-1;opacity:.18;background-image:radial-gradient(#556d90 0.6px,transparent .6px);background-size:24px 24px;mask-image:linear-gradient(to bottom,#000,transparent 65%)}
a{color:#b9dfff}a:hover{color:#e0f1ff}a:focus-visible,button:focus-visible{outline:3px solid #7dc9ff;outline-offset:4px}button{font:inherit}
.wrap{width:min(100% - 56px,1180px);margin:0 auto}
.nav{min-height:92px;display:flex;align-items:center;justify-content:space-between;gap:18px;border-bottom:1px solid #263148ad}
.brand{display:inline-flex;align-items:center;gap:12px;text-decoration:none;font-size:17px;font-weight:790;color:#f4f8ff;letter-spacing:-.035em}
.brand:hover{color:#fff}.brand-name span{color:#95b2d1}.mark{width:40px;height:40px;border-radius:13px;display:grid;place-items:center;font-weight:900;color:#071224;background:linear-gradient(145deg,#9de8ff,#6e8efe 73%);box-shadow:0 5px 25px #375cff3d}
.nav-right{display:flex;align-items:center;gap:21px}.tag,.step-indicator{font-size:11px;font-weight:760;letter-spacing:.1em;text-transform:uppercase;color:#a8bed7}
.tag{display:inline-flex;gap:9px;align-items:center;border:1px solid #40516c;border-radius:99px;padding:8px 12px;background:#1420347a}.tag-dot{width:7px;height:7px;background:#65dfbf;border-radius:50%;box-shadow:0 0 12px #38daa893}.nav-link{text-decoration:none;font-size:13px;color:#b8c8dc;font-weight:650}
main{padding:65px 0 74px}.eyebrow{font-size:11px;text-transform:uppercase;letter-spacing:.2em;color:#8ccff7;font-weight:800;margin:0 0 21px}
.hero{font-size:clamp(36px,4.35vw,62px);font-weight:790;letter-spacing:-.065em;line-height:1.1;margin:0 0 23px;max-width:720px;text-wrap:balance}
.subtitle{color:#b5c3d8;font-size:17px;max-width:610px;margin:0 0 34px;line-height:1.72}
.landing-grid{display:grid;grid-template-columns:minmax(0,1.18fr) minmax(335px,.82fr);gap:clamp(36px,6vw,88px);align-items:center;min-height:560px}
.landing-intro{min-width:0}.journey{display:grid;gap:0;max-width:570px}.journey-step{display:flex;align-items:center;gap:16px;padding:13px 0;border-top:1px solid #263750}.journey-step:last-child{border-bottom:1px solid #263750}.step-num{font-size:12px;font-weight:850;color:#8ecbff;letter-spacing:.1em;background:#132d45;width:39px;height:39px;display:grid;place-items:center;border:1px solid #2a526c;border-radius:11px;flex-shrink:0}.journey-step strong,.journey-step small{display:block}.journey-step strong{font-size:14px;font-weight:730}.journey-step small{font-size:12px;color:#a5b4cb;margin-top:1px}
.auth-card,.panel{border:1px solid #394960;background:linear-gradient(145deg,#172237 0%,#101927 65%,#0f1725 100%);box-shadow:0 25px 75px #0206107a,0 1px 0 #55749a25 inset;border-radius:24px}
.auth-card{padding:clamp(24px,3.2vw,39px);position:relative;overflow:hidden}.auth-card:before{content:"";position:absolute;inset:0 0 auto;height:3px;background:linear-gradient(90deg,#8bd8ff,#747cf6,#bb8efc)}.auth-card-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:31px}.auth-icon{background:#183651;border:1px solid #477398;color:#a6e7ff;width:54px;height:54px;border-radius:16px;display:grid;place-items:center;font-size:26px}
.auth-card h2{margin:0;font-size:29px;letter-spacing:-.045em}.auth-description{color:#b1bdd0;font-size:14px;margin:6px 0 28px}
.auth-buttons{display:grid;gap:12px}.btn{min-height:46px;display:inline-flex;align-items:center;justify-content:center;gap:12px;cursor:pointer;border:1px solid transparent;border-radius:12px;padding:12px 17px;background:linear-gradient(135deg,#88d9ff,#8da8ff);color:#071425;font-weight:760;text-decoration:none;transition:background-color .16s,border-color .16s,transform .16s}
.btn:hover{background:#c1e8ff}.btn:active{transform:translateY(1px)}.btn.secondary{background:#1b2a40;color:#ecf4ff;border-color:#47607f}.btn.secondary:hover{background:#283a54}.btn.subtle{background:#1b293d;color:#cfe1f8;border-color:#394e68}.btn.subtle:hover{background:#283a54}.btn.small{min-height:38px;padding:8px 13px;font-size:12px}.btn.danger{background:#392433;color:#ffd8e2;border-color:#714257}.btn.danger:hover{background:#542b42}.btn:disabled{opacity:.55;cursor:default;transform:none}
.provider-button{min-height:59px;display:grid;grid-template-columns:35px 1fr 17px;text-align:left;justify-items:start;width:100%;padding:9px 17px}.provider-button .provider-mark{font-size:11px;font-weight:850;display:grid;place-items:center;width:32px;height:32px;border-radius:10px;background:#111d32;color:#fff}.provider-button.secondary .provider-mark{background:#f8fafc;color:#3373ed;font-size:20px}.button-arrow{justify-self:end;font-size:17px}
.auth-card-foot{display:flex;gap:11px;align-items:flex-start;border-top:1px solid #344258;margin-top:27px;padding-top:23px;color:#aabbd2;font-size:12px;line-height:1.7}.privacy-icon{flex-shrink:0;display:grid;place-items:center;width:22px;height:22px;background:#183b40;color:#6fdfc0;border-radius:50%;font-weight:800}
.trust-strip{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin-top:60px;gap:20px}.trust-strip>div{display:flex;gap:13px;align-items:center;border:1px solid #283c55;background:#111d2c91;border-radius:16px;padding:19px}.trust-mark{display:grid;place-items:center;border:1px solid #355571;background:#152c41;color:#98d8ff;border-radius:12px;min-width:42px;height:42px;font-size:21px}.trust-strip strong,.trust-strip small{display:block}.trust-strip strong{font-size:13px}.trust-strip small{font-size:11px;color:#a4b4cc;line-height:1.45;margin-top:2px}
footer{padding:29px 0 38px;display:flex;align-items:center;justify-content:space-between;gap:15px;border-top:1px solid #27354b;font-size:12px;color:#8ca0ba}footer a{color:#b3c9e6;text-decoration:none}
.workspace-head{display:flex;justify-content:space-between;align-items:center;gap:22px;margin-bottom:32px}.workspace-title{font-size:clamp(34px,4vw,47px);line-height:1.1;letter-spacing:-.055em;margin:0 0 12px}.workspace-desc{color:#adbdd2;font-size:15px;max-width:660px;margin:0}.account-identity{border:1px solid #34495f;background:#142239;border-radius:14px;padding:11px 15px;display:flex;gap:11px;align-items:center;min-width:200px}.account-identity small,.account-identity strong{display:block}.account-identity small{font-size:11px;color:#98aeca}.account-identity strong{font-size:13px;color:#e7f3ff;word-break:break-word}.identity-avatar{color:#86d1ff;font-size:15px;background:#233e5d;display:grid;place-items:center;width:36px;height:36px;border-radius:11px}
.workspace-grid{display:grid;grid-template-columns:minmax(0,1.22fr) minmax(320px,.78fr);align-items:start;gap:22px}.panel{padding:27px;max-width:none}.panel h2{font-size:19px;letter-spacing:-.035em;margin:0;line-height:1.35}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.section-kicker{margin:0 0 6px;color:#83c9ec;letter-spacing:.15em;font-size:10px;font-weight:800}.section-description{color:#a9b9cf;font-size:13px;line-height:1.65;margin:12px 0 22px}.count{display:inline-flex;vertical-align:middle;margin-left:7px;padding:3px 8px;border:1px solid #45627e;border-radius:7px;color:#b8d4f3;font-size:12px;font-weight:700}
.device-history{border:1px solid #344963;border-radius:14px;padding:9px 12px;background:#0e1b2c}.device-history>summary{cursor:pointer;color:#c6e3ff;font-weight:720;font-size:13px;padding:9px 6px;min-height:42px}.device-history>summary:focus-visible{outline:3px solid #7dc9ff;outline-offset:2px}.device-history[open]{display:grid;gap:11px}.device-history .session{margin-top:4px}.device-history-note{color:#aabed6;font-size:12px;line-height:1.55;margin:4px 6px 8px}
.device-list{display:grid;gap:12px}.empty{padding:28px 20px;background:#0c1625;border:1px dashed #39516a;border-radius:15px;color:#b3c4db;font-size:13px;line-height:1.6}.device-list .empty{min-height:138px;display:flex;align-items:center;justify-content:center;text-align:center}
.session{display:flex;gap:16px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;background:#111e30;border:1px solid #344963;border-radius:15px;padding:18px}.session strong{font-size:13px;word-break:break-word}.session p{color:#9cafc8;font-size:12px;margin:6px 0}.session>div{min-width:0}.session-revoke-confirm{flex:1 0 100%;border-top:1px solid #344963;padding-top:12px}.session-revoke-confirm p{margin:0 0 11px;color:#e1c8d2;font-size:12px;line-height:1.6}.client-permission{display:inline-flex;align-items:center;border:1px solid #356e61;background:#163a34;color:#baf5df;border-radius:999px;padding:4px 10px;font-size:11px;font-weight:750;margin:9px 0 2px}.client-permission.limited{border-color:#655333;background:#352d1d;color:#f7dca0}.session p.client-permission-help{line-height:1.55;max-width:560px;color:#bdcfe5;margin-top:8px}.session-actions{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.session .btn{min-height:37px;font-size:12px;padding:8px 12px}.status{display:inline-flex;gap:6px;align-items:center;font-size:11px;font-weight:720;padding:4px 10px;border:1px solid #315f55;border-radius:999px;background:#173b38;color:#8fe8cd}.status.off{border-color:#604655;background:#3b2c3b;color:#f4c4d3}
.setup-steps{display:grid;gap:0;margin:18px 0}.setup-steps p{display:grid;grid-template-columns:26px minmax(0,1fr);align-items:start;gap:13px;border-bottom:1px solid #2a3e55;margin:0;padding:14px 0;font-size:12px;color:#b5c8df}.setup-steps strong{color:#e0ecfd;font-weight:700}.setup-steps p>span:first-child{border:1px solid #385773;background:#172d44;color:#aad7f4;width:26px;height:26px;border-radius:8px;display:grid;place-items:center;font-weight:800}.setup-steps .step-copy{min-width:0;line-height:1.6;overflow-wrap:break-word}.setup-steps .step-copy a{font-weight:750;text-underline-offset:3px}.pair-button{width:100%;justify-content:space-between;padding:14px 17px;margin:7px 0 16px}.pairing-actions{display:flex;align-items:center;flex-wrap:wrap;gap:10px}.code{display:inline-flex;align-items:center;justify-content:center;max-width:100%;letter-spacing:.12em;font-size:23px;font-weight:850;color:#dbefff;background:#091322;border:1px solid #3d5672;border-radius:10px;min-height:52px;padding:8px 15px;margin:0;user-select:all;word-break:break-all}.muted,.meta{color:#a7b7cb;font-size:12px}.pairing-panel .muted{line-height:1.65}.usage-panel{margin-top:22px}.usage-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.usage-stat{padding:18px;background:#0e1a2b;border:1px solid #334a65;border-radius:14px}.usage-stat strong{display:block;font-size:32px;line-height:1.1;letter-spacing:-.05em;color:#e6f5ff;font-variant-numeric:tabular-nums}.usage-stat span{display:block;color:#abc0d9;font-size:12px;margin-top:9px}.usage-panel .muted{margin:14px 0 0}.clients-panel{margin-top:22px}.clients-panel .empty{padding:18px}.account-actions{display:flex;justify-content:flex-end;margin-top:24px}
.notice{background:#162a3e;border:1px solid #41607c;color:#cde3f9;border-radius:12px;padding:13px 16px;font-size:13px}.notice.error{background:#3b2638;border-color:#94576e;color:#ffdbec}
.scopes{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:10px;list-style:none;padding:0;margin:18px 0}.scopes li{border:1px solid #3b526c;border-radius:10px;padding:12px 14px;background:#19273b;font-size:13px}.scopes li strong,.scopes li small,.scopes li code{display:block}
.scope-option{display:flex;gap:12px;align-items:flex-start;cursor:pointer;min-height:44px}
.scope-option input{width:19px;height:19px;accent-color:#8acfff;flex:0 0 19px;margin:2px 0 0}
.scope-option input:focus-visible{outline:3px solid #7dc9ff;outline-offset:3px}
.scope-option span{min-width:0}
.scopes li strong{color:#eef5ff;font-size:13px}.scopes li small{color:#b6c8df;font-size:12px;line-height:1.55;margin-top:5px}.scopes li code{color:#9ab2d0;font-size:10px;overflow-wrap:anywhere;margin-top:10px}.segment{border-top:1px solid #33435a;margin-top:23px;padding-top:23px}
[hidden]{display:none!important}

/* A separate color identity for each real user task, not additional cards or flows. */
.panel{position:relative;overflow:hidden}
.device-panel{background:radial-gradient(ellipse 72% 75% at -15% -15%,#173d46b0,transparent 75%),linear-gradient(145deg,#152437,#111a2a)}
.pairing-panel{background:radial-gradient(ellipse 72% 75% at 110% -10%,#34305f91,transparent 75%),linear-gradient(145deg,#1a2239,#111827)}
.clients-panel{background:radial-gradient(ellipse 45% 80% at 100% 0%,#2d324b82,transparent 75%),linear-gradient(145deg,#182337,#101928)}
.device-panel:before,.pairing-panel:before,.clients-panel:before{content:"";position:absolute;inset:0 0 auto;height:3px}
.device-panel:before{background:linear-gradient(90deg,#69dabe,#56b7eb,transparent 85%)}
.pairing-panel:before{background:linear-gradient(90deg,#818cfb,#bf91f6,transparent 85%)}
.clients-panel:before{background:linear-gradient(90deg,#8cb8f4,#b1c1ed,transparent 85%)}
.client-manage{width:100%;margin-top:9px;border-top:1px solid #334963;padding-top:12px}
.client-manage summary{cursor:pointer;display:inline-flex;align-items:center;color:#bfe2ff;font-size:13px;font-weight:750;padding:10px 4px;min-height:44px}
.client-manage summary:focus-visible{outline:3px solid #7dc9ff;outline-offset:3px}
.client-scope-grid{display:flex;gap:9px;flex-wrap:wrap;margin:12px 0}
.client-scope{border:1px solid #526073;color:#91a3ba;padding:7px 11px;border-radius:8px;font-size:12px}
.client-scope.granted{border-color:#488a79;background:#143a34;color:#a7f3dc}
.client-manage .btn.danger{margin-top:12px}

.usage-panel:before{content:"";position:absolute;inset:0 0 auto;height:3px;background:linear-gradient(90deg,#69bdf5,#92a8ed,transparent 85%)}
.section-description{font-size:14px}
.setup-steps p{font-size:13px}
.session strong{font-size:14px}.session p{font-size:13px}
.provider-button .provider-mark svg{display:block}
.provider-button.secondary .provider-mark.google-mark{background:#f8fafc;color:#3978ec}

.guided-panel{padding:clamp(22px,3vw,35px);margin-bottom:20px;border-color:#45647d;background:radial-gradient(ellipse 40% 90% at 0% 0%,#19425575,transparent 80%),linear-gradient(145deg,#162436,#101b2b)}
.guided-panel .section-heading{margin-bottom:7px}.guided-panel h2{letter-spacing:-.035em}.guided-panel .section-description{max-width:750px;margin:0 0 19px}
.guided-progress{padding:0;margin:0 0 25px;list-style:none;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px}
.guided-progress li{display:flex;gap:9px;align-items:center;min-width:0;font-size:12px;color:#8eabc8;padding:11px;border:1px solid #35475b;border-radius:11px;background:#112133}
.guided-progress .guided-number{flex-shrink:0;display:grid;place-items:center;width:25px;height:25px;border-radius:8px;background:#233a52;font-weight:800}
.guided-progress li[data-state="done"]{border-color:#38796b;background:#17372f;color:#b8f5dd}.guided-progress li[data-state="done"] .guided-number{background:#265a4b}
.guided-progress li[data-state="current"]{border-color:#82cfff;background:#153751;color:#eef7ff}.guided-progress li[data-state="current"] .guided-number{background:#38739b}
.guided-grid{display:grid;grid-template-columns:minmax(0,1.22fr) minmax(0,.78fr);gap:22px}
.guided-choice,.guided-status{min-width:0}.guided-choice h3{font-size:14px;margin:0 0 11px;font-weight:760}
.client-chooser{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:13px}
.client-choice{border:1px solid #425775;border-radius:10px;background:#182b41;color:#bfd3ec;padding:10px 13px;min-height:44px;cursor:pointer;font-size:13px;font-weight:700}
.client-choice[aria-pressed="true"]{background:#a2dcff;color:#092439;border-color:#a2dcff}
.client-choice:hover{border-color:#9ad5ff}.client-choice:focus-visible{outline:3px solid #7dc9ff;outline-offset:2px}
.guided-instructions{border:1px solid #3d526e;background:#0d192c;border-radius:13px;padding:17px;min-width:0}
.guided-instructions strong{font-size:14px}.guided-instructions p{line-height:1.6;margin:6px 0 12px}
.guided-config{display:block;white-space:pre-wrap;overflow-wrap:anywhere;background:#050e1b;color:#b7e5fe;border:1px solid #304764;border-radius:9px;font-size:12px;max-height:160px;overflow:auto;padding:12px;user-select:all}
.guided-actions{display:flex;flex-wrap:wrap;gap:9px;margin-top:12px}.guided-actions .btn{min-height:42px}
.guided-status{border:1px solid #334965;border-radius:13px;background:#111f31;padding:5px 17px}
.guided-status-line{padding:13px 0;border-bottom:1px solid #31445c;display:flex;flex-direction:column;align-items:flex-start;gap:4px}
.guided-status-line:last-child{border-bottom:0}.guided-status-line>span{font-size:11px;text-transform:uppercase;color:#8eadcf;font-weight:760;letter-spacing:.065em}
.guided-status-line strong{font-size:13px;color:#e5f3ff}.guided-status-line a{font-size:12px;text-underline-offset:3px}
.guided-status-line p{margin:3px 0 6px;font-size:12px}.guided-hint{margin:17px 0 0;border-top:1px solid #2c4964;padding-top:14px;color:#a9dff9;font-size:13px}
.consent-advanced{border:1px solid #405572;border-radius:13px;padding:12px 16px;margin:12px 0 19px;background:#16263b}
.consent-advanced summary{cursor:pointer;min-height:30px;font-size:14px;font-weight:750;color:#cdeaff}.consent-advanced summary:focus-visible{outline:3px solid #7dc9ff;outline-offset:3px}
@media(max-width:960px){.guided-grid{grid-template-columns:1fr}}
@media(max-width:640px){.guided-progress{grid-template-columns:repeat(2,minmax(0,1fr))}.guided-progress li{padding:9px}.guided-panel{padding:18px}.guided-actions>.btn{flex:1 1 160px}.guided-status{padding:5px 12px}}
@media(max-width:960px){.landing-grid{grid-template-columns:1fr;gap:32px;min-height:0}.landing-intro{max-width:690px}.auth-card{max-width:600px}.workspace-grid{grid-template-columns:1fr}.trust-strip{margin-top:40px}}
@media(max-width:640px){.landing-intro .journey{display:none}.workspace-grid[data-empty="true"] .pairing-panel{grid-row:1}.workspace-grid[data-empty="true"] .device-panel{grid-row:2}.wrap{width:min(100% - 28px,1180px)}.nav{min-height:75px}.nav-right{gap:9px}.tag{display:none}.nav-link{font-size:12px}main{padding:35px 0 52px}.hero{font-size:clamp(35px,9vw,48px)}.subtitle{font-size:15px}.auth-card,.panel{padding:22px;border-radius:18px}.trust-strip{grid-template-columns:1fr;gap:10px}.workspace-head{flex-direction:column;align-items:stretch}.account-identity{width:100%}.section-heading{align-items:flex-start}.section-heading>.btn{flex-shrink:0}.session{flex-direction:column;align-items:stretch}.session button{width:100%}.session-actions{width:100%;flex-direction:column;align-items:stretch}.code{font-size:19px}.usage-grid{grid-template-columns:1fr 1fr 1fr;gap:7px}.usage-stat{padding:12px}.usage-stat strong{font-size:25px}.usage-stat span{font-size:10px}footer{flex-direction:column;align-items:flex-start}}
@media(max-width:400px){
  main{padding-top:24px}
  .eyebrow{margin-bottom:12px}
  .hero{font-size:clamp(30px,8.7vw,35px);line-height:1.12;margin-bottom:15px}
  .subtitle{font-size:14px;line-height:1.58;margin-bottom:20px}
  .landing-grid{gap:20px}
  .auth-card,.panel{padding:18px}
  .auth-card-top{margin-bottom:18px}
  .auth-card h2{font-size:25px}
  .auth-description{margin-bottom:17px}
  .workspace-head{margin-bottom:20px}
  .workspace-title{font-size:33px}
  .workspace-desc{font-size:14px}
  .setup-steps{margin:12px 0}
  .setup-steps p{padding:11px 0}
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
    let hasOnlineDevice = false;
    let hasPreviousPairings = false;
    let hasSelectedDesign = false;
    let readClientCount = 0;
    let readClientNames = [];
    // OAuth grants are authoritative; client display names are only a UI cue,
    // never a security boundary or proof that the selected app is connected.
    const selectedClientHasReadAccess = () => readClientCount > 0 &&
      (selectedClient === 'other' || readClientNames.some((name) =>
        name.toLowerCase().includes(selectedClient)));
    const updateGuided = () => {
      const chosenClientName = clientOptions[selectedClient].name;
      const chosenClientHasReadAccess = selectedClientHasReadAccess();
      const deviceStage = get('progress-device');
      const accessStage = get('progress-access');
      const questionStage = get('progress-ask');
      if (deviceStage) deviceStage.dataset.state = hasSelectedDesign ? 'done' : 'current';
      if (accessStage) accessStage.dataset.state = chosenClientHasReadAccess && hasSelectedDesign ? 'done' : hasSelectedDesign ? 'current' : 'waiting';
      // The sample question still needs to be asked inside the actual MCP client.
      if (questionStage) questionStage.dataset.state = hasSelectedDesign && chosenClientHasReadAccess ? 'current' : 'waiting';
      setText('guided-device-status', !deviceLoaded ? 'Checking connection…' :
        hasSelectedDesign ? 'Connected · design selected' : hasOnlineDevice ? 'Connected · choose a design below' :
        hasPreviousPairings ? 'Saved pairing offline' : 'Not connected');
      setText('guided-access-status', !clientsLoaded ? 'Checking authorization…' :
        readClientCount ? 'Read access: ' + readClientNames.slice(0, 2).join(' · ') +
          (readClientCount > 2 ? ' +' + (readClientCount - 2) : '') : 'No MCP client authorized yet');
      const prompt = get('copy-first-question');
      if (prompt) prompt.disabled = !hasSelectedDesign || !chosenClientHasReadAccess;
      const connect = get('guided-connect-link');
      if (connect) {
        connect.textContent = hasOnlineDevice ? 'Choose the open design ↓' :
          hasPreviousPairings ? 'Reconnect EasyEDA ↓' : 'Connect EasyEDA ↓';
        connect.href = hasOnlineDevice || hasPreviousPairings ? '#extensions-title' : '#pair-title';
      }
      setText('guided-hint', !deviceLoaded || !clientsLoaded ? 'Checking your connection and permissions…' :
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
      const data = await request('/cloud/api/extensions');
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
