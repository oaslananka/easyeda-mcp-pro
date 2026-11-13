/** Hosted-only, dependency-free assets. These remain embedded in the Node package build. */
export const CLOUD_CSS = String.raw`
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:dark;background:#080b15;color:#ecf0fc;line-height:1.5}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(ellipse at 5% -12%,#293a68 0%,transparent 41%),radial-gradient(ellipse at 105% 85%,#233441 0%,transparent 47%),#080b15}
a{color:#c6d8ff}a:focus-visible,button:focus-visible{outline:3px solid #a9c6ff;outline-offset:4px}
.wrap{width:min(100% - 40px,990px);margin:0 auto}.nav{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:30px 0}.brand{display:inline-flex;align-items:center;gap:12px;text-decoration:none;font-weight:750;color:#f7f9ff;letter-spacing:-.02em}.mark{width:34px;height:34px;border-radius:12px;background:linear-gradient(135deg,#8fbaff,#545ed3);color:#0a1232;display:grid;place-items:center;font-weight:900}.tag{font-size:12px;color:#c9d3ef;border:1px solid #53637f;border-radius:99px;padding:5px 10px;letter-spacing:.04em}
main{padding:clamp(42px,8vw,95px) 0 70px}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.17em;color:#9dbbff;font-weight:700;margin:0 0 16px}.hero{max-width:760px;font-size:clamp(36px,6vw,62px);font-weight:760;letter-spacing:-.055em;line-height:1.08;margin:0 0 18px}.subtitle{color:#b6c0d7;font-size:17px;max-width:650px;margin:0 0 32px}
.panel{background:linear-gradient(145deg,#171e31,#101724);border:1px solid #37415d;border-radius:22px;box-shadow:0 15px 60px #02051470;padding:clamp(22px,4vw,36px);max-width:690px}
.wide{max-width:990px}.account-client-panel{max-width:990px;margin-top:18px}.panel h2{font-size:21px;letter-spacing:-.025em;margin:0 0 10px}.muted,.meta{color:#a7b3cc}.muted{font-size:14px}.actions{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0 0}.btn{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:10px;border-radius:11px;font:inherit;font-weight:700;padding:13px 19px;background:#8fb8ff;color:#101627;border:1px solid transparent;min-height:46px;text-decoration:none}.btn:hover{background:#bbd4ff}.btn.secondary{background:#242d42;color:#e4eaff;border-color:#536079}.btn.secondary:hover{background:#343f56}.btn.danger{background:#382736;border-color:#67485b;color:#ffd7e5}.btn.danger:hover{background:#563044}.btn:disabled{opacity:.65;cursor:wait}
.notice{border:1px solid #425477;border-radius:13px;padding:13px 16px;background:#1c2940;color:#cee0ff;font-size:14px}.notice.error{border-color:#86465c;background:#3c2030;color:#ffdee9}
.segment{border-top:1px solid #36415a;margin-top:22px;padding-top:22px}.scopes{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:10px;list-style:none;padding:0;margin:18px 0}.scopes li{border:1px solid #384662;border-radius:10px;padding:12px 14px;background:#192236;font-size:14px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:18px}.columns{display:grid;grid-template-columns:1fr 1fr;gap:18px}.stack{display:grid;gap:12px}.empty{border:1px dashed #57617a;border-radius:12px;padding:20px;color:#b8c4dc;font-size:14px}.session{display:flex;justify-content:space-between;gap:16px;align-items:center;padding:16px;border:1px solid #36435d;border-radius:13px;margin:11px 0}.session p{margin:4px 0 0;font-size:13px;color:#a7b4cc}.session strong{word-break:break-word}.status{font-size:12px;border-radius:99px;padding:4px 9px;background:#263c3a;color:#b7f1cd}.status.off{background:#392d39;color:#ffd0e4}
.code{display:inline-block;letter-spacing:.16em;font-size:24px;font-weight:800;background:#0b101c;border:1px solid #53607f;padding:14px 17px;border-radius:10px;user-select:all}
footer{color:#8390aa;font-size:13px;padding:36px 0}.loading{opacity:.65}
@media (max-width:680px){.nav{padding:22px 0}.tag{display:none}.columns,.cols{grid-template-columns:1fr}.session{align-items:flex-start;flex-direction:column}.session button{width:100%}.wrap{width:min(100% - 28px,990px)}main{padding:32px 0 55px}}
@media (prefers-reduced-motion:no-preference){button,a{transition:background-color .16s ease}}
`;

export const CLOUD_JS = String.raw`
(() => {
  "use strict";
  const root = document.getElementById('cloud-root');
  if (!root) return;
  const page = root.dataset.page;
  const query = window.location.search.slice(1);
  const get = (id) => document.getElementById(id);
  const setText = (id, value) => { const el = get(id); if (el) el.textContent = String(value); };
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
          (selected.projectId || selected.projectName) === (s.activeProject.projectId || s.activeProject.projectName);
        const choose = el('button','btn secondary', isSelected ? 'Selected project' : 'Use this project');
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
            setText('notice', 'Project selected. MCP calls will target this extension and its current project.');
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
      list.replaceChildren();
      if (!data.sessions?.length) {
        list.appendChild(el('div', 'empty', 'No linked extensions yet. Generate a code below, then opt in to Cloud from your EasyEDA extension.'));
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
        pair.addEventListener('click',async () => {
          pair.disabled=true;
          try {
            const data=await post('/cloud/api/pairing-code',{});
            setText('pairing-code',data.code);
            setText('pairing-hint','Use this one-time code in the EasyEDA extension within 10 minutes. Cloud access is opt-in.');
            setText('notice','Pairing code created. It expires after 10 minutes.');
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
