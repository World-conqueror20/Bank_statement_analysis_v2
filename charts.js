/**
 * charts.js
 * ECharts visualization layer for the Financial Investigation Platform.
 * All chart renderers consume state.computed output — no raw data access.
 * Lazy-initialized: charts only render when their tab is active.
 *
 * Version: 1.0.0
 */

'use strict';

const Charts = (() => {

  const COLORS = {
    in: '#4caf6e', out: '#e05252',
    amber: '#f0a500', govt: '#5b8dee',
    critical: '#ff4444', high: '#ff7700', medium: '#f0c000', low: '#6bba75',
    bg: '#1a1e26', bgDark: '#13161b',
    text: '#8a94a8', textBright: '#e8ecf2',
    border: '#2c3347',
    series: ['#5b8dee','#f0a500','#e05252','#4caf6e','#b06bff','#ff6b35','#00c9d4','#ff91a4'],
  };

  const baseOption = {
    backgroundColor: 'transparent',
    textStyle: { fontFamily: "'Inter', system-ui, sans-serif", color: COLORS.text, fontSize: 11 },
    animation: true,
    animationDuration: 400,
  };

  function fmt(n) {
    if (n === null || n === undefined) return '—';
    if (Math.abs(n) >= 10000000) return '₹' + (n/10000000).toFixed(2) + 'Cr';
    if (Math.abs(n) >= 100000)   return '₹' + (n/100000).toFixed(2) + 'L';
    if (Math.abs(n) >= 1000)     return '₹' + (n/1000).toFixed(1) + 'K';
    return '₹' + n.toFixed(0);
  }

  const instances = {}; // chartId → ECharts instance

  function getOrCreate(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    if (instances[id]) return instances[id];
    instances[id] = echarts.init(el, null, { renderer: 'canvas' });
    window.addEventListener('resize', () => instances[id]?.resize());
    return instances[id];
  }

  // ── 1. Running Balance Chart ─────────────────────────────────────────────────
  function renderRunningBalance(computed) {
    const chart = getOrCreate('chart-balance');
    if (!chart) return;

    const rb = computed.balance.runningBalance;
    if (!rb || rb.length === 0) { chart.clear(); return; }

    // Build series per bank
    const axisPts = rb.filter(r => {
      const t = computed.transactions.find(t => t.id === r.txnId);
      return t?.bank === 'Axis';
    });
    const pnbPts = rb.filter(r => {
      const t = computed.transactions.find(t => t.id === r.txnId);
      return t?.bank === 'PNB';
    });

    // For combined: use totalIn - totalOut cumulative
    const sorted = [...rb].sort((a,b) => new Date(a.date) - new Date(b.date));
    const combinedData = sorted.map(r => [
      typeof r.date === 'string' ? r.date : new Date(r.date).toISOString().slice(0,10),
      r.cumulativeIn - r.cumulativeOut
    ]);

    // Event markers
    const markers = (State.eventMarkers || []).map(m => ({
      xAxis: typeof m.date === 'string' ? m.date.slice(0,10) : new Date(m.date).toISOString().slice(0,10),
      label: { formatter: m.label?.slice(0,12), color: COLORS.amber, fontSize: 9 },
      lineStyle: { color: COLORS.amber, width: 1, type: 'dashed' },
    }));

    chart.setOption({
      ...baseOption,
      grid: { left: 60, right: 16, top: 16, bottom: 40 },
      tooltip: {
        trigger: 'axis', backgroundColor: '#1a1e26',
        borderColor: '#2c3347', textStyle: { color: '#e8ecf2', fontSize: 11 },
        formatter: params => {
          const d = params[0]?.data;
          return `<b>${params[0]?.axisValue}</b><br/>Net: ${fmt(params[0]?.value[1])}`;
        }
      },
      xAxis: {
        type: 'time',
        axisLine: { lineStyle: { color: COLORS.border } },
        axisLabel: { color: COLORS.text, fontSize: 10 },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: COLORS.text, fontSize: 10, formatter: v => fmt(v) },
        splitLine: { lineStyle: { color: COLORS.border, type: 'dashed' } },
        axisLine: { show: false },
      },
      series: [{
        name: 'Combined Net',
        type: 'line',
        data: combinedData,
        smooth: 0.3,
        showSymbol: false,
        lineStyle: { color: COLORS.amber, width: 2 },
        areaStyle: { color: { type: 'linear', x:0,y:0,x2:0,y2:1, colorStops: [
          { offset: 0, color: 'rgba(240,165,0,0.18)' },
          { offset: 1, color: 'rgba(240,165,0,0.01)' }
        ]}},
      }],
      markLine: markers.length > 0 ? { data: markers } : undefined,
    });
  }

  // ── 2. Monthly Inflow/Outflow Bar Chart ──────────────────────────────────────
  function renderMonthlyFlow(computed) {
    const chart = getOrCreate('chart-monthly');
    if (!chart) return;

    const txns = computed.displayTransactions || computed.periodTransactions || [];
    const monthly = {};
    txns.forEach(t => {
      const d = typeof t.dateTime === 'string' ? t.dateTime : new Date(t.dateTime).toISOString();
      const ym = d.slice(0, 7);
      if (!monthly[ym]) monthly[ym] = { in: 0, out: 0 };
      if (t.direction === 'IN') monthly[ym].in += t.amount;
      else monthly[ym].out += t.amount;
    });

    const months = Object.keys(monthly).sort();
    const inData  = months.map(m => monthly[m].in);
    const outData = months.map(m => -monthly[m].out);

    chart.setOption({
      ...baseOption,
      grid: { left: 56, right: 8, top: 10, bottom: 50 },
      tooltip: {
        trigger: 'axis', backgroundColor: '#1a1e26',
        borderColor: '#2c3347', textStyle: { color: '#e8ecf2', fontSize: 11 },
        formatter: params => {
          const m = params[0]?.axisValue || '';
          const inV  = params.find(p => p.seriesName === 'IN')?.value || 0;
          const outV = Math.abs(params.find(p => p.seriesName === 'OUT')?.value || 0);
          return `<b>${m}</b><br/>🟢 IN: ${fmt(inV)}<br/>🔴 OUT: ${fmt(outV)}`;
        }
      },
      legend: { data: ['IN','OUT'], bottom: 0, textStyle: { color: COLORS.text, fontSize: 10 } },
      xAxis: {
        type: 'category', data: months,
        axisLabel: { color: COLORS.text, fontSize: 9, rotate: 40 },
        axisLine: { lineStyle: { color: COLORS.border } },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: COLORS.text, fontSize: 10, formatter: v => fmt(Math.abs(v)) },
        splitLine: { lineStyle: { color: COLORS.border, type: 'dashed' } },
        axisLine: { show: false },
      },
      series: [
        { name: 'IN',  type: 'bar', data: inData,  itemStyle: { color: COLORS.in  }, barMaxWidth: 16, stack: 'a' },
        { name: 'OUT', type: 'bar', data: outData, itemStyle: { color: COLORS.out }, barMaxWidth: 16, stack: 'a' },
      ],
    });
  }

  // ── 3. Entity Risk Scatter / Bar ─────────────────────────────────────────────
  function renderEntityScores(computed) {
    const chart = getOrCreate('chart-entities');
    if (!chart) return;

    const scores = Object.values(computed.scores || {})
      .filter(s => s.txnCount > 0 && s.entityId !== 'UNRESOLVED')
      .sort((a,b) => b.score - a.score)
      .slice(0, 15);

    if (scores.length === 0) { chart.clear(); return; }

    const sevColor = s => ({ Critical: COLORS.critical, High: COLORS.high, Medium: COLORS.medium, Low: COLORS.low }[s] || COLORS.low);

    chart.setOption({
      ...baseOption,
      grid: { left: 140, right: 60, top: 10, bottom: 10 },
      tooltip: {
        trigger: 'axis', backgroundColor: '#1a1e26',
        borderColor: '#2c3347', textStyle: { color: '#e8ecf2', fontSize: 11 },
        formatter: params => {
          const s = scores[params[0].dataIndex];
          return `<b>${s.entityId}</b> [${s.severity}]<br/>Score: ${s.score}<br/>OUT: ${fmt(s.totalOut)}<br/>IN: ${fmt(s.totalIn)}<br/>Txns: ${s.txnCount}`;
        }
      },
      xAxis: { type: 'value', max: 100, axisLabel: { color: COLORS.text, fontSize: 9 }, axisLine: { lineStyle: { color: COLORS.border } }, splitLine: { lineStyle: { color: COLORS.border, type: 'dashed' } } },
      yAxis: {
        type: 'category',
        data: scores.map(s => s.entityId),
        axisLabel: { color: COLORS.text, fontSize: 10, width: 130, overflow: 'truncate' },
        axisLine: { lineStyle: { color: COLORS.border } },
      },
      series: [{
        type: 'bar',
        data: scores.map(s => ({ value: s.score, itemStyle: { color: sevColor(s.severity) } })),
        barMaxWidth: 16,
        label: { show: true, position: 'right', color: COLORS.text, fontSize: 9, formatter: p => p.value },
      }],
    });
  }

  // ── 4. Money Destination Sunburst ────────────────────────────────────────────
  function renderDestinationTree(computed) {
    const chart = getOrCreate('chart-destination');
    if (!chart) return;

    const txns = computed.displayTransactions || [];
    const catTotals = {};
    const entityTotals = {};

    txns.filter(t => t.direction === 'OUT').forEach(t => {
      const cat = t.categoryId || 'UNKNOWN';
      const ent = t.entityId || 'UNRESOLVED';
      catTotals[cat] = (catTotals[cat] || 0) + t.amount;
      if (!entityTotals[cat]) entityTotals[cat] = {};
      entityTotals[cat][ent] = (entityTotals[cat][ent] || 0) + t.amount;
    });

    const catColors = {
      GOVERNMENT: COLORS.govt, FAMILY: '#b06bff', CASH: COLORS.medium,
      BUSINESS: '#00c9d4', BANK: '#505870', INTERNAL: '#3d4a62', UNKNOWN: '#2a3040',
    };

    const sunburstData = Object.entries(catTotals)
      .filter(([,v]) => v > 0)
      .map(([cat, total]) => ({
        name: cat, value: total,
        itemStyle: { color: catColors[cat] || '#444' },
        children: Object.entries(entityTotals[cat] || {})
          .filter(([,v]) => v > 100)
          .sort((a,b) => b[1]-a[1])
          .slice(0, 8)
          .map(([ent, val]) => ({
            name: ent.length > 12 ? ent.slice(0,12)+'…' : ent,
            value: val,
          })),
      }));

    chart.setOption({
      ...baseOption,
      tooltip: {
        trigger: 'item', backgroundColor: '#1a1e26',
        borderColor: '#2c3347', textStyle: { color: '#e8ecf2', fontSize: 11 },
        formatter: p => `${p.name}<br/>${fmt(p.value)}<br/>${p.percent?.toFixed(1)}%`,
      },
      series: [{
        type: 'sunburst', radius: ['20%','90%'],
        data: sunburstData,
        label: { color: '#e8ecf2', fontSize: 9, overflow: 'truncate' },
        emphasis: { focus: 'ancestor' },
        levels: [
          {},
          { r0: '20%', r: '55%', label: { rotate: 'tangential', fontSize: 10 } },
          { r0: '55%', r: '90%', label: { position: 'outside', fontSize: 9 } },
        ],
      }],
    });
  }

  // ── 5. Relationship Network ───────────────────────────────────────────────────
  function renderNetwork(computed) {
    const chart = getOrCreate('chart-network');
    if (!chart) return;

    const rel = computed.relationships;
    if (!rel) return;

    // Build nodes (limit to entities with meaningful relationships)
    const sigNodes = rel.nodes.filter(n => n.totalIn + n.totalOut > 5000 || n.txnCount >= 3);
    const nodeIds = new Set(sigNodes.map(n => n.id));
    nodeIds.add('SUBJECT');

    const subjectTotals = { id: 'SUBJECT', totalIn: computed.balance.totalIn, totalOut: computed.balance.totalOut, txnCount: computed.transactions.length };

    const scoreMap = computed.scores || {};
    const sevColor = id => {
      const s = scoreMap[id];
      if (!s) return '#2a3040';
      return { Critical: COLORS.critical, High: COLORS.high, Medium: COLORS.medium, Low: COLORS.low }[s.severity] || '#2a3040';
    };

    const nodes = [...sigNodes, subjectTotals]
      .filter((n,i,a) => a.findIndex(x => x.id === n.id) === i)
      .map(n => {
        const vol = (n.totalIn || 0) + (n.totalOut || 0);
        const size = n.id === 'SUBJECT' ? 40 : Math.max(12, Math.min(35, Math.sqrt(vol/10000)));
        return {
          id: n.id, name: n.id === 'SUBJECT' ? 'RAJ KUMAR' : n.id,
          symbolSize: size,
          itemStyle: { color: n.id === 'SUBJECT' ? COLORS.amber : sevColor(n.id) },
          label: { show: size > 14, color: '#e8ecf2', fontSize: 9 },
          value: vol,
        };
      });

    const edges = rel.edges
      .filter(e => nodeIds.has(e.target) || nodeIds.has(e.source))
      .filter(e => e.in + e.out > 1000)
      .map(e => ({
        source: e.source, target: e.target,
        value: e.in + e.out,
        lineStyle: {
          width: Math.max(1, Math.min(6, Math.log10(e.in + e.out) - 2)),
          color: e.out > e.in ? COLORS.out : COLORS.in,
          opacity: 0.6, curveness: 0.2,
        },
      }));

    chart.setOption({
      ...baseOption,
      tooltip: {
        trigger: 'item', backgroundColor: '#1a1e26',
        borderColor: '#2c3347', textStyle: { color: '#e8ecf2', fontSize: 11 },
        formatter: p => {
          if (p.dataType === 'node') {
            const s = scoreMap[p.data.id];
            return `<b>${p.name}</b><br/>Risk: ${s?.score || 0} [${s?.severity || 'N/A'}]<br/>Vol: ${fmt(p.data.value)}`;
          }
          return `${p.data.source} → ${p.data.target}<br/>${fmt(p.data.value)}`;
        }
      },
      series: [{
        type: 'graph', layout: 'force',
        data: nodes, edges,
        roam: true, draggable: true,
        force: { repulsion: 200, edgeLength: [80,200], gravity: 0.1 },
        emphasis: { focus: 'adjacency', lineStyle: { width: 4 } },
        edgeSymbol: ['none','arrow'],
        edgeSymbolSize: 6,
      }],
    });
  }

  // ── 6. Calendar Heatmap ───────────────────────────────────────────────────────
  function renderCalendarHeatmap(computed) {
    const chart = getOrCreate('chart-calendar');
    if (!chart) return;

    const txns = computed.displayTransactions || [];
    const daily = {};
    txns.forEach(t => {
      const d = typeof t.dateTime === 'string' ? t.dateTime.slice(0,10)
              : new Date(t.dateTime).toISOString().slice(0,10);
      daily[d] = (daily[d] || 0) + t.amount;
    });

    const data = Object.entries(daily).map(([d, v]) => [d, v]);
    if (data.length === 0) { chart.clear(); return; }

    const years = [...new Set(data.map(d => d[0].slice(0,4)))].sort();
    const calendars = years.map((y, i) => ({
      top: 30 + i * 100, left: 40, right: 10, height: 80,
      range: y, cellSize: ['auto', 12],
      dayLabel: { color: COLORS.text, fontSize: 9 },
      monthLabel: { color: COLORS.text, fontSize: 10 },
      yearLabel: { color: COLORS.amber, fontSize: 11 },
      itemStyle: { borderColor: COLORS.bgDark, borderWidth: 1 },
    }));

    const series = years.map((_, i) => ({
      type: 'heatmap', coordinateSystem: 'calendar', calendarIndex: i,
      data: data.filter(d => d[0].slice(0,4) === years[i]),
    }));

    chart.setOption({
      ...baseOption,
      tooltip: {
        trigger: 'item',
        formatter: p => `${p.value[0]}: ${fmt(p.value[1])}`,
        backgroundColor: '#1a1e26', borderColor: '#2c3347',
        textStyle: { color: '#e8ecf2', fontSize: 11 },
      },
      visualMap: {
        min: 0, max: Math.max(...data.map(d=>d[1])),
        orient: 'horizontal', left: 'center', bottom: 0,
        inRange: { color: ['#0a1810','#1a4025','#4caf6e','#f0a500','#e05252'] },
        textStyle: { color: COLORS.text, fontSize: 9 },
        calculable: true,
      },
      calendar: calendars,
      series,
    });
  }

  // ── 7. Waterfall Chart ────────────────────────────────────────────────────────
  function renderWaterfall(computed) {
    const chart = getOrCreate('chart-waterfall');
    if (!chart) return;

    const txns = computed.displayTransactions || [];
    const catTotals = {};
    txns.forEach(t => {
      const cat = t.categoryId || 'UNKNOWN';
      if (!catTotals[cat]) catTotals[cat] = { in: 0, out: 0 };
      if (t.direction === 'IN') catTotals[cat].in += t.amount;
      else catTotals[cat].out += t.amount;
    });

    const totalIn  = computed.balance.totalIn;
    const totalOut = computed.balance.totalOut;

    const cats = Object.entries(catTotals)
      .filter(([c]) => !['INTERNAL','BANK'].includes(c))
      .sort((a,b) => (b[1].in + b[1].out) - (a[1].in + a[1].out));

    const labels = ['Total IN', ...cats.map(([c]) => c), 'Total OUT', 'Net'];
    const vals = [
      totalIn,
      ...cats.map(([,v]) => v.in - v.out),
      -totalOut,
      totalIn - totalOut,
    ];

    // Waterfall helper: compute base/height for each bar
    let running = 0;
    const bases = [], heights = [], colors = [];
    vals.forEach((v, i) => {
      if (i === 0 || i === labels.length - 1) {
        bases.push(0);
        heights.push(Math.abs(v));
        colors.push(i === 0 ? COLORS.in : (v >= 0 ? COLORS.in : COLORS.out));
      } else {
        bases.push(v >= 0 ? running : running + v);
        heights.push(Math.abs(v));
        colors.push(v >= 0 ? '#2d6e42' : '#7a2828');
      }
      if (i > 0 && i < labels.length - 1) running += v;
    });

    chart.setOption({
      ...baseOption,
      grid: { left: 60, right: 16, top: 10, bottom: 50 },
      tooltip: {
        trigger: 'axis', backgroundColor: '#1a1e26',
        borderColor: '#2c3347', textStyle: { color: '#e8ecf2', fontSize: 11 },
        formatter: params => {
          const v = vals[params[0]?.dataIndex];
          return `${labels[params[0]?.dataIndex]}: ${fmt(v)}`;
        }
      },
      xAxis: {
        type: 'category', data: labels,
        axisLabel: { color: COLORS.text, fontSize: 9, rotate: 30 },
        axisLine: { lineStyle: { color: COLORS.border } },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: COLORS.text, fontSize: 10, formatter: v => fmt(v) },
        splitLine: { lineStyle: { color: COLORS.border, type: 'dashed' } },
        axisLine: { show: false },
      },
      series: [
        {
          name: 'Base', type: 'bar', stack: 'wf',
          data: bases, itemStyle: { color: 'transparent', borderColor: 'transparent' },
          emphasis: { itemStyle: { color: 'transparent' } },
        },
        {
          name: 'Value', type: 'bar', stack: 'wf',
          data: heights.map((h, i) => ({ value: h, itemStyle: { color: colors[i] } })),
          barMaxWidth: 40,
          label: { show: true, position: 'top', color: COLORS.text, fontSize: 9, formatter: p => fmt(vals[p.dataIndex]) },
        }
      ],
    });
  }

  // ── 8. Govt Receipt Timeline ─────────────────────────────────────────────────
  function renderGovtTimeline(computed) {
    const chart = getOrCreate('chart-govt');
    if (!chart) return;

    const govtTxns = computed.transactions
      .filter(t => t.categoryId === 'GOVERNMENT' && t.direction === 'IN' && t.amount > 1000)
      .sort((a,b) => new Date(a.dateTime) - new Date(b.dateTime));

    if (govtTxns.length === 0) { chart.clear(); return; }

    // For each govt credit, find total outflow in 7/30/90 days
    const scatterData = govtTxns.map(g => {
      const gDate = new Date(g.dateTime);
      const window7d  = new Date(gDate.getTime() + 7  * 86400000);
      const window30d = new Date(gDate.getTime() + 30 * 86400000);

      const out7d  = computed.transactions.filter(t => t.direction === 'OUT' && new Date(t.dateTime) > gDate && new Date(t.dateTime) <= window7d).reduce((s,t) => s+t.amount, 0);
      const out30d = computed.transactions.filter(t => t.direction === 'OUT' && new Date(t.dateTime) > gDate && new Date(t.dateTime) <= window30d).reduce((s,t) => s+t.amount, 0);
      const pct7   = g.amount > 0 ? Math.round(out7d / g.amount * 100) : 0;

      return { date: gDate.toISOString().slice(0,10), amount: g.amount, out7d, pct7, narration: g.narration?.slice(0,40) };
    });

    chart.setOption({
      ...baseOption,
      grid: { left: 60, right: 60, top: 10, bottom: 50 },
      tooltip: {
        trigger: 'axis', backgroundColor: '#1a1e26',
        borderColor: '#2c3347', textStyle: { color: '#e8ecf2', fontSize: 11 },
        formatter: params => {
          const d = scatterData[params[0]?.dataIndex];
          if (!d) return '';
          return `<b>${d.date}</b><br/>${d.narration}<br/>Received: ${fmt(d.amount)}<br/>Out in 7d: ${fmt(d.out7d)} (${d.pct7}%)`;
        }
      },
      xAxis: {
        type: 'category',
        data: scatterData.map(d => d.date),
        axisLabel: { color: COLORS.text, fontSize: 9, rotate: 30 },
        axisLine: { lineStyle: { color: COLORS.border } },
      },
      yAxis: [
        { type: 'value', name: 'Amount', nameTextStyle: { color: COLORS.text, fontSize: 9 }, axisLabel: { color: COLORS.text, fontSize: 9, formatter: v => fmt(v) }, splitLine: { lineStyle: { color: COLORS.border, type: 'dashed' } } },
        { type: 'value', name: '7d Dispersal %', min: 0, max: 100, axisLabel: { color: COLORS.amber, fontSize: 9, formatter: v => v+'%' }, splitLine: { show: false } },
      ],
      series: [
        {
          name: 'Govt Receipt', type: 'bar',
          data: scatterData.map(d => d.amount),
          itemStyle: { color: COLORS.govt }, barMaxWidth: 30,
        },
        {
          name: '7d Dispersal %', type: 'line', yAxisIndex: 1,
          data: scatterData.map(d => d.pct7),
          lineStyle: { color: COLORS.amber, width: 2 },
          itemStyle: { color: COLORS.amber },
          symbol: 'circle', symbolSize: 6,
        },
      ],
      legend: { data: ['Govt Receipt','7d Dispersal %'], bottom: 0, textStyle: { color: COLORS.text, fontSize: 10 } },
    });
  }

  // ── Replay engine ────────────────────────────────────────────────────────────
  let _replayTimer = null;
  let _replayIdx = 0;
  let _replayScript = [];

  function buildReplayScript(computed) {
    const txns = [...computed.transactions].sort((a,b) => new Date(a.dateTime) - new Date(b.dateTime));
    _replayScript = txns.map(t => ({
      id: t.id,
      date: typeof t.dateTime === 'string' ? t.dateTime.slice(0,10) : new Date(t.dateTime).toISOString().slice(0,10),
      dir: t.direction,
      amt: t.amount,
      entityId: t.entityId,
      category: t.categoryId,
      narration: t.narration?.slice(0,60),
      flags: t.flags || [],
    }));
  }

  function startReplay(speed = 1, mode = 'transaction') {
    if (_replayTimer) clearInterval(_replayTimer);
    _replayIdx = 0;

    const interval = { transaction: 120, daily: 80, monthly: 50, events: 200 }[mode] || 120;
    const el = document.getElementById('replay-narration');
    const fill = document.getElementById('replay-fill');
    const info = document.getElementById('replay-info');

    // Mode: events only — filter to significant transactions
    let script = _replayScript;
    if (mode === 'events') script = script.filter(t => t.amt > 50000 || t.flags.length > 0);

    _replayTimer = setInterval(() => {
      if (_replayIdx >= script.length) { stopReplay(); return; }
      const t = script[_replayIdx++];

      // Update narration
      if (el) {
        const dir = t.dir === 'IN' ? '▲ IN ' : '▼ OUT ';
        const fmt_amt = Engine.formatINR(t.amt);
        el.textContent = `${t.date}  ${dir}${fmt_amt}  →  ${t.narration}`;
        el.style.color = t.dir === 'IN' ? '#4caf6e' : '#e05252';
      }
      if (fill) fill.style.width = ((_replayIdx / script.length) * 100) + '%';
      if (info) info.textContent = `${_replayIdx} / ${script.length}`;

      // Highlight corresponding row in table
      document.querySelectorAll('.txn-table tr.replay-active').forEach(r => r.classList.remove('replay-active'));
      const row = document.querySelector(`tr[data-txn-id="${t.id}"]`);
      if (row) { row.classList.add('replay-active'); row.scrollIntoView?.({ block:'nearest', behavior:'smooth' }); }

    }, Math.round(interval / speed));
  }

  function stopReplay() {
    if (_replayTimer) { clearInterval(_replayTimer); _replayTimer = null; }
    State.setReplayState({ running: false });
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  function renderAll(computed) {
    if (!computed) return;
    renderRunningBalance(computed);
    renderMonthlyFlow(computed);
    renderEntityScores(computed);
  }

  function renderLazy(tabId, computed) {
    if (!computed) return;
    const renders = {
      'tab-flow':     () => { renderDestinationTree(computed); renderWaterfall(computed); },
      'tab-network':  () => { renderNetwork(computed); },
      'tab-calendar': () => { renderCalendarHeatmap(computed); },
      'tab-govt':     () => { renderGovtTimeline(computed); },
    };
    if (renders[tabId]) renders[tabId]();
  }

  return {
    renderAll,
    renderLazy,
    renderRunningBalance,
    renderMonthlyFlow,
    renderEntityScores,
    renderDestinationTree,
    renderNetwork,
    renderCalendarHeatmap,
    renderWaterfall,
    renderGovtTimeline,
    buildReplayScript,
    startReplay,
    stopReplay,
    instances,
    resize() { Object.values(instances).forEach(c => c?.resize()); },
  };

})();

if (typeof window !== 'undefined') window.Charts = Charts;

// ═══════════════════════════════════════════════════════════════════════════════
// EXTENSION — Missing visualizations added
// ═══════════════════════════════════════════════════════════════════════════════

const ChartsExt = (() => {

  const COLORS = {
    in: '#4caf6e', out: '#e05252', amber: '#f0a500', govt: '#5b8dee',
    critical: '#ff4444', high: '#ff7700', medium: '#f0c000', low: '#6bba75',
    text: '#8a94a8', textBright: '#e8ecf2', border: '#2c3347', bg: '#1a1e26',
    series: ['#5b8dee','#f0a500','#e05252','#4caf6e','#b06bff','#ff6b35','#00c9d4','#ff91a4','#e91e63','#00bcd4'],
  };

  function fmt(n) {
    if (!n && n!==0) return '—';
    const a=Math.abs(n);
    if(a>=10000000) return '₹'+(n/10000000).toFixed(2)+'Cr';
    if(a>=100000)   return '₹'+(n/100000).toFixed(2)+'L';
    if(a>=1000)     return '₹'+(n/1000).toFixed(1)+'K';
    return '₹'+Math.round(n).toLocaleString('en-IN');
  }

  function getOrCreate(id) {
    if (!window.echarts) return null;
    const el = document.getElementById(id);
    if (!el) return null;
    if (Charts.instances[id]) return Charts.instances[id];
    Charts.instances[id] = echarts.init(el, null, {renderer:'canvas'});
    window.addEventListener('resize', () => Charts.instances[id]?.resize());
    return Charts.instances[id];
  }

  // ── 1. CHORD DIAGRAM ────────────────────────────────────────────────────────
  // Shows who transacted with whom and in what volume. Width = ₹ amount.
  function renderChord(computed) {
    const chart = getOrCreate('chart-chord');
    if (!chart) return;

    const scores = computed.scores || {};
    // Pick top entities by total volume
    const topEntities = Object.values(scores)
      .filter(s => s.txnCount > 0 && s.entityId !== 'UNRESOLVED')
      .sort((a,b) => (b.totalIn+b.totalOut) - (a.totalIn+a.totalOut))
      .slice(0, 10)
      .map(s => s.entityId);

    const SUBJECT = 'RAJ KUMAR';
    const nodes = [SUBJECT, ...topEntities];
    const nodeIdx = {};
    nodes.forEach((n,i) => nodeIdx[n] = i);

    // Build matrix: matrix[i][j] = amount flowing from node i to node j
    const size = nodes.length;
    const matrix = Array.from({length:size}, () => new Array(size).fill(0));

    const txns = computed.transactions || [];
    txns.forEach(t => {
      if (!t.entityId || t.entityId === 'UNRESOLVED') return;
      if (!topEntities.includes(t.entityId)) return;
      const eIdx = nodeIdx[t.entityId];
      const sIdx = nodeIdx[SUBJECT];
      if (t.direction === 'OUT') matrix[sIdx][eIdx] += t.amount;
      else                       matrix[eIdx][sIdx] += t.amount;
    });

    const nodeColors = nodes.map((n,i) => {
      if (n === SUBJECT) return COLORS.amber;
      const s = scores[n];
      if (!s) return COLORS.series[i % COLORS.series.length];
      return {Critical:COLORS.critical,High:COLORS.high,Medium:COLORS.medium,Low:COLORS.low}[s.severity] || COLORS.series[i%COLORS.series.length];
    });

    chart.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'item',
        backgroundColor: '#1a1e26', borderColor: '#2c3347',
        textStyle: { color: '#e8ecf2', fontSize: 11 },
        formatter: p => {
          if (p.data.source !== undefined)
            return `${p.data.source} → ${p.data.target}: ${fmt(p.data.value)}`;
          return p.name;
        }
      },
      series: [{
        type: 'chord',  // fallback: ECharts 5 uses sankey-style if chord unavailable
        // ECharts 5 doesn't have native chord — use a custom sankey approximation
        // Actually use the graph type in circular layout as chord-like view
        layout: undefined,
      }],
    });

    // ECharts 5 doesn't have chord diagram natively. Use a Sankey as the closest equivalent.
    // Build sankey links: SUBJECT → each entity (OUT), each entity → SUBJECT (IN)
    const sankeyNodes = nodes.map((n,i) => ({
      name: n,
      itemStyle: { color: nodeColors[i] },
    }));
    const sankeyLinks = [];
    topEntities.forEach(ent => {
      const s = scores[ent];
      if (!s) return;
      if (s.totalOut > 0) sankeyLinks.push({ source: SUBJECT, target: ent, value: Math.round(s.totalOut) });
      if (s.totalIn  > 0) sankeyLinks.push({ source: ent, target: SUBJECT+' ↩', value: Math.round(s.totalIn) });
    });
    // Add return node
    if (sankeyLinks.some(l => l.target.includes('↩'))) {
      sankeyNodes.push({ name: SUBJECT+' ↩', itemStyle: { color: '#2a3040' } });
    }

    chart.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'item', backgroundColor: '#1a1e26',
        borderColor: '#2c3347', textStyle: { color: '#e8ecf2', fontSize: 11 },
        formatter: p => {
          if (p.data.source) return `${p.data.source} → ${p.data.target}: ${fmt(p.data.value)}`;
          return `${p.name}`;
        }
      },
      series: [{
        type: 'sankey',
        data: sankeyNodes,
        links: sankeyLinks.filter(l => l.value > 0),
        emphasis: { focus: 'adjacency' },
        lineStyle: { color: 'gradient', opacity: 0.5 },
        label: { color: COLORS.textBright, fontSize: 10 },
        left: '5%', right: '5%', top: '5%', bottom: '5%',
        nodeWidth: 16, nodeGap: 12,
      }],
    }, true);
  }

  // ── 2. PARALLEL COORDINATES ─────────────────────────────────────────────────
  // Each entity = one line across axes: Amount, Frequency, Avg, Cash%, GovtLink, Risk
  function renderParallelCoords(computed) {
    const chart = getOrCreate('chart-parallel');
    if (!chart) return;

    const scores = Object.values(computed.scores || {})
      .filter(s => s.txnCount > 0 && s.entityId !== 'UNRESOLVED')
      .sort((a,b) => b.score - a.score)
      .slice(0, 20);

    if (scores.length === 0) { chart.clear(); return; }

    const txns = computed.transactions || [];
    const govtTxns = txns.filter(t => t.categoryId === 'GOVERNMENT' && t.direction === 'IN');

    const rows = scores.map(s => {
      const entityTxns = txns.filter(t => t.entityId === s.entityId);
      const cashTxns = entityTxns.filter(t => t.categoryId === 'CASH');
      const cashPct = entityTxns.length > 0 ? cashTxns.length / entityTxns.length * 100 : 0;

      // Govt linkage: any transfer within 7d of a govt credit
      let govtLinked = 0;
      govtTxns.forEach(g => {
        const gd = new Date(g.dateTime).getTime();
        if (entityTxns.some(t => {
          const td = new Date(t.dateTime).getTime();
          return td > gd && td <= gd + 7*86400000;
        })) govtLinked = 1;
      });

      const totalVol = s.totalOut + s.totalIn;
      const avgAmt = s.txnCount > 0 ? totalVol / s.txnCount : 0;

      return [
        Math.round(totalVol / 1000),    // 0: Total Volume (₹K)
        s.txnCount,                      // 1: Transaction Count
        Math.round(avgAmt / 1000),       // 2: Avg per transaction (₹K)
        Math.round(cashPct),             // 3: Cash Involvement %
        govtLinked * 100,                // 4: Govt Linkage (0 or 100)
        s.score,                         // 5: Risk Score
      ];
    });

    const sevColor = s => ({Critical:COLORS.critical,High:COLORS.high,Medium:COLORS.medium,Low:COLORS.low}[s.severity]||COLORS.low);

    chart.setOption({
      backgroundColor: 'transparent',
      tooltip: { trigger: 'item', backgroundColor: '#1a1e26', borderColor: '#2c3347',
        textStyle: { color: '#e8ecf2', fontSize: 11 },
        formatter: p => scores[p.dataIndex] ? `<b>${scores[p.dataIndex].entityId}</b><br/>Risk: ${scores[p.dataIndex].score} [${scores[p.dataIndex].severity}]` : '' },
      parallelAxis: [
        { dim: 0, name: 'Volume (₹K)', nameTextStyle:{color:COLORS.text,fontSize:10} },
        { dim: 1, name: 'Txn Count',   nameTextStyle:{color:COLORS.text,fontSize:10} },
        { dim: 2, name: 'Avg (₹K)',    nameTextStyle:{color:COLORS.text,fontSize:10} },
        { dim: 3, name: 'Cash %',      nameTextStyle:{color:COLORS.text,fontSize:10}, min:0, max:100 },
        { dim: 4, name: 'Govt Linked', nameTextStyle:{color:COLORS.text,fontSize:10}, min:0, max:100 },
        { dim: 5, name: 'Risk Score',  nameTextStyle:{color:COLORS.text,fontSize:10}, min:0, max:100 },
      ],
      parallel: {
        left: '5%', right: '18%', top: 40, bottom: 30,
        axisExpandable: true,
        lineStyle: { width: 1.5, opacity: 0.7 },
      },
      series: [{
        type: 'parallel',
        data: rows.map((r, i) => ({
          value: r,
          lineStyle: { color: sevColor(scores[i]), width: 2, opacity: 0.75 },
        })),
        emphasis: { lineStyle: { width: 4, opacity: 1 } },
      }],
    });
  }

  // ── 3. ANIMATED TIME-AWARE NETWORK ──────────────────────────────────────────
  // Network that plays through time — nodes grow, edges appear as money flows
  let _netTimer = null;
  let _netYear = 2007;
  let _netPlaying = false;

  function renderAnimatedNetwork(computed, yearFilter) {
    const chart = getOrCreate('chart-network-animated');
    if (!chart) return;

    const allTxns = computed.transactions || [];
    const scores  = computed.scores || {};

    // Filter to transactions up to yearFilter
    const cutoff = new Date(`${yearFilter}-12-31`);
    const txns = allTxns.filter(t => new Date(t.dateTime) <= cutoff);

    // Build nodes and edges from this snapshot
    const entityVols = {};
    const edges = {};

    txns.forEach(t => {
      if (!t.entityId || t.entityId === 'UNRESOLVED') return;
      if (!entityVols[t.entityId]) entityVols[t.entityId] = { in:0, out:0, count:0 };
      if (t.direction === 'IN') entityVols[t.entityId].in += t.amount;
      else entityVols[t.entityId].out += t.amount;
      entityVols[t.entityId].count++;

      const key = `SUBJECT__${t.entityId}`;
      if (!edges[key]) edges[key] = { source:'RAJ KUMAR', target:t.entityId, in:0, out:0 };
      if (t.direction === 'IN') edges[key].in += t.amount;
      else edges[key].out += t.amount;
    });

    const sigEntities = Object.entries(entityVols)
      .filter(([,v]) => v.in+v.out > 5000 || v.count >= 3)
      .map(([id]) => id);

    const sevColor = id => {
      const s = scores[id];
      if (!s) return '#2a3040';
      return {Critical:COLORS.critical,High:COLORS.high,Medium:COLORS.medium,Low:COLORS.low}[s.severity]||'#2a3040';
    };

    const nodes = [
      { id:'RAJ KUMAR', name:'RAJ KUMAR', symbolSize:40, itemStyle:{color:COLORS.amber},
        label:{show:true, color:COLORS.textBright, fontSize:10, fontWeight:'bold'} },
      ...sigEntities.map(id => {
        const v = entityVols[id];
        const vol = v.in + v.out;
        const size = Math.max(10, Math.min(35, Math.sqrt(vol/8000)));
        return { id, name:id.length>12?id.slice(0,12)+'…':id, symbolSize:size,
          itemStyle:{color: sevColor(id)},
          label:{show:size>14, color:COLORS.text, fontSize:9} };
      }),
    ];

    const edgeList = Object.values(edges)
      .filter(e => sigEntities.includes(e.target) && (e.in+e.out)>1000)
      .map(e => ({
        source: e.source, target: e.target,
        value: e.in + e.out,
        lineStyle: {
          width: Math.max(1, Math.min(8, Math.log10(e.in+e.out)-2)),
          color: e.out > e.in ? COLORS.out : COLORS.in,
          opacity: 0.65, curveness: 0.2,
        },
        label: { show: false },
      }));

    chart.setOption({
      backgroundColor: 'transparent',
      graphic: [{
        type: 'text',
        left: '50%', top: 10,
        style: {
          text: String(yearFilter),
          font: 'bold 48px "JetBrains Mono", monospace',
          fill: 'rgba(240,165,0,0.15)',
          textAlign: 'center',
        },
      }],
      tooltip: {
        trigger: 'item', backgroundColor: '#1a1e26',
        borderColor: '#2c3347', textStyle: { color: '#e8ecf2', fontSize:11 },
        formatter: p => {
          if (p.dataType === 'node') {
            const s = scores[p.data.id];
            const v = entityVols[p.data.id];
            return `<b>${p.name}</b><br/>Risk: ${s?.score||0} [${s?.severity||'—'}]<br/>Vol: ${fmt(v ? v.in+v.out : 0)}`;
          }
          return `${p.data.source} ↔ ${p.data.target}<br/>${fmt(p.data.value)}`;
        }
      },
      series: [{
        type: 'graph', layout: 'force',
        data: nodes, edges: edgeList,
        roam: true, draggable: true,
        force: { repulsion: 180, edgeLength: [60,220], gravity: 0.08, friction: 0.6 },
        emphasis: { focus: 'adjacency', lineStyle: { width: 5 } },
        edgeSymbol: ['none','arrow'], edgeSymbolSize: 6,
        animationDuration: 600,
      }],
    });
  }

  function startNetworkAnimation(computed) {
    if (_netPlaying) return;
    _netPlaying = true;
    _netYear = 2007;
    const years = [];
    for (let y = 2007; y <= 2026; y++) years.push(y);

    const tick = () => {
      if (!_netPlaying || _netYear > 2026) { _netPlaying = false; return; }
      renderAnimatedNetwork(computed, _netYear);
      const slider = document.getElementById('net-year-slider');
      if (slider) slider.value = _netYear;
      const label = document.getElementById('net-year-label');
      if (label) label.textContent = _netYear;
      _netYear++;
      if (_netYear <= 2026) _netTimer = setTimeout(tick, 1200);
      else _netPlaying = false;
    };
    tick();
  }

  function stopNetworkAnimation() {
    _netPlaying = false;
    if (_netTimer) { clearTimeout(_netTimer); _netTimer = null; }
  }

  // ── 4. SCENARIO COMPARISON ──────────────────────────────────────────────────
  // Period A vs Period B — recomputes engine on both and renders side-by-side
  function renderScenarioComparison(computedA, computedB, labelA, labelB) {
    const chartA = getOrCreate('chart-scenario-a');
    const chartB = getOrCreate('chart-scenario-b');
    if (!chartA || !chartB) return;

    function makeWaterfallOption(c, label) {
      const cats = {};
      (c.displayTransactions||c.periodTransactions||[]).forEach(t => {
        const cat = t.categoryId||'UNKNOWN';
        if (!cats[cat]) cats[cat]={in:0,out:0};
        if(t.direction==='IN') cats[cat].in+=t.amount;
        else cats[cat].out+=t.amount;
      });

      const catColors = {GOVERNMENT:COLORS.govt,FAMILY:'#b06bff',CASH:COLORS.medium,
        BUSINESS:'#00c9d4',BANK:'#505870',INTERNAL:'#3d4a62',UNKNOWN:'#2a3040'};

      const labels = ['Total IN'];
      const vals   = [c.balance.totalIn];
      Object.entries(cats).filter(([k])=>!['INTERNAL','BANK'].includes(k)).forEach(([cat,v])=>{
        labels.push(cat);
        vals.push(v.in - v.out);
      });
      labels.push('Total OUT'); vals.push(-c.balance.totalOut);
      labels.push('Net');       vals.push(c.balance.netFlow);

      let running = 0;
      const bases=[], heights=[], colors=[];
      vals.forEach((v,i) => {
        if (i===0||i===labels.length-1) { bases.push(0); heights.push(Math.abs(v)); colors.push(i===0?COLORS.in:(v>=0?COLORS.in:COLORS.out)); }
        else { bases.push(v>=0?running:running+v); heights.push(Math.abs(v)); colors.push(v>=0?'#2d6e42':'#7a2828'); }
        if(i>0&&i<labels.length-1) running+=v;
      });

      return {
        backgroundColor:'transparent',
        title:{ text:label, textStyle:{color:COLORS.textBright,fontSize:12}, top:0 },
        grid:{left:60,right:8,top:36,bottom:50},
        tooltip:{trigger:'axis',backgroundColor:'#1a1e26',borderColor:'#2c3347',
          textStyle:{color:'#e8ecf2',fontSize:11},
          formatter:params=>`${labels[params[0]?.dataIndex]}: ${fmt(vals[params[0]?.dataIndex])}`},
        xAxis:{type:'category',data:labels,axisLabel:{color:COLORS.text,fontSize:9,rotate:30},axisLine:{lineStyle:{color:COLORS.border}}},
        yAxis:{type:'value',axisLabel:{color:COLORS.text,fontSize:10,formatter:v=>fmt(Math.abs(v))},splitLine:{lineStyle:{color:COLORS.border,type:'dashed'}},axisLine:{show:false}},
        series:[
          {name:'base',type:'bar',stack:'wf',data:bases,itemStyle:{color:'transparent',borderColor:'transparent'},emphasis:{itemStyle:{color:'transparent'}}},
          {name:'val',type:'bar',stack:'wf',data:heights.map((h,i)=>({value:h,itemStyle:{color:colors[i]}})),barMaxWidth:40,
           label:{show:true,position:'top',color:COLORS.text,fontSize:9,formatter:p=>fmt(vals[p.dataIndex])}},
        ],
      };
    }

    chartA.setOption(makeWaterfallOption(computedA, labelA));
    chartB.setOption(makeWaterfallOption(computedB, labelB));

    // Diff panel
    const diff = document.getElementById('scenario-diff');
    if (!diff) return;

    const netDiff  = computedB.balance.netFlow - computedA.balance.netFlow;
    const inDiff   = computedB.balance.totalIn  - computedA.balance.totalIn;
    const outDiff  = computedB.balance.totalOut - computedA.balance.totalOut;
    const txnDiff  = (computedB.displayTransactions||[]).length - (computedA.displayTransactions||[]).length;
    const flagDiff = (computedB.flags||[]).length - (computedA.flags||[]).length;
    const cashDiff = (computedB.cash?.cashOut||0) - (computedA.cash?.cashOut||0);

    const row = (label,a,b,diff,isNum=true) => {
      const pct = isNum && a ? Math.round((b-a)/Math.abs(a)*100) : null;
      const cls = diff > 0 ? 'color:var(--in)' : diff < 0 ? 'color:var(--out)' : 'color:var(--text-muted)';
      return `<tr>
        <td style="color:var(--text-secondary);padding:5px 8px">${label}</td>
        <td style="text-align:right;padding:5px 8px;font-family:var(--font-mono)">${isNum?fmt(a):a}</td>
        <td style="text-align:right;padding:5px 8px;font-family:var(--font-mono)">${isNum?fmt(b):b}</td>
        <td style="text-align:right;padding:5px 8px;font-weight:700;${cls}">${diff>0?'+':''}${isNum?fmt(diff):diff}${pct!==null?` (${pct>0?'+':''}${pct}%)`:''}
        </td></tr>`;
    };

    diff.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr>
          <th style="text-align:left;padding:6px 8px;color:var(--text-muted);font-size:10px;text-transform:uppercase;letter-spacing:.06em;border-bottom:2px solid var(--border)">Metric</th>
          <th style="text-align:right;padding:6px 8px;color:var(--amber);font-size:10px;border-bottom:2px solid var(--border)">${labelA}</th>
          <th style="text-align:right;padding:6px 8px;color:var(--govt);font-size:10px;border-bottom:2px solid var(--border)">${labelB}</th>
          <th style="text-align:right;padding:6px 8px;color:var(--text-muted);font-size:10px;border-bottom:2px solid var(--border)">Change</th>
        </tr></thead>
        <tbody>
          ${row('Total IN', computedA.balance.totalIn, computedB.balance.totalIn, inDiff)}
          ${row('Total OUT', computedA.balance.totalOut, computedB.balance.totalOut, outDiff)}
          ${row('Net Flow', computedA.balance.netFlow, computedB.balance.netFlow, netDiff)}
          ${row('Cash Withdrawn', computedA.cash?.cashOut||0, computedB.cash?.cashOut||0, cashDiff)}
          ${row('Transactions', (computedA.displayTransactions||[]).length, (computedB.displayTransactions||[]).length, txnDiff, false)}
          ${row('Flags', (computedA.flags||[]).length, (computedB.flags||[]).length, flagDiff, false)}
        </tbody>
      </table>`;
  }

  // ── 5. REPLAY WITH AI NARRATION ────────────────────────────────────────────
  // Builds narration in background; plays back in sync
  let _aiNarrations = {};  // txnId → narration string (pre-generated)

  async function buildAINarration(computed) {
    if (!window.AI || !State.geminiKey) return false;
    const el = document.getElementById('replay-narration');
    if (el) { el.textContent = 'Generating AI narration… (this takes ~10s)'; el.style.color = COLORS.amber; }
    try {
      const lines = await AI.generateReplayNarration(computed);
      // Map narrations to the event-only script
      const script = (computed.transactions||[])
        .filter(t => t.amount > 10000 || (computed.flags||[]).some(f=>f.txnIds?.includes(t.id)))
        .sort((a,b) => new Date(a.dateTime)-new Date(b.dateTime))
        .slice(0, lines.length);
      script.forEach((t,i) => { if(lines[i]) _aiNarrations[t.id] = lines[i]; });
      if (el) { el.textContent = `AI narration ready (${lines.length} lines). Press ▶ to start.`; el.style.color = COLORS.low; }
      return true;
    } catch(e) {
      if (el) { el.textContent = 'AI narration failed — will use transaction data instead.'; el.style.color = COLORS.out; }
      return false;
    }
  }

  // Augment the existing replay to use AI narration when available
  function getNarration(t) {
    if (_aiNarrations[t.id]) return _aiNarrations[t.id];
    // Fallback: generate from transaction data
    const dir  = t.dir === 'IN' ? '▲ Received' : '▼ Sent';
    const amt  = Engine.formatINR(t.amt);
    const ent  = t.entityId ? ` ${t.dir==='IN'?'from':'to'} ${t.entityId}` : '';
    const flag = t.flags?.length ? ` ⚑ ${t.flags[0]}` : '';
    return `${dir} ${amt}${ent}${flag}`;
  }

  // Override Charts.startReplay to use AI narration
  const _origStart = Charts.startReplay.bind(Charts);
  Charts.startReplay = function(speed, mode) {
    // Patch: use AI narrations if available
    const script = Charts._replayScript || [];
    if (Object.keys(_aiNarrations).length > 0) {
      // Inject AI narrations into replay
      Charts._replayScriptAugmented = script.map(t => ({
        ...t,
        _narration: _aiNarrations[t.id],
      }));
    }
    _origStart(speed, mode);
  };

  return {
    renderChord,
    renderParallelCoords,
    renderAnimatedNetwork,
    startNetworkAnimation,
    stopNetworkAnimation,
    renderScenarioComparison,
    buildAINarration,
    getNarration,
  };

})();

// Merge ChartsExt into Charts
Object.assign(Charts, ChartsExt);
if (typeof window !== 'undefined') window.Charts = Charts;
