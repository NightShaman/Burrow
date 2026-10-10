import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const installer = resolve('install.sh');
const script = readFileSync(installer, 'utf8');
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'burrow-native-test-'));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  const home = join(root,'home'), bin = join(root,'bin'), source = join(root,'source'), target = join(home, 'custom-burrow');
  for (const path of [home,bin,source, target,join(root,'tmp'),join(root,'run'),join(home,'.config'),join(source,'backend/scripts'),join(source,'ui/dist')]) mkdirSync(path,{recursive:true});
  const write = (path, text) => writeFileSync(path,text,{mode:0o755});
  write(join(source,'backend/package.json'), '{"version":"test-version"}');
  write(join(source,'ui/package.json'), '{}');
  write(join(source,'ui/dist/index.html'), 'real-ui-fixture');
  write(join(source,'backend/scripts/runtime-integrations.json'), '{"mcporter":{"version":"1"},"claude-code":{"version":"2"}}');
  write(join(source,'SOURCE_VERSIONS'),'Burrow-Build-Version test-version\n');
  copyFileSync(installer,join(source,'install.sh'));
  chmodSync(join(source,'install.sh'),0o755);
  const envfile=join(target,'burrow.env');
  write(envfile,'BURROW_POSTGRES_LIFECYCLE=external\nBURROW_POSTGRES_URL=postgres://fixture\nOPERATOR_SETTING=preserve\n');
  // Never let the test runner's Node version trigger real package provisioning.
  write(join(bin,'node'), `#!/bin/sh\nif [ "$1" = -p ]; then echo 24; else exec '${process.execPath}' "$@"; fi\n`);
  write(join(bin,'npm'), '#!/bin/sh\necho "npm $*" >> "$LOG"\n[ "${1:-}" != prefix ] || echo "$HOME/npm"\n');
  write(join(bin,'id'), '#!/bin/sh\ncase "$1" in -u) echo 1000;; -un) echo fixture;; *) exit 1;; esac\n');
  write(join(bin,'sudo'), '#!/bin/sh\necho "sudo $*" >> "$LOG"\n[ "${FAIL_SUDO:-0}" != 1 ] || exit 1\nexport SUDO_CALLED=1\nexec "$@"\n');
  write(join(bin,'loginctl'), '#!/bin/sh\necho "loginctl $*" >> "$LOG"\ncase "$1" in show-user) [ -f "$HOME/linger" ] && echo yes || echo no;; enable-linger) [ "${SUDO_CALLED:-0}" = 1 ] || exit 1; touch "$HOME/linger";; esac\n');
  write(join(bin,'systemctl'), `#!/bin/sh
echo "systemctl $*" >> "$LOG"
shift
case "$1" in
 show-environment) [ "\${FAIL_MANAGER:-0}" != 1 ];;
 enable|restart) echo new-$$ > "$HOME/invocation"; touch "$HOME/active";;
 is-active) if [ -f "$HOME/active" ]; then echo active; else echo inactive; exit 3; fi;;
 show) cat "$HOME/invocation" 2>/dev/null || true;;
 *) exit 0;;
esac
`);
  write(join(bin,'curl'), '#!/bin/sh\necho "curl $*" >> "$LOG"\nprintf "%s" "${HEALTH:-}"\n');
  // A denied/missing dependency must never escape into real host package tools.
  for (const cmd of ['apt-get','dnf','gpg','install','tee']) write(join(bin,cmd),'#!/bin/sh\necho "UNEXPECTED HOST COMMAND" >&2; exit 99\n');
  const env = {...process.env,HOME:home,PATH:`${bin}:${process.env.PATH}`,XDG_CONFIG_HOME:join(home,'.config'),XDG_RUNTIME_DIR:join(root,'run'),TMPDIR:join(root,'tmp'),BURROW_INSTALL_TEST_ROOT:root,BURROW_INSTALL_READINESS_SECONDS:'1',LOG:join(root,'commands'),HEALTH:JSON.stringify({ok:true,runtime:'burrow',version:'test-version'}),...options};
  const run = (args=[]) => spawnSync('sh',[installer,'--source-dir',source,'--dir',target,...args],{env,encoding:'utf8',timeout:10000});
  return {root,home,source,target,env,run,write,envfile,log:()=>existsSync(env.LOG)?readFileSync(env.LOG,'utf8'):'',unit:join(home,'.config/systemd/user/burrow.service')};
}
test('fresh piped/noninteractive install enables persistent service and validates HTTP readiness',t=>{
 const f=fixture(t),r=f.run(); assert.equal(r.status,0,r.stderr); assert.match(r.stdout,/Ready: http:\/\/127.0.0.1:42817/);
 assert.match(f.log(),/sudo loginctl enable-linger fixture/); assert.match(f.log(),/systemctl --user enable --now burrow.service/); assert.match(f.log(),/curl .*api\/health/);
 assert.match(readFileSync(f.unit,'utf8'),new RegExp(`ExecStart=${f.target}/bin/burrow serve`));
 assert.match(readFileSync(join(f.target,'bin/burrow'),'utf8'),/postgres-supervisor.mjs/);
 assert.equal(readFileSync(join(f.target,'app/backend/public/ui/index.html'),'utf8'),'real-ui-fixture');
 assert.match(readFileSync(f.envfile,'utf8'),/OPERATOR_SETTING=preserve/);
 assert.ok(!existsSync(join(f.target,'.service-install-pending')));
});
for (const health of [{ok:false,runtime:'burrow',version:'test-version'},{ok:true,runtime:'foreign',version:'test-version'},{ok:true,runtime:'burrow',version:'old'},{}]) test(`rejects unhealthy HTTP ${JSON.stringify(health)}`,t=>{
 const f=fixture(t,{HEALTH:JSON.stringify(health)}),r=f.run(); assert.notEqual(r.status,0); assert.doesNotMatch(r.stdout,/Burrow install: ok/); assert.ok(existsSync(join(f.target,'.service-install-pending')));
});
test('service setup failure is resumable on a second installer run',t=>{
 const f=fixture(t,{FAIL_SUDO:'1'}); assert.notEqual(f.run().status,0); f.env.FAIL_SUDO='0'; const r=f.run(); assert.equal(r.status,0,r.stderr); assert.match(r.stdout,/Ready:/);
});
test('missing user manager fails without claiming success',t=>{const f=fixture(t,{FAIL_MANAGER:'1'}),r=f.run();assert.notEqual(r.status,0);assert.match(r.stderr,/cannot reach/);assert.doesNotMatch(r.stdout,/Burrow install: ok/);});
for (const flag of ['--no-service','--no-install-dependencies']) test(`${flag} does not create a fresh service`,t=>{const f=fixture(t),r=f.run([flag]);assert.equal(r.status,0,r.stderr);assert.ok(!existsSync(f.unit));assert.doesNotMatch(f.log(),/loginctl|systemctl/);});
test('existing manual install stays manual',t=>{const f=fixture(t);mkdirSync(join(f.target,'app'));const r=f.run();assert.equal(r.status,0,r.stderr);assert.ok(!existsSync(f.unit));});
test('existing stopped/disabled service is not enabled or started',t=>{const f=fixture(t);mkdirSync(join(f.target,'app'));mkdirSync(resolve(f.unit,'..'),{recursive:true});f.write(f.unit,`ExecStart=${f.target}/bin/burrow serve\n`);const r=f.run();assert.equal(r.status,0,r.stderr);assert.doesNotMatch(f.log(),/enable --now|restart burrow|loginctl/);});
test('active managed update restarts without rewriting service policy',t=>{const f=fixture(t);mkdirSync(join(f.target,'app'));mkdirSync(resolve(f.unit,'..'),{recursive:true});f.write(f.unit,`ExecStart=${f.target}/bin/burrow serve\n# operator override\n`);f.write(join(f.home,'active'),'');f.write(join(f.home,'invocation'),'old');const r=f.run();assert.equal(r.status,0,r.stderr);assert.match(f.log(),/restart burrow.service/);assert.doesNotMatch(f.log(),/enable --now|loginctl/);assert.match(readFileSync(f.unit,'utf8'),/operator override/);});
test('fresh custom root does not overwrite another installation service',t=>{const f=fixture(t);mkdirSync(resolve(f.unit,'..'),{recursive:true});f.write(f.unit,'ExecStart=/other/bin/burrow serve\n');const r=f.run();assert.notEqual(r.status,0);assert.match(r.stderr,/another root/);assert.ok(!existsSync(join(f.target,'app')));});
test('headless flag is rejected before changing state',t=>{const f=fixture(t),r=f.run(['--headless']);assert.equal(r.status,2);assert.ok(!existsSync(join(f.target,'app')));});
test('Node provisioning is automatic without stdin prompts; platform support remains scoped',()=>{
 const ensure=script.slice(script.indexOf('ensure_node_24()'),script.indexOf('# `burrow update`'));
 assert.match(ensure,/node_is_supported && return 0\s+install_node_24/);assert.doesNotMatch(ensure,/read -r|\[ -t/);
 assert.match(script,/install_node_24_rhel/);assert.match(script,/automatic PostgreSQL installation requires Ubuntu/);
});
for (const distro of ['ubuntu','rocky']) test(`missing Node is provisioned noninteractively on ${distro}`,t=>{
 const f=fixture(t);const bin=join(f.root,'bin');
 f.write(join(f.root,'os-release'),`ID=${distro}\nVERSION_ID=9\nVERSION_CODENAME=noble\n`);
 f.write(join(bin,'node'),'#!/bin/sh\n[ -f "$HOME/node-ready" ] && echo 24 || echo 20\n');
 for(const cmd of ['apt-get','dnf']) f.write(join(bin,cmd),'#!/bin/sh\necho "'+cmd+' $*" >> "$LOG"\ncase "$*" in *nodejs*) touch "$HOME/node-ready";; esac\n');
 for(const cmd of ['gpg','install','tee','bash']) f.write(join(bin,cmd),'#!/bin/sh\necho "'+cmd+' $*" >> "$LOG"\ncat >/dev/null\n');
 let funcs=script.slice(script.indexOf('node_is_supported()'),script.indexOf('# `burrow update`'));
 funcs=funcs.replaceAll('/etc/os-release',join(f.root,'os-release'));
 const r=spawnSync('sh',['-c',`set -eu\n${funcs}\nensure_node_24`],{env:f.env,encoding:'utf8',input:'',timeout:5000});
 assert.equal(r.status,0,r.stderr);assert.match(f.log(),new RegExp(`${distro==='ubuntu'?'apt-get':'dnf'} install -y nodejs`));
});
test('Ubuntu managed PostgreSQL provisioning requests server, client and pgvector',t=>{
 const f=fixture(t),bin=join(f.root,'bin');f.write(join(f.root,'os-release'),'ID=ubuntu\nVERSION_CODENAME=noble\n');
 for(const cmd of ['apt-get','gpg','install','tee']) f.write(join(bin,cmd),'#!/bin/sh\necho "'+cmd+' $*" >> "$LOG"\ncat >/dev/null\n');
 let funcs=script.slice(script.indexOf('install_managed_postgres_ubuntu()'),script.indexOf('# Native installs use'));
 funcs=funcs.replaceAll('/etc/os-release',join(f.root,'os-release'));
 const r=spawnSync('sh',['-c',`set -eu\n${funcs}\ninstall_managed_postgres_ubuntu`],{env:f.env,encoding:'utf8',input:'',timeout:5000});
 assert.equal(r.status,0,r.stderr);assert.match(f.log(),/apt-get install -y postgresql-17 postgresql-client-17 postgresql-17-pgvector/);
});
test('managed custom PostgreSQL paths survive install and startup uses the supervisor',t=>{
 const f=fixture(t),pg=join(f.root,'pg'),share=join(f.root,'pg-share');mkdirSync(pg);mkdirSync(join(share,'extension'),{recursive:true});
 f.write(join(share,'extension/vector.control'),'fixture');
 for(const cmd of ['initdb','pg_ctl']) f.write(join(pg,cmd),'#!/bin/sh\necho "unexpected direct initialization" >&2; exit 99\n');
 f.write(join(pg,'postgres'),'#!/bin/sh\necho "postgres (PostgreSQL) 17.1"\n');f.write(join(pg,'pg_config'),`#!/bin/sh\necho '${share}'\n`);
 f.write(f.envfile,`BURROW_POSTGRES_LIFECYCLE=managed\nBURROW_POSTGRES_BIN_DIR=${pg}\nBURROW_UI_HOST=0.0.0.0\nBURROW_UI_PORT=45000\n`);
 const r=f.run();assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/Ready: http:\/\/127.0.0.1:45000/);assert.match(readFileSync(f.envfile,'utf8'),new RegExp(`BURROW_POSTGRES_INITDB=${pg}/initdb`));
});
test('root managed database is rejected before activation',t=>{const f=fixture(t);f.write(join(f.root,'bin/id'),'#!/bin/sh\necho 0\n');f.write(f.envfile,'BURROW_POSTGRES_LIFECYCLE=managed\n');const r=f.run();assert.notEqual(r.status,0);assert.match(r.stderr,/cannot run as root/);assert.ok(!existsSync(join(f.target,'app')));});
test('noninteractive downloaded-assembly handoff preserves explicit service opt-out',t=>{
 const f=fixture(t),archiveRoot=join(f.root,'archive');mkdirSync(archiveRoot);const assembled=join(archiveRoot,'Burrow-fixture');
 const cp=spawnSync('cp',['-R',f.source,assembled]);assert.equal(cp.status,0);
 const archive=join(f.root,'assembly.tar.gz');assert.equal(spawnSync('tar',['-czf',archive,'-C',archiveRoot,'Burrow-fixture']).status,0);
 f.write(join(f.root,'bin/curl'),`#!/bin/sh
case "$*" in
 *api.github.com*) printf '  "sha": "${'a'.repeat(40)}"\\n';;
 *codeload.github.com*) while [ "$1" != -o ]; do shift; done; cp '${archive}' "$2";;
 *) printf '%s' "$HEALTH";;
esac
`);
 const r=spawnSync('sh',[installer,'--dir',f.target,'--no-service'],{env:f.env,encoding:'utf8',input:'',timeout:10000});assert.equal(r.status,0,r.stderr);assert.ok(!existsSync(f.unit));assert.match(r.stdout,/downloading assembly/);
});
test('explicit manual recovery clears pending auto-service intent across updates',t=>{const f=fixture(t,{FAIL_SUDO:'1'});assert.notEqual(f.run().status,0);assert.equal(f.run(['--no-service']).status,0);assert.ok(!existsSync(join(f.target,'.service-install-pending')));f.env.FAIL_SUDO='0';const r=f.run();assert.equal(r.status,0,r.stderr);assert.ok(!existsSync(f.unit));});
test('existing custom root refuses to restart a different root service',t=>{const f=fixture(t);mkdirSync(join(f.target,'app'));mkdirSync(resolve(f.unit,'..'),{recursive:true});f.write(f.unit,'ExecStart=/other/bin/burrow serve\n');f.write(join(f.home,'active'),'');const r=f.run();assert.notEqual(r.status,0);assert.match(r.stderr,/another installation/);assert.doesNotMatch(f.log(),/restart burrow/);});
test('pending retry canonicalizes a trailing slash before matching service ownership',t=>{const f=fixture(t,{HEALTH:'{}'});assert.notEqual(f.run().status,0);f.env.HEALTH=JSON.stringify({ok:true,runtime:'burrow',version:'test-version'});const r=f.run(['--dir',`${f.target}/./`]);assert.equal(r.status,0,r.stderr);});
