// Maintainers: prove, read-only, that the live StartRight service still matches the recorded contract. Every check is a
// GET (the write endpoint is never touched; the guard ledger and the network witness must both show zero writes).
import { randomBytes, randomUUID } from 'node:crypto';
import { CONTRACT_VERSION, ENDPOINTS, READ_ENDPOINTS, isGuid } from './contract.mjs';
import { begin } from './flows.mjs';
import { aliasOf } from './resolve.mjs';

const check = (id, pass, evidence, detail) => ({ id, pass, evidence, ...(detail ? { detail } : {}) });

async function probe(s, id, params, expectStatuses) {
  try {
    const r = await s.api(id, params);
    if (expectStatuses && !expectStatuses.includes(r.status)) return { r, error: `status ${r.status}, expected ${expectStatuses.join(' or ')}` };
    return { r };
  } catch (e) { return { error: e.message, code: e.code, errors: e.errors }; }
}

export async function runVerify(s, { baseUrl }) {
  s.guard.setPhase('verify');
  const checks = [];
  const live = new URL(baseUrl).origin === new URL('https://startright.app.prod.gitops.startclean.microsoft.com').origin;
  let me;
  try { me = await begin(s); } catch (e) { return { ok: false, live, contract: CONTRACT_VERSION, checks: [check('session', false, e.code ?? 'error', e.message)] }; }
  checks.push(check('session', true, `signed in as ${me.login}`));

  const run = async (id, params, expect, extra) => {
    const { r, error, errors } = await probe(s, id, params, expect);
    if (error) { checks.push(check(id, false, `${id} ${error}`, errors?.join('; '))); return null; }
    checks.push(check(id, true, `${id} ${r.status} matches the contract${extra ? ` (${extra(r.body)})` : ''}`));
    return r.body;
  };

  const orgs = await run('organizations', {}, [200], (b) => `${b.length} organization(s)`);
  if (orgs?.length) {
    await run('membership', { path: { organization: orgs[0].login } }, [200]);
    const org = orgs[0].login;
    const probeName = `contract-probe-${randomBytes(5).toString('hex')}`;
    const av = await run('availability', { query: { organization: org, name: probeName } }, [200], (b) => `available=${b.available}`);
    if (av && av.available !== true) checks.push(check('availability.free_name', false, `a random name "${probeName}" was reported taken`));
    const bad = await run('availability', { query: { organization: org, name: 'bad name!' } }, [400]);
    checks.push(check('availability.invalid_name', bad !== null, bad ? 'an invalid name is a 400 problem' : 'invalid name did not yield a documented 400'));
    for (const purpose of ['acl', 'ownership']) {
      const list = await run('principals', { query: { organization: org, purpose, query: aliasOf(me.login), types: 'user' } }, [200], (b) => `${b.length} principal(s)`);
      if (list) checks.push(check(`principals.${purpose}.requester`, list.some((p) => p.isRequester), list.some((p) => p.isRequester) ? 'the requester is returned with isRequester' : 'the requester was not returned'));
    }
    await run('restriction', { query: { organization: org, serviceTreeId: randomUUID() } }, [200], (b) => `blocked=${b.blocked}`);
  }
  await run('joinable', { query: { query: 'a', top: 3 } }, [200]);
  const cat = await run('catalog', {}, [200], (b) => `${b.length} entries`);
  if (cat) checks.push(check('catalog.size', cat.length > (live ? 1000 : 0) && cat.every((c) => isGuid(c.id)), `${cat.length} entries with GUID ids`));
  await run('recent', {}, [200], (b) => `${b.length} repositories`);

  const untouched = READ_ENDPOINTS.length + 1 === Object.keys(ENDPOINTS).length;
  checks.push(check('contract.covers_endpoints', untouched, `${READ_ENDPOINTS.length} read endpoints and 1 write endpoint are recorded`));
  const st = s.guard.stats();
  const serviceWrites = st.writes.filter((w) => w.service);
  const witness = s.witness();
  checks.push(check('no_writes_sent', st.createsSent === 0 && !st.everArmed && serviceWrites.length === 0 && witness.length === 0,
    `guard saw ${serviceWrites.length} write(s) to StartRight, the network witness ${witness.length}; the create gate was ${st.everArmed ? 'ARMED' : 'never armed'}`));
  return { ok: checks.every((c) => c.pass === true), live, contract: CONTRACT_VERSION, checks };
}
