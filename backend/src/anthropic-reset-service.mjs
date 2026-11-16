// Manual-only native Cedar Ember activation. Claims commit before dispatch;
// transport uncertainty is never evidence of non-consumption.
const outcomes = new Set(['reset', 'already_used', 'not_limited', 'cooldown', 'ineligible', 'unavailable']);
const requestIdentifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const identifier = value => typeof value === 'string' && value.trim() && value.length <= 256;
const grantIdentifier = value => typeof value === 'string' && /^[a-z0-9_-]{1,40}$/.test(value);
const headers = source => ({ accept:'application/json', authorization:`Bearer ${source.token}`, 'anthropic-beta':'oauth-2025-04-20', 'user-agent':'claude-cli/2.1.325 (external, cli)' });
const failure = (status = 503, ambiguous = false) => ({ok:false,status,code:'unavailable',...(ambiguous ? {ambiguous:true} : {})});
export function createAnthropicResetService({resolveSource, fetchImpl, resetStore, summarize, invalidateInventory = async () => {}, clock = Date.now, timeoutMs = 25_000}) {
  async function snapshot(connectionId) {
    const source = await resolveSource(connectionId);
    if (!source || source.origin !== 'https://api.anthropic.com') return null;
    // Profile comes from the *same* resolved credential and origin; never a
    // caller-selected organization or unrelated native CLI configuration.
    const options = {headers:headers(source),signal:AbortSignal.timeout(timeoutMs),redirect:'error'};
    const profileResponse = await fetchImpl(`${source.origin}/api/oauth/profile`, options);
    if (!profileResponse.ok) return null;
    const profile = await profileResponse.json();
    const organization = profile?.organization?.uuid;
    if (typeof organization !== 'string' || !/^[a-f0-9-]{36}$/i.test(organization)) return null;
    const response = await fetchImpl(`${source.origin}/api/oauth/usage?cedar_ember=1`, {...options,signal:AbortSignal.timeout(timeoutMs)});
    if (!response.ok) return null;
    const raw = (await response.json())?.cedar_ember;
    if (raw?.eligible === false && raw.ineligible_reason !== 'unavailable') return {source,organization,raw,summary:{availableCount:0,nearestExpiresAt:null}};
    const summary = summarize(raw);
    if (!summary) return null;
    return {source,organization,raw,summary};
  }
  async function anthropicResetInventory({connectionId} = {}) {
    if (!identifier(connectionId)) return {ok:false,status:400,error:'connection_id_required'};
    try {
      const fresh = await snapshot(connectionId);
      if (!fresh) return failure();
      return {ok:true,status:200,connectionId,fullResets:fresh.summary,fetchedAt:new Date(clock()).toISOString()};
    } catch { return failure(); }
  }
  async function activateAnthropicFullReset({connectionId,requestId,confirmed} = {}) {
    if (!identifier(connectionId) || !requestIdentifier(requestId) || confirmed !== true) return {ok:false,status:400,error:'anthropic_full_reset_request_invalid'};
    if (!resetStore) return failure();
    let fresh;
    try { fresh = await snapshot(connectionId); } catch { return failure(); }
    if (!fresh) return failure();
    const {source,organization,raw} = fresh;
    const result = (code, extra = {}) => ({ok:true,status:200,code,connectionId,requestId,...extra});
    if (!raw.eligible) return result('ineligible');
    if (Date.parse(raw.cooldown_until) > clock()) return result('cooldown');
    const grants = raw.grants.filter(grant => grantIdentifier(grant?.id) && grant.clears?.includes('five_hour') && grant.clears.includes('seven_day') && !grant.paused && grant.resets_left > 0 && Date.parse(grant.starts_at) <= clock() && Date.parse(grant.ends_at) > clock());
    const grant = grants.find(item => item.id === raw.next_grant_id) || grants.find(item => item.usable_now === true);
    if (!grant) return result('unavailable');
    // Respect native usable_now. Banked inventory is not permission to dispatch.
    if (grant.usable_now !== true) return result(grant.unavailable_reason === 'needs_limit' ? 'not_limited' : 'unavailable');
    const account = `anthropic:organization:${organization}`;
    // A grant can contain several resets. Pin each observed balance separately.
    const identity = {account,creditId:`${grant.id}:${grant.resets_left}`,requestId,expiresAt:new Date(grant.ends_at).toISOString()};
    try {
      if ((await resetStore.pending(account)).length) return failure(409,true);
      if (!await resetStore.claim(identity)) return failure(409);
    } catch { return failure(); }
    let outcome = 'unknown', answer = failure(502,true), httpStatus = null, code = null;
    try {
      const response = await fetchImpl(`${source.origin}/api/organizations/${organization}/reset_rate_limits`, {method:'POST',headers:{...headers(source),'content-type':'application/json'},body:JSON.stringify({program:'cedar_ember',grant_id:grant.id,request_id:requestId}),signal:AbortSignal.timeout(timeoutMs),redirect:'error'});
      httpStatus = response.status;
      if (response.ok) {
        const data = await response.json();
        const nonConsuming = ['not_limited','cooldown','ineligible','unavailable'].includes(data?.result);
        const malformedBalance = data?.resets_left != null && (!Number.isSafeInteger(data.resets_left) || data.resets_left < 0);
        const contradictory = nonConsuming && ((Array.isArray(data.cleared) && data.cleared.length > 0) || (Number.isSafeInteger(data.resets_left) && data.resets_left < grant.resets_left));
        if (outcomes.has(data?.result) && !malformedBalance && !contradictory && (data.cleared == null || Array.isArray(data.cleared)) && !['stamp_indeterminate','reset_unconfirmed'].includes(data.reason)) {
          code = data.result;
          outcome = ['reset','already_used'].includes(code) ? 'consumed' : 'retryable';
          answer = result(code);
        }
      } else if ([400,401,403,404,422,429].includes(response.status)) {
        // An explicit precondition/auth rejection is definite non-consumption.
        outcome = 'retryable'; code = response.status === 429 ? 'cooldown' : 'unavailable'; answer = result(code);
      }
    } catch { /* Durable pre-dispatch unknown fence remains. No retry. */ }
    // Even a lost response may have changed inventory; retained counts become display-only stale evidence.
    try { await invalidateInventory(source); } catch { /* freshness is best effort, ledger safety is not */ }
    try { await resetStore.settle({...identity,outcome,code,httpStatus}); }
    catch { return {...answer,ambiguous:true,outcomeRecorded:false}; }
    return answer;
  }
  return {anthropicResetInventory,activateAnthropicFullReset};
}
