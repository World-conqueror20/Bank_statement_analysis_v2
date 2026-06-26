/**
 * export.js
 * Case package export: PDF print layout, CSV, JSON bundle.
 * Version: 1.0.0
 */
'use strict';

const Export = (() => {

  function fmt(n) {
    if (!n && n !== 0) return '—';
    return '₹' + Math.round(n).toLocaleString('en-IN');
  }

  // ── CSV export ────────────────────────────────────────────────────────────
  function toCSV(transactions, flags) {
    const flagMap = {};
    (flags||[]).forEach(f => f.txnIds.forEach(id => {
      if (!flagMap[id]) flagMap[id] = [];
      flagMap[id].push(f.ruleId);
    }));

    const rows = [['ID','Date','Bank','Account','Direction','Amount (INR)','Entity','Category','Narration','Flags','Provenance']];
    transactions.forEach(t => {
      const d = t.dateTime instanceof Date ? t.dateTime.toISOString().slice(0,10)
              : String(t.dateTime||'').slice(0,10);
      rows.push([
        t.id, d, t.bank, t.accountId, t.direction,
        Math.round(t.amount),
        t.entityId||'',
        t.categoryId||'',
        '"' + (t.narration||'').replace(/"/g,'""') + '"',
        (flagMap[t.id]||[]).join('|'),
        t.provenance||''
      ]);
    });
    return rows.map(r => r.join(',')).join('\n');
  }

  function downloadCSV(transactions, flags, filename) {
    const csv = toCSV(transactions, flags);
    const blob = new Blob(['\uFEFF'+csv], {type:'text/csv;charset=utf-8'});
    downloadBlob(blob, filename || `transactions_${dateStr()}.csv`);
  }

  // ── Entity summary CSV ────────────────────────────────────────────────────
  function downloadEntityCSV(scores) {
    const rows = [['Entity','Severity','Score','Total OUT','Total IN','Net','Transactions','First Seen','Last Seen','Flags','Plain Summary']];
    Object.values(scores||{}).sort((a,b)=>b.score-a.score).forEach(s => {
      rows.push([
        s.entityId, s.severity, s.score,
        Math.round(s.totalOut), Math.round(s.totalIn),
        Math.round(s.totalIn - s.totalOut),
        s.txnCount,
        s.firstSeen instanceof Date ? s.firstSeen.toISOString().slice(0,10) : '',
        s.lastSeen  instanceof Date ? s.lastSeen.toISOString().slice(0,10)  : '',
        (s.flags||[]).join('|'),
        '"' + (s.plainSummary||'').replace(/"/g,'""') + '"'
      ]);
    });
    const csv = rows.map(r=>r.join(',')).join('\n');
    downloadBlob(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'}), `entity_summary_${dateStr()}.csv`);
  }

  // ── Full case JSON export ─────────────────────────────────────────────────
  function downloadCaseJSON() {
    const pkg = State.exportCase();
    const blob = new Blob([JSON.stringify(pkg, replacer, 2)], {type:'application/json'});
    downloadBlob(blob, `case_export_${dateStr()}.json`);
  }

  // ── Flag report CSV ───────────────────────────────────────────────────────
  function downloadFlagCSV(flags, transactions) {
    const txnMap = {};
    (transactions||[]).forEach(t => { txnMap[t.id] = t; });

    const rows = [['Rule ID','Severity','Description','Amount','Transaction IDs','Dates','Narrations']];
    (flags||[]).forEach(f => {
      const txns = (f.txnIds||[]).map(id => txnMap[id]).filter(Boolean);
      const dates = txns.map(t => (t.dateTime instanceof Date ? t.dateTime.toISOString().slice(0,10) : String(t.dateTime||'').slice(0,10))).join(' | ');
      const narrs = txns.map(t => (t.narration||'').slice(0,40)).join(' | ');
      rows.push([
        f.ruleId, f.severity,
        '"' + (f.description||'').replace(/"/g,'""') + '"',
        Math.round(f.amount||0),
        (f.txnIds||[]).join('|'),
        '"' + dates + '"',
        '"' + narrs.replace(/"/g,'""') + '"'
      ]);
    });
    const csv = rows.map(r=>r.join(',')).join('\n');
    downloadBlob(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'}), `flags_${dateStr()}.csv`);
  }

  // ── Print-optimised HTML report ───────────────────────────────────────────
  function printReport(computed, caseInfo) {
    const { balance, cash, flags, scores, stories, dataQuality } = computed;
    const top5 = Object.values(scores||{}).sort((a,b)=>b.score-a.score).slice(0,5);
    const filter = computed.activeFilter || {};

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>Investigation Report — ${caseInfo?.name||'RAJ KUMAR'}</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 11pt; color: #111; margin: 20mm; }
  h1 { font-size: 16pt; border-bottom: 2px solid #333; padding-bottom: 6px; }
  h2 { font-size: 13pt; border-bottom: 1px solid #aaa; padding-bottom: 4px; margin-top: 16px; }
  h3 { font-size: 11pt; margin: 10px 0 4px; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 9pt; }
  th { background: #333; color: white; padding: 5px 8px; text-align: left; }
  td { border: 1px solid #ccc; padding: 4px 8px; vertical-align: top; }
  tr:nth-child(even) td { background: #f5f5f5; }
  .kpi-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 8px; margin: 8px 0; }
  .kpi { border: 1px solid #ccc; padding: 8px; border-radius: 4px; }
  .kpi-label { font-size: 9pt; color: #666; margin-bottom: 2px; }
  .kpi-value { font-size: 15pt; font-weight: bold; }
  .in { color: #2a7a3b; } .out { color: #c0392b; }
  .sev-Critical { color: #c0392b; font-weight: bold; }
  .sev-High { color: #d35400; font-weight: bold; }
  .sev-Medium { color: #b7950b; }
  .sev-Low { color: #1a8a2e; }
  .notice { background: #fff8e1; border: 1px solid #f0c000; padding: 8px; border-radius: 4px; font-size: 9pt; margin: 8px 0; }
  .flag-box { background: #fff3e0; border-left: 3px solid #ff7700; padding: 6px 8px; margin: 4px 0; font-size: 9pt; }
  @media print { body { margin: 15mm; } }
</style></head>
<body>
<h1>Financial Investigation Report</h1>
<p><strong>Case:</strong> ${caseInfo?.name||'RAJ KUMAR — Primary Investigation'}<br>
<strong>Period:</strong> ${filter.from||'Apr 2016'} to ${filter.to||'Jun 2026'}<br>
<strong>Generated:</strong> ${new Date().toLocaleString('en-IN')}<br>
<strong>Engine Version:</strong> ${Engine.VERSION}</p>

<div class="notice">⚠ This report presents financial patterns derived from bank records. It does not draw legal conclusions. Every figure is traceable to source transactions. Data marked "Imported" was extracted from PDF statements and should be verified against originals before use as evidence.</div>

<h2>Financial Summary</h2>
<div class="kpi-grid">
  <div class="kpi"><div class="kpi-label">Total Inflow</div><div class="kpi-value in">${fmt(balance.totalIn)}</div></div>
  <div class="kpi"><div class="kpi-label">Total Outflow</div><div class="kpi-value out">${fmt(balance.totalOut)}</div></div>
  <div class="kpi"><div class="kpi-label">Net Flow</div><div class="kpi-value ${balance.netFlow>=0?'in':'out'}">${fmt(balance.netFlow)}</div></div>
  <div class="kpi"><div class="kpi-label">Transactions</div><div class="kpi-value">${(computed.periodTransactions||[]).length}</div></div>
  <div class="kpi"><div class="kpi-label">Cash Withdrawn (ATM)</div><div class="kpi-value out">${fmt(cash?.cashOut||0)}</div></div>
  <div class="kpi"><div class="kpi-label">Unmatched Cash</div><div class="kpi-value">${cash?.unmatchedCash?.length||0} withdrawals</div></div>
</div>

<h2>Auto-Detected Patterns (${stories?.length||0})</h2>
${(stories||[]).map(s=>`<div class="flag-box"><strong class="sev-${s.severity}">[${s.severity}] ${s.title}</strong><br>${s.description}</div>`).join('')||'<p>No significant patterns detected in this period.</p>'}

<h2>Entity Risk Summary</h2>
<table>
<tr><th>Entity</th><th>Risk Score</th><th>Severity</th><th>Total OUT</th><th>Total IN</th><th>Transactions</th><th>Key Flags</th></tr>
${Object.values(scores||{}).sort((a,b)=>b.score-a.score).slice(0,15).map(s=>`
<tr><td>${s.entityId}</td><td>${s.score}/100</td><td class="sev-${s.severity}">${s.severity}</td>
<td class="out">${fmt(s.totalOut)}</td><td class="in">${fmt(s.totalIn)}</td>
<td>${s.txnCount}</td><td style="font-size:8pt">${(s.flags||[]).slice(0,3).join(', ')}</td></tr>`).join('')}
</table>

<h2>Pattern Flags Detected</h2>
<table>
<tr><th>Rule</th><th>Severity</th><th>Description</th><th>Amount</th></tr>
${(flags||[]).map(f=>`<tr><td>${f.ruleId.replace(/_/g,' ')}</td><td class="sev-${f.severity}">${f.severity}</td><td>${f.description}</td><td>${fmt(f.amount||0)}</td></tr>`).join('')||'<tr><td colspan="4">No flags</td></tr>'}
</table>

<h2>Data Quality</h2>
<table>
<tr><th>Metric</th><th>Value</th></tr>
<tr><td>Total transactions</td><td>${dataQuality?.total?.toLocaleString()}</td></tr>
<tr><td>Verified (electronic source)</td><td>${dataQuality?.verified} (${Math.round((dataQuality?.verified||0)/(dataQuality?.total||1)*100)}%)</td></tr>
<tr><td>Imported (PDF extracted)</td><td>${dataQuality?.imported} (${Math.round((dataQuality?.imported||0)/(dataQuality?.total||1)*100)}%)</td></tr>
<tr><td>Missing balances</td><td>${dataQuality?.missingBalances}</td></tr>
<tr><td>Unresolved entities</td><td>${dataQuality?.unresolved}</td></tr>
<tr><td>Completeness score</td><td>${dataQuality?.completenessScore}%</td></tr>
</table>

<h2>Top 100 Transactions (by amount)</h2>
<table>
<tr><th>Date</th><th>Bank</th><th>Dir</th><th>Amount</th><th>Entity</th><th>Category</th><th>Narration</th><th>Prov.</th></tr>
${[...(computed.periodTransactions||[])].sort((a,b)=>b.amount-a.amount).slice(0,100).map(t=>{
  const d = t.dateTime instanceof Date ? t.dateTime.toISOString().slice(0,10) : String(t.dateTime||'').slice(0,10);
  return `<tr>
    <td style="white-space:nowrap">${d}</td><td>${t.bank}</td>
    <td class="${t.direction==='IN'?'in':'out'}">${t.direction}</td>
    <td style="text-align:right;font-weight:bold" class="${t.direction==='IN'?'in':'out'}">${fmt(t.amount)}</td>
    <td>${t.entityId||'—'}</td><td>${t.categoryId||'—'}</td>
    <td style="font-size:8pt;max-width:200px;overflow:hidden">${(t.narration||'').slice(0,60)}</td>
    <td style="font-size:8pt">${(t.provenance||'?').slice(0,3)}</td>
  </tr>`;
}).join('')}
</table>

<p style="margin-top:20px;font-size:9pt;color:#666">— End of Report — Generated by Financial Investigation Platform v${Engine.VERSION}</p>
</body></html>`;

    const win = window.open('', '_blank');
    win.document.write(html);
    win.document.close();
    setTimeout(() => win.print(), 500);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function replacer(key, val) {
    if (val instanceof Date) return val.toISOString();
    return val;
  }

  function dateStr() { return new Date().toISOString().slice(0,10); }

  return { downloadCSV, downloadEntityCSV, downloadCaseJSON, downloadFlagCSV, printReport };

})();

if (typeof window !== 'undefined') window.Export = Export;
