// One route per real component, resolved from the source tree at build time.
const route = new URLSearchParams(location.search).get('route') ?? 'settings';
if (route === 'settings') void import('./settings');
else if (route === 'tasks') void import('./tasks');
else if (route === 'archive') void import('./archive');
else if (route === 'app') void import('./app');
else if (route === 'first-run') void import('./first-run');
else if (route === 'auth') void import('./auth');
else throw new Error('Unknown fixture route ' + route);
