export function createAuthRoutes({ runtimeConfig, oidcLoginUrl, setOidcStateCookie, completeOidcCallback, sendOidcSessionCookie, clearOidcCookies, oidcCookieClearHeader, oidcSessionFromRequest, sendJson } = {}) {
  return async function handleAuthRoute({ req, res, url, origin } = {}) {
    if (req.method === 'GET' && url.pathname === '/auth/oidc/login') {
      const runtime = await runtimeConfig();
      const login = await oidcLoginUrl(runtime, origin);
      setOidcStateCookie(res, login.state, login.nonce, url.searchParams.get('returnTo') || '/', runtime);
      res.writeHead(302, { location: login.url });
      res.end();
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/auth/oidc/callback') {
      const runtime = await runtimeConfig();
      const session = await completeOidcCallback(req, url, runtime, origin);
      sendOidcSessionCookie(res, session, runtime);
      const cookies = res.getHeader('set-cookie');
      res.setHeader('set-cookie', [...(Array.isArray(cookies) ? cookies : [cookies].filter(Boolean)), oidcCookieClearHeader(runtime)]);
      res.writeHead(302, { location: session.returnTo || '/' });
      res.end();
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/auth/logout') { const runtime = await runtimeConfig(); clearOidcCookies(res, runtime); sendJson(res, 200, { ok: true }); return true; }
    if (req.method === 'GET' && url.pathname === '/api/auth/session') {
      const runtime = await runtimeConfig();
      const session = oidcSessionFromRequest(req, runtime);
      sendJson(res, 200, { ok: true, authenticated: Boolean(session), session: session || null, auth: { mode: runtime.ui.authMode, enabled: runtime.ui.authEnabled, source: runtime.ui.authSource } });
      return true;
    }
    return false;
  };
}
