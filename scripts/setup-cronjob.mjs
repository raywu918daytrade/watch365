// Creates / updates the cron-job.org jobs that start watch365's GitHub Actions (weekdays, Taipei time), same approach
// as fade (quant_trading_v2/scripts/setup_cronjob.py):
//   13:01  daily-close.yml  13:00 check of D1 monitors + LINE push
//   18:30  site.yml         rebuild the site data after the 17:00 D1 update
//   08:20  site.yml         retry, in case the evening D1 update was late
// Needs CRONJOB_API_KEY (cron-job.org → Settings → API) and GH_DISPATCH_TOKEN (GitHub fine-grained token, only the
// watch365 repository, permission Actions: Read and write). Values are never printed.
//   CRONJOB_API_KEY=... GH_DISPATCH_TOKEN=... node scripts/setup-cronjob.mjs [--test]
const OWNER = 'raywu918daytrade', REPO = 'watch365', API = 'https://api.cron-job.org';
const JOBS = [['watch365 daily-close 13:01', 'daily-close.yml', 13, 1], ['watch365 site data 18:30', 'site.yml', 18, 30], ['watch365 site data retry 08:20', 'site.yml', 8, 20]];
const key = process.env.CRONJOB_API_KEY, gh = process.env.GH_DISPATCH_TOKEN;
if (!key || !gh) { console.error('CRONJOB_API_KEY and GH_DISPATCH_TOKEN are required'); process.exit(1); }
const dispatchUrl = (workflow) => `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${workflow}/dispatches`;
if (process.argv.includes('--test')) {
  const response = await fetch(dispatchUrl('site.yml'), { method:'POST', headers:{ Authorization:`Bearer ${gh}`, Accept:'application/vnd.github+json' }, body:JSON.stringify({ ref:'main' }) });
  console.log(`GitHub dispatch test: ${response.status}${response.status === 204 ? ' (site.yml started)' : ''}`);
  if (response.status !== 204) process.exit(1);
}
const headers = { Authorization:`Bearer ${key}`, 'Content-Type':'application/json' };
const existing = new Map(((await (await fetch(`${API}/jobs`, { headers })).json()).jobs || []).map((job) => [job.title, job.jobId]));
for (const [title, workflow, hour, minute] of JOBS) {
  const job = { title, url:dispatchUrl(workflow), enabled:true, saveResponses:true, requestMethod:1,
    extendedData:{ headers:{ Authorization:`Bearer ${gh}`, Accept:'application/vnd.github+json', 'Content-Type':'application/json' }, body:'{"ref":"main"}' },
    schedule:{ timezone:'Asia/Taipei', expiresAt:0, hours:[hour], minutes:[minute], mdays:[-1], months:[-1], wdays:[1, 2, 3, 4, 5] } };
  const id = existing.get(title);
  const response = id ? await fetch(`${API}/jobs/${id}`, { method:'PATCH', headers, body:JSON.stringify({ job }) }) : await fetch(`${API}/jobs`, { method:'PUT', headers, body:JSON.stringify({ job }) });
  if (!response.ok) { console.error(`${title}: HTTP ${response.status}`); process.exit(1); }
  console.log(`${id ? 'updated' : 'created'}: ${title}`);
}
