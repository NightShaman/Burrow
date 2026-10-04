// Returned asset URLs are untrusted, unlike the operator-configured API endpoint.
import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.168.0.0',16],['100.64.0.0',10],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(address,prefix,'ipv4');
for (const [address, prefix] of [['::',128],['::1',128],['fc00::',7],['fe80::',10],['ff00::',8]]) blocked.addSubnet(address,prefix,'ipv6');
export function unsafeImageAddress(address) {
  // BlockList also recognizes IPv4-mapped IPv6 addresses in IPv4 subnets.
  return !isIP(address) || blocked.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}
function pinnedFetch(url, init, addresses) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      signal: init.signal,
      lookup: (_host, options, callback) => {
        const selected = addresses.find((a) => !options.family || a.family === options.family) || addresses[0];
        callback(null, options.all ? [selected] : selected.address, selected.family);
      },
    }, (response) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      resolve(new Response([204,304].includes(response.statusCode) ? null : Readable.toWeb(response), { status: response.statusCode, headers }));
    });
    request.on('error', reject);
  });
}
export async function fetchProviderImage(url, { fetchImpl = globalThis.fetch, signal, trusted = false, lookupImpl = lookup } = {}) {
  for (let hop = 0; hop <= 5; hop++) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('image response URL protocol or credentials are unsupported');
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookupImpl(hostname, { all: true, verbatim: true });
    if (!addresses.length || (!trusted && addresses.some(({ address }) => unsafeImageAddress(address)))) throw new Error('image response URL network destination is blocked');
    const init = { method: 'GET', redirect: 'manual', ...(signal ? { signal } : {}) };
    const response = fetchImpl === globalThis.fetch ? await pinnedFetch(parsed, init, addresses) : await fetchImpl(parsed.href, init);
    if (![301,302,303,307,308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || hop === 5) throw new Error('image response URL redirect limit or location is invalid');
    url = new URL(location, parsed).href;
  }
}
