import { logAuthFailure, observeAuthEnvironmentOverride, oidcMissingConfiguration, startAuthLoginTelemetry, withAuthDiagnostics } from '../../src/ui-auth-diagnostics.mjs';

export function createAuthRoutes({ runtimeConfig, oidcLoginUrl, setOidcStateCookie, completeOidcCallback, sendOidcSessionCookie, clearOidcCookies, oidcCookieClearHeader, oidcSessionFromRequest, sendJson, serverLogger, logger } = {}) {
  const authLogger = serverLogger || logger;
  return async function handleAuthRoute({ req, res, url, origin } = {}) {
    const stage = req.method === 'GET' ? {
      '/api/auth/discovery': 'configuration', '/auth/oidc/login': 'login',
      '/auth/oidc/callback': 'callback', '/api/auth/session': 'session',
    }[url.pathname] : req.method === 'POST' && url.pathname === '/auth/logout' ? 'logout' : null;
    if (!stage) return false;
    const completeLogin = stage === 'login' || stage === 'callback' ? startAuthLoginTelemetry('oidc') : null;
    let failureStage = 'configuration';
    let missingConfig = [];
    try {
      const runtime = await runtimeConfig();
      observeAuthEnvironmentOverride(runtime);
      failureStage = stage;
      if (stage === 'configuration') {
        const mode = runtime?.ui?.authMode || 'none';
        sendJson(res, 200, { ok: true, auth: { mode, enabled: mode !== 'none' } });
        return true;
      }
      if (stage === 'login' || stage === 'callback') {
        missingConfig = oidcMissingConfiguration(runtime, stage);
      }
      if (stage === 'login') {
        const login = await oidcLoginUrl(runtime, origin);
        if (missingConfig.length) await logAuthFailure(authLogger, { req, route: url.pathname, diagnostics: { stage: 'configuration', reason: 'auth_configuration_missing', missingConfig } });
        setOidcStateCookie(res, login.state, login.nonce, url.searchParams.get('returnTo') || '/', runtime);
        res.writeHead(302, { location: login.url });
        res.end();
        return true;
      }
      if (stage === 'callback') {
        const session = await completeOidcCallback(req, url, runtime, origin);
        if (missingConfig.length) await logAuthFailure(authLogger, { req, route: url.pathname, diagnostics: { stage: 'configuration', reason: 'auth_configuration_missing', missingConfig } });
        failureStage = 'session';
        sendOidcSessionCookie(res, session, runtime);
        const cookies = res.getHeader('set-cookie');
        res.setHeader('set-cookie', [...(Array.isArray(cookies) ? cookies : [cookies].filter(Boolean)), oidcCookieClearHeader(runtime)]);
        res.writeHead(302, { location: session.returnTo || '/' });
        res.end();
        completeLogin('success');
        return true;
      }
      if (stage === 'logout') {
        clearOidcCookies(res, runtime);
        const cookies = res.getHeader('set-cookie');
        res.setHeader('set-cookie', [...(Array.isArray(cookies) ? cookies : [cookies].filter(Boolean)), `hc_basic_session=; HttpOnly;${runtime?.ui?.basic?.insecureCookies === true ? '' : ' Secure;'} SameSite=Lax; Path=/; Max-Age=0`]);
        sendJson(res, 200, { ok: true });
        return true;
      }
      if (stage === 'session') {
        let diagnostics;
        const session = oidcSessionFromRequest(req, runtime, { onFailure: value => { diagnostics = value; } });
        if (diagnostics) await logAuthFailure(authLogger, { req, route: url.pathname, diagnostics });
        sendJson(res, 200, { ok: true, authenticated: Boolean(session), session: session || null, auth: { mode: runtime.ui.authMode, enabled: runtime.ui.authEnabled, source: runtime.ui.authSource } });
        return true;
      }
      return false;
    } catch (error) {
      // Attach configuration names even when the downstream failure is more
      // specific. Do not add validation or log the same failure twice.
      const diagnosticsError = withAuthDiagnostics(error, { stage: failureStage, missingConfig });
      completeLogin?.('failure', { error: diagnosticsError, oidcCallback: stage === 'callback' });
      await logAuthFailure(authLogger, { req, route: url.pathname, stage: failureStage, error: diagnosticsError });
      // Preserve the existing caller-owned HTTP error response contract.
      throw error;
    }
  };
}
