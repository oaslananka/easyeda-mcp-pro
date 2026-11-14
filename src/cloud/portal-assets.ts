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
.device-list{display:grid;gap:12px}.empty{padding:28px 20px;background:#0c1625;border:1px dashed #39516a;border-radius:15px;color:#b3c4db;font-size:13px;line-height:1.6}.device-list .empty{min-height:138px;display:flex;align-items:center;justify-content:center;text-align:center}
.session{display:flex;gap:16px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;background:#111e30;border:1px solid #344963;border-radius:15px;padding:18px}.session strong{font-size:13px;word-break:break-word}.session p{color:#9cafc8;font-size:12px;margin:6px 0}.session>div{min-width:0}.session-actions{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.session .btn{min-height:37px;font-size:12px;padding:8px 12px}.status{display:inline-flex;gap:6px;align-items:center;font-size:11px;font-weight:720;padding:4px 10px;border:1px solid #315f55;border-radius:999px;background:#173b38;color:#8fe8cd}.status.off{border-color:#604655;background:#3b2c3b;color:#f4c4d3}
.setup-steps{display:grid;gap:0;margin:18px 0}.setup-steps p{display:flex;align-items:center;gap:13px;border-bottom:1px solid #2a3e55;margin:0;padding:14px 0;font-size:12px;color:#b5c8df}.setup-steps strong{color:#e0ecfd;font-weight:700}.setup-steps p>span{border:1px solid #385773;background:#172d44;color:#aad7f4;width:26px;height:26px;border-radius:8px;display:grid;place-items:center;flex-shrink:0;font-weight:800}.pair-button{width:100%;justify-content:space-between;padding:14px 17px;margin:7px 0 16px}.pairing-actions{display:flex;align-items:center;flex-wrap:wrap;gap:10px}.code{display:inline-flex;align-items:center;justify-content:center;max-width:100%;letter-spacing:.12em;font-size:23px;font-weight:850;color:#dbefff;background:#091322;border:1px solid #3d5672;border-radius:10px;min-height:52px;padding:8px 15px;margin:0;user-select:all;word-break:break-all}.muted,.meta{color:#a7b7cb;font-size:12px}.pairing-panel .muted{line-height:1.65}.clients-panel{margin-top:22px}.clients-panel .empty{padding:18px}.account-actions{display:flex;justify-content:flex-end;margin-top:24px}
.notice{background:#162a3e;border:1px solid #41607c;color:#cde3f9;border-radius:12px;padding:13px 16px;font-size:13px}.notice.error{background:#3b2638;border-color:#94576e;color:#ffdbec}
.scopes{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:10px;list-style:none;padding:0;margin:18px 0}.scopes li{border:1px solid #3b526c;border-radius:10px;padding:12px 14px;background:#19273b;font-size:13px}.segment{border-top:1px solid #33435a;margin-top:23px;padding-top:23px}
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
.section-description{font-size:14px}
.setup-steps p{font-size:13px}
.session strong{font-size:14px}.session p{font-size:13px}
.provider-button .provider-mark svg{display:block}
.provider-button.secondary .provider-mark.google-mark{background:#f8fafc;color:#3978ec}
@media(max-width:960px){.landing-grid{grid-template-columns:1fr;gap:32px;min-height:0}.landing-intro{max-width:690px}.auth-card{max-width:600px}.workspace-grid{grid-template-columns:1fr}.trust-strip{margin-top:40px}}
@media(max-width:640px){.landing-intro .journey{display:none}.workspace-grid[data-empty="true"] .pairing-panel{grid-row:1}.workspace-grid[data-empty="true"] .device-panel{grid-row:2}.wrap{width:min(100% - 28px,1180px)}.nav{min-height:75px}.nav-right{gap:9px}.tag{display:none}.nav-link{font-size:12px}main{padding:35px 0 52px}.hero{font-size:clamp(35px,9vw,48px)}.subtitle{font-size:15px}.auth-card,.panel{padding:22px;border-radius:18px}.trust-strip{grid-template-columns:1fr;gap:10px}.workspace-head{flex-direction:column;align-items:stretch}.account-identity{width:100%}.section-heading{align-items:flex-start}.section-heading>.btn{flex-shrink:0}.session{flex-direction:column;align-items:stretch}.session button{width:100%}.session-actions{width:100%;flex-direction:column;align-items:stretch}.code{font-size:19px}footer{flex-direction:column;align-items:flex-start}}
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
    const response = await fetch(url, { credentials: 'same-origin', ...options });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(typeof result?.message === 'string' ? result.message : 'Request failed (' + response.status + ').');
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
          const result = await post('/api/auth/oauth2/consent', {
            accept: button.dataset.consent === 'allow',
            oauth_query: query,
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
    const list = get('extensions');
    let selected = null;
    const addSession = (s) => {
      const card = el('div','session');
      const info = el('div');
      info.appendChild(el('strong','', s.activeProject?.projectName || 'EasyEDA extension'));
      info.appendChild(el('p','', 'Version ' + s.extensionVersion + ' · ' + (s.mode === 'hosted' ? 'Cloud relay' : 'Remote relay')));
      const state = el('span', 'status' + (s.connected ? '' : ' off'), s.connected ? 'Connected' : 'Disconnected');
      info.appendChild(state);
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
      revoke.addEventListener('click', async () => {
        revoke.disabled = true;
        try {
          await request('/cloud/api/extensions/' + encodeURIComponent(s.sessionId), { method: 'DELETE' });
          await refreshExtensions();
          setText('notice','Extension access removed.');
        } catch (error) { fail(error); revoke.disabled = false; }
      });
      card.appendChild(revoke);
      return card;
    };
    const refreshExtensions = async () => {
      const data = await request('/cloud/api/extensions');
      selected = data.selection;
      const workspaceGrid = get('workspace-grid');
      if (workspaceGrid) workspaceGrid.dataset.empty = data.sessions?.length ? 'false' : 'true';
      setText('device-count', Array.isArray(data.sessions) ? data.sessions.length : 0);
      list.replaceChildren();
      if (!data.sessions?.length) {
        list.appendChild(el('div', 'empty', 'No devices connected. Select Generate pairing code in Connect EasyEDA to add your extension.'));
        return;
      }
      data.sessions.forEach((session) => list.appendChild(addSession(session)));
    };
    const loadClients = async () => {
      const dest = get('clients');
      try {
        const data = await request('/cloud/api/clients');
        const consents = Array.isArray(data?.clients) ? data.clients : [];
        dest.replaceChildren();
        if (!consents.length) { dest.appendChild(el('div','empty','No MCP clients have your authorization yet.')); return; }
        consents.forEach((consent) => {
          const card = el('div','session');
          const info = el('div');
          info.appendChild(el('strong','',consent.name || 'Unrecognized MCP client'));
          info.appendChild(el('p','',Array.isArray(consent.scopes) ? consent.scopes.join(' · ') : 'Authorized via OAuth'));
          card.appendChild(info);
          if (typeof consent.id === 'string') {
            const revoke = el('button','btn danger','Revoke');
            revoke.type = 'button';
            revoke.addEventListener('click', async () => {
              revoke.disabled = true;
              try { await post('/api/auth/oauth2/delete-consent',{id:consent.id}); await loadClients(); }
              catch (error) { fail(error); revoke.disabled = false; }
            });
            card.appendChild(revoke);
          }
          dest.appendChild(card);
        });
      } catch { dest.replaceChildren(el('div','empty','Client authorizations could not be loaded. Retry the page.')); }
    };
    (async () => {
      try {
        const me = await request('/cloud/api/me');
        setText('account-name',me.user.name || me.user.email || 'Your account');
        await Promise.all([refreshExtensions(),loadClients()]);
        const pair = get('generate-pairing');
        const copy = get('copy-pairing');
        let currentCode = '';
        let codeExpiresAt = 0;
        let expiryTimer = null;
        const expireCode = () => {
          if (expiryTimer !== null) { clearInterval(expiryTimer); expiryTimer = null; }
          currentCode = '';
          codeExpiresAt = 0;
          setText('pairing-code', 'Expired');
          setText('pairing-hint', 'This code has expired. Generate a new code to pair your extension.');
          copy.disabled = true;
          copy.hidden = true;
        };
        const updateExpiry = () => {
          const remaining = Math.max(0, Math.ceil((codeExpiresAt - Date.now()) / 1000));
          if (remaining === 0) { expireCode(); return; }
          const countdown = Math.floor(remaining / 60) + ':' + String(remaining % 60).padStart(2, '0');
          setText('pairing-hint', 'Expires in ' + countdown + '. Paste the code into EasyEDA, then select Refresh connections.');
        };
        copy.addEventListener('click', async () => {
          if (!currentCode || Date.now() >= codeExpiresAt) { expireCode(); return; }
          try {
            if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
            await navigator.clipboard.writeText(currentCode);
            setText('notice', 'Code copied. Paste it into EasyEDA MCP Bridge > Connect Cloud.');
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
            currentCode = data.code;
            codeExpiresAt = Date.now() + data.expiresInSeconds * 1000;
            setText('pairing-code', currentCode);
            copy.disabled = false;
            copy.hidden = false;
            updateExpiry();
            expiryTimer = setInterval(updateExpiry, 1000);
            setText('notice','Pairing code created. Use it before it expires.');
          } catch(error) { fail(error); }
          finally { pair.disabled=false; }
        });
        get('refresh-extensions').addEventListener('click', async () => {
          try {await refreshExtensions();} catch(error) { fail(error); }
        });
        get('sign-out').addEventListener('click',async () => {
          try {await post('/api/auth/sign-out',{});window.location.assign('/sign-in');}
          catch(error){fail(error);}
        });
      } catch {
        window.location.assign('/sign-in');
      }
    })();
  }
})();
`;
