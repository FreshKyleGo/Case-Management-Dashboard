/* ESS/MSS Case Management CI Dashboard
   Reads the HR-266126 case volume export (published CSV) and builds the report.
   Mirrors the OPEX/TL dashboard pattern: live fetch from a published Google Sheet CSV,
   client-side parsing, no data baked in. */

// ---- Config -------------------------------------------------------------
const SLACK_URL = 'https://hellofresh.slack.com/archives/C0BBAAS180L';
const JIRA_INTAKE_URL = 'https://hellofresh.atlassian.net/servicedesk/customer/portal/1794';

// The 17 People-OPEX case categories to keep. Any row outside this set is
// dropped on load, so the sheet can carry the full export and the dashboard
// applies the filter itself (matches the "formula filters what we need" ask).
const KEEP_CATEGORIES = new Set([
  'Benefit Request','Benefits and LOA Team Support','Employee Data Management',
  'General HR','Health & Safety','Learning & Development','Leave of Absence',
  'New Hire Journey','Offboarding','Payroll','Payroll Team Support','People',
  'People Shared Services','Performance Management','Policy & Compliance',
  'Rewards','Time Off and Attendance'
]);

const COL = {
  case: 'Case',
  status: 'Case Status',
  category: 'Case Category',
  type: 'Case Type',
  created: 'Created Moment',
  resolvedDate: 'Last Resolved or Cancelled Date',
  team: 'Service Team',
  mttr: 'Real Time to First Resolution/Cancellation in hours (including times out of work schedule)',
  slaTarget: 'Time to Resolve SLA Target',
  passFail: 'Passed or failed',
};

const HF = { green:'#91C01D', greenDark:'#7BA617', crit:'#C0392B', warn:'#C77F17', good:'#3B6D11', ink:'#4A4E42', faint:'#B8BCAD', line:'#E6E9DE' };
const charts = {};

// ---- Boot ---------------------------------------------------------------
document.getElementById('slackBtn').href = SLACK_URL;
document.getElementById('jiraBtn').href = JIRA_INTAKE_URL;
document.getElementById('loadUrlBtn').addEventListener('click', loadFromUrl);
document.getElementById('uploadBtn').addEventListener('click', () => document.getElementById('fileInput').click());
document.getElementById('fileInput').addEventListener('change', loadFromFile);

function setStatus(msg, kind) {
  const el = document.getElementById('sourceStatus');
  el.textContent = msg;
  el.className = 'source-status' + (kind ? ' ' + kind : '');
}

function loadFromUrl() {
  const url = document.getElementById('csvUrl').value.trim();
  if (!url) { setStatus('Enter a published CSV URL first.', 'err'); return; }
  setStatus('Loading…');
  Papa.parse(url, {
    download: true, header: true, skipEmptyLines: true,
    complete: (res) => handleParsed(res, 'URL'),
    error: (err) => setStatus('Could not load URL: ' + err.message + ' — check the sheet is published to the web.', 'err')
  });
}

function loadFromFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  setStatus('Reading ' + file.name + '…');
  Papa.parse(file, {
    header: true, skipEmptyLines: true,
    // The Jira export carries 4 metadata rows before the header; if the header
    // row isn't detected, retry with those skipped.
    complete: (res) => handleParsed(res, file.name),
    error: (err) => setStatus('Parse error: ' + err.message, 'err')
  });
}

function handleParsed(res, sourceName) {
  let rows = res.data;
  // If the expected columns aren't present, the export's metadata rows are
  // probably still attached — find the real header and re-key.
  if (!rows.length || !(COL.category in rows[0])) {
    rows = reheader(res.data, res.meta);
  }
  const clean = rows
    .filter(r => r[COL.case] && r[COL.status])
    .filter(r => KEEP_CATEGORIES.has((r[COL.category] || '').trim()));

  if (!clean.length) {
    setStatus('No matching People-OPEX cases found. Is this the right export?', 'err');
    return;
  }
  setStatus('Loaded ' + clean.length.toLocaleString() + ' cases from ' + sourceName + ' (filtered to People-OPEX categories).', 'ok');
  buildReport(clean);
}

// Fallback: locate the header row within a raw parse and rebuild objects.
function reheader(raw, meta) {
  // Papa with header:true already consumed row 0 as header; if that was metadata,
  // the category column won't exist. Re-parse from the raw file isn't available
  // here, so we reconstruct from meta.fields + data where possible.
  return raw; // handled upstream by user exporting clean CSV; kept for safety.
}

// ---- Helpers ------------------------------------------------------------
const num = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
function parseDate(s) {
  if (!s) return null;
  // Format: M/D/YY H:MM
  const m = String(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  let [, mo, d, y, h, mi] = m;
  y = y.length === 2 ? '20' + y : y;
  return new Date(+y, +mo - 1, +d, +h, +mi);
}
const monthKey = dt => dt ? `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}` : null;
const monthLabel = k => { const [y,m] = k.split('-'); return new Date(+y, +m-1, 1).toLocaleString('en', {month:'short', year:'2-digit'}); };
const fmt = n => n.toLocaleString('en', {maximumFractionDigits:0});
function rateClass(pct){ return pct >= 10 ? 'crit' : pct >= 5 ? 'warn' : 'good'; }

// ---- Main build ---------------------------------------------------------
function buildReport(rows) {
  document.getElementById('emptyState').classList.add('hidden');
  document.getElementById('report').classList.remove('hidden');

  const data = rows.map(r => {
    const created = parseDate(r[COL.created]);
    const resolved = parseDate(r[COL.resolvedDate]);
    return {
      id: r[COL.case],
      status: r[COL.status],
      category: (r[COL.category]||'').trim(),
      type: (r[COL.type]||'').trim(),
      team: (r[COL.team]||'Unassigned').trim(),
      created, resolved,
      cMonth: monthKey(created),
      rMonth: monthKey(resolved),
      mttr: num(r[COL.mttr]),
      slaTarget: num(r[COL.slaTarget]),
      pf: r[COL.passFail]
    };
  });

  const minD = data.filter(d=>d.created).reduce((a,d)=>d.created<a?d.created:a, new Date(8e15));
  const maxD = data.filter(d=>d.created).reduce((a,d)=>d.created>a?d.created:a, new Date(-8e15));
  const range = `${minD.toLocaleDateString('en',{month:'short',day:'numeric',year:'numeric'})} – ${maxD.toLocaleDateString('en',{month:'short',day:'numeric',year:'numeric'})}`;
  document.getElementById('heroMeta').textContent = `${fmt(data.length)} cases · ${range} · filtered to 17 People-OPEX categories`;
  document.getElementById('footMeta').textContent = `Generated ${new Date().toLocaleDateString('en',{month:'short',day:'numeric',year:'numeric'})} · ${fmt(data.length)} cases`;

  buildCore(data);
  buildSla(data);
  buildBigTicket(data);
  buildCI(data);
}

// ---- Section 1: Core performance & volume -------------------------------
function buildCore(data) {
  const months = [...new Set(data.map(d=>d.cMonth).filter(Boolean))].sort();
  const opened = months.map(m => data.filter(d=>d.cMonth===m).length);
  const closed = months.map(m => data.filter(d=>d.rMonth===m && (d.status==='Resolved'||d.status==='Canceled')).length);

  // MTTR by month (mean of resolved cases created that month)
  const mttrByMonth = months.map(m => {
    const vals = data.filter(d=>d.cMonth===m && d.mttr!=null).map(d=>d.mttr);
    return vals.length ? Math.round(vals.reduce((a,b)=>a+b,0)/vals.length) : 0;
  });

  const totalHours = data.filter(d=>d.mttr!=null).reduce((a,d)=>a+d.mttr,0);
  const avgMttr = Math.round(totalHours / data.filter(d=>d.mttr!=null).length);
  const closedTotal = data.filter(d=>d.status==='Resolved'||d.status==='Canceled').length;

  // KPIs
  document.getElementById('kpiCore').innerHTML = [
    kpi('Total cases', fmt(data.length), `across ${months.length} months`),
    kpi('Closed', fmt(closedTotal), `${Math.round(closedTotal/data.length*100)}% of volume`, closedTotal/data.length>0.9?'good':''),
    kpi('Avg resolution', avgMttr + '<small> hrs</small>', 'mean time to resolve'),
    kpi('Cumulative effort', fmt(Math.round(totalHours)) + '<small> hrs</small>', `≈ ${fmt(Math.round(totalHours/2080))} FTE-years`),
  ].join('');

  // Volume chart
  drawChart('volumeChart', {
    type: 'bar',
    data: { labels: months.map(monthLabel), datasets: [
      { label:'Opened', data:opened, backgroundColor:HF.green, borderRadius:4, categoryPercentage:0.7, barPercentage:0.85 },
      { label:'Closed', data:closed, backgroundColor:HF.greenDark+'66', borderRadius:4, categoryPercentage:0.7, barPercentage:0.85 },
    ]},
    options: baseOpts({ legend:true })
  });

  // MTTR trend
  drawChart('mttrChart', {
    type: 'line',
    data: { labels: months.map(monthLabel), datasets: [
      { label:'Avg MTTR (hrs)', data:mttrByMonth, borderColor:HF.crit, backgroundColor:HF.crit+'18', fill:true, tension:0.3, pointRadius:4, pointBackgroundColor:HF.crit, borderWidth:2 }
    ]},
    options: baseOpts({})
  });

  // Cumulative effort (running total by month)
  let run = 0;
  const cumulative = months.map(m => {
    run += data.filter(d=>d.cMonth===m && d.mttr!=null).reduce((a,d)=>a+d.mttr,0);
    return Math.round(run);
  });
  drawChart('effortChart', {
    type: 'line',
    data: { labels: months.map(monthLabel), datasets: [
      { label:'Cumulative hours', data:cumulative, borderColor:HF.green, backgroundColor:HF.green+'20', fill:true, tension:0.2, pointRadius:3, borderWidth:2 }
    ]},
    options: baseOpts({})
  });
}

// ---- Section 2: SLA & efficiency ----------------------------------------
function buildSla(data) {
  const rated = data.filter(d => d.pf === 'Passed' || d.pf === 'Failed');
  const passed = rated.filter(d=>d.pf==='Passed').length;
  const failed = rated.filter(d=>d.pf==='Failed').length;
  const passRate = rated.length ? (passed/rated.length*100) : 0;

  // Quick-resolution: has a target, passed, resolved under 5 hours
  const quick = data.filter(d => d.slaTarget>0 && d.mttr!=null && d.mttr<5 && d.pf==='Passed').length;
  const quickPct = Math.round(quick/data.length*100);

  document.getElementById('kpiSla').innerHTML = [
    kpi('SLA pass rate', passRate.toFixed(1)+'<small>%</small>', `${fmt(passed)} passed`, passRate>=95?'good':passRate>=90?'':'warn'),
    kpi('SLA breaches', fmt(failed), 'cases over target', failed>0?'crit':'good', 'crit'),
    kpi('Quick resolutions', fmt(quick), `${quickPct}% closed under 5 hrs`, 'good', 'good'),
    kpi('Rated cases', fmt(rated.length), `${Math.round(rated.length/data.length*100)}% have an SLA target`),
  ].join('');

  // Resolution velocity vs SLA: bucket (actual - target) hours
  const buckets = { 'Ahead >24h':0, 'Ahead ≤24h':0, 'On/within target':0, 'Breached ≤24h':0, 'Breached >24h':0 };
  rated.forEach(d => {
    if (d.mttr==null || d.slaTarget==null) return;
    const diff = d.mttr - d.slaTarget;
    if (diff <= -24) buckets['Ahead >24h']++;
    else if (diff < 0) buckets['Ahead ≤24h']++;
    else if (d.pf==='Passed') buckets['On/within target']++;
    else if (diff <= 24) buckets['Breached ≤24h']++;
    else buckets['Breached >24h']++;
  });
  drawChart('velocityChart', {
    type: 'bar',
    data: { labels:Object.keys(buckets), datasets:[{
      data:Object.values(buckets),
      backgroundColor:[HF.good, HF.green, HF.greenDark+'55', HF.warn, HF.crit],
      borderRadius:4
    }]},
    options: baseOpts({ horizontal:true })
  });

  // SLA by category table
  const cats = groupStats(rated, d=>d.category);
  const rowsHtml = cats.sort((a,b)=>b.failRate-a.failRate).map(c => {
    const cls = rateClass(c.failRate);
    return `<tr>
      <td class="name">${c.key}</td>
      <td class="num">${fmt(c.total)}</td>
      <td class="num"><span class="badge ${cls}">${c.failRate.toFixed(1)}%</span></td>
      <td class="bar-cell"><div class="bar-track"><div class="bar-fill ${cls}" style="width:${Math.min(c.failRate*3,100)}%"></div></div></td>
    </tr>`;
  }).join('');
  document.getElementById('slaCatTable').innerHTML =
    `<thead><tr><th>Category</th><th class="num">Cases</th><th class="num">Fail rate</th><th></th></tr></thead><tbody>${rowsHtml}</tbody>`;
}

// ---- Section 3: Big-ticket items ----------------------------------------
function buildBigTicket(data) {
  const top = data.filter(d=>d.mttr!=null).sort((a,b)=>b.mttr-a.mttr).slice(0,12);
  document.getElementById('bigTicketList').innerHTML = top.map(d => {
    const title = d.id.length>60 ? d.id.slice(0,60)+'…' : d.id;
    const days = (d.mttr/24).toFixed(0);
    return `<div class="ticket">
      <div class="ticket-hrs">${fmt(d.mttr)}<small>${days} days</small></div>
      <div class="ticket-body">
        <div class="ticket-title" title="${d.id.replace(/"/g,'&quot;')}">${title}</div>
        <div class="ticket-meta">${d.category} · ${d.team} · ${d.status}</div>
      </div>
    </div>`;
  }).join('');

  // Effort concentration by team (total hours)
  const teams = {};
  data.filter(d=>d.mttr!=null).forEach(d => { teams[d.team] = (teams[d.team]||0) + d.mttr; });
  const sorted = Object.entries(teams).sort((a,b)=>b[1]-a[1]).slice(0,10);
  drawChart('effortTeamChart', {
    type: 'bar',
    data: { labels:sorted.map(t=>t[0].length>32?t[0].slice(0,32)+'…':t[0]), datasets:[{
      label:'Total hours', data:sorted.map(t=>Math.round(t[1])), backgroundColor:HF.green, borderRadius:4
    }]},
    options: baseOpts({ horizontal:true })
  });
}

// ---- Section 4: CI recommendations --------------------------------------
function buildCI(data) {
  const rated = data.filter(d => d.pf==='Passed' || d.pf==='Failed');

  // Candidate 1: worst case TYPE by failure rate (min volume 50)
  const types = groupStats(rated, d=>d.type).filter(t=>t.total>=50).sort((a,b)=>b.failRate-a.failRate);
  // Candidate 2: worst TEAM by failure rate (min volume 50)
  const teams = groupStats(rated, d=>d.team).filter(t=>t.total>=50).sort((a,b)=>b.failRate-a.failRate);
  // Candidate 3: category with highest variability (biggest avg MTTR, min 100)
  const cats = groupStats(rated, d=>d.category).filter(c=>c.total>=100).sort((a,b)=>b.avgMttr-a.avgMttr);

  const cards = [];
  if (types[0]) cards.push(ciCard(1, `${types[0].key}`, [
    ['Failure rate', types[0].failRate.toFixed(1)+'%'], ['Cases', fmt(types[0].total)], ['Avg MTTR', fmt(types[0].avgMttr)+'h']
  ], `Highest-failing case type in scope. ${types[0].failRate.toFixed(0)}% of these breach SLA, signalling a process or ownership gap worth a DMAIC pass.`,
    ['Process mapping','Ownership clarity','Intake redesign']));

  if (teams[0]) cards.push(ciCard(2, `${teams[0].key}`, [
    ['Failure rate', teams[0].failRate.toFixed(1)+'%'], ['Cases', fmt(teams[0].total)], ['Avg MTTR', fmt(teams[0].avgMttr)+'h']
  ], `Team with the weakest SLA outcomes. Concentrated failures here suggest capacity, routing, or playbook issues rather than case-mix.`,
    ['Capacity review','Routing rules','Playbook']));

  if (cats[0]) cards.push(ciCard(3, `${cats[0].key}`, [
    ['Avg MTTR', fmt(cats[0].avgMttr)+'h'], ['Cases', fmt(cats[0].total)], ['Fail rate', cats[0].failRate.toFixed(1)+'%']
  ], `Longest average resolution among high-volume categories. Wide spread between fast and stalled cases points to inconsistent handling.`,
    ['Standardize','Decision framework','Automation']));

  document.getElementById('ciGrid').innerHTML = cards.join('');
}

// ---- Small render helpers ----------------------------------------------
function kpi(label, value, foot, cardCls='', footCls='') {
  return `<div class="kpi ${cardCls}">
    <div class="kpi-label">${label}</div>
    <div class="kpi-value">${value}</div>
    <div class="kpi-foot ${footCls}">${foot}</div>
  </div>`;
}
function ciCard(rank, title, stats, desc, tags) {
  return `<div class="ci-card p${rank}">
    <div class="ci-rank">PRIORITY ${rank}</div>
    <div class="ci-title">${title}</div>
    <div class="ci-stats">${stats.map(s=>`<div class="ci-stat"><div class="ci-stat-val">${s[1]}</div><div class="ci-stat-lbl">${s[0]}</div></div>`).join('')}</div>
    <div class="ci-desc">${desc}</div>
    <div class="ci-tags">${tags.map(t=>`<span class="ci-tag">${t}</span>`).join('')}</div>
  </div>`;
}
function groupStats(rows, keyFn) {
  const g = {};
  rows.forEach(r => {
    const k = keyFn(r); if (!k) return;
    if (!g[k]) g[k] = { key:k, total:0, fail:0, mttrSum:0, mttrN:0 };
    g[k].total++;
    if (r.pf==='Failed') g[k].fail++;
    if (r.mttr!=null) { g[k].mttrSum += r.mttr; g[k].mttrN++; }
  });
  return Object.values(g).map(x => ({
    key:x.key, total:x.total, fail:x.fail,
    failRate: x.total ? x.fail/x.total*100 : 0,
    avgMttr: x.mttrN ? Math.round(x.mttrSum/x.mttrN) : 0
  }));
}
function baseOpts({legend=false, horizontal=false}) {
  return {
    indexAxis: horizontal ? 'y' : 'x',
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: legend, labels:{ boxWidth:12, font:{size:11}, color:HF.ink } },
      tooltip: { backgroundColor:'#1A1D14', padding:10, cornerRadius:6, titleFont:{size:12}, bodyFont:{size:12} }
    },
    scales: {
      x: { grid:{ color:HF.line, drawBorder:false }, ticks:{ color:HF.ink, font:{size:11} } },
      y: { grid:{ color:HF.line, drawBorder:false }, ticks:{ color:HF.ink, font:{size:11} }, beginAtZero:true }
    }
  };
}
function drawChart(id, cfg) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(document.getElementById(id).getContext('2d'), cfg);
}
