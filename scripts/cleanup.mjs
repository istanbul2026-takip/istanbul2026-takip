// Delete older Cloudflare Pages deployments to keep the project tidy.
const token = process.env.CLOUDFLARE_API_TOKEN, account = process.env.CLOUDFLARE_ACCOUNT_ID;
const project = 'istanbul2026-takip', KEEP = 3;
if (!token || !account) process.exit(0);
const api = (path, opts = {}) => fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/${project}${path}`,
  { ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000) }).then(r => r.json());
const res = await api('/deployments?per_page=25&sort_by=created_on&sort_order=desc');
if (!res.success) { console.log('could not list deployments', JSON.stringify(res.errors)); process.exit(0); }
const old = res.result.slice(KEEP);
let n = 0;
for (const d of old) {
  const r = await api(`/deployments/${d.id}?force=true`, { method: 'DELETE' });
  if (r.success) n++;
}
console.log(`kept ${Math.min(KEEP, res.result.length)}, removed ${n} older deployment(s)`);
