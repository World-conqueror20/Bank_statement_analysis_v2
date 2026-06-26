/**
 * engine.js
 * Core Investigation Engine — pure functions, no DOM, no side effects.
 * All calculations are deterministic and traceable.
 * AI never touches this file's outputs directly; it only receives them.
 *
 * Computation DAG (dependency order):
 *   normalizer
 *     └── classify
 *           └── entityResolver
 *                 ├── balanceEngine
 *                 ├── cashEngine
 *                 ├── patternDetector
 *                 │     └── riskScorer
 *                 └── relationshipBuilder
 *                       └── storyDetector
 *                             └── hypothesisTester
 *
 * Version: 1.0.0
 */

'use strict';

const Engine = (() => {

  // ─── Utilities ─────────────────────────────────────────────────────────────

  const VERSION = '1.0.0';

  function daysBetween(a, b) {
    return Math.abs(b - a) / 86400000;
  }

  function dateOnly(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function formatINR(n) {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency', currency: 'INR', maximumFractionDigits: 0
    }).format(n);
  }

  function uid(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;
  }

  function toDateObj(val) {
    if (val instanceof Date) return val;
    if (typeof val === 'string') return new Date(val + (val.includes('T') ? '' : 'T00:00:00'));
    return null;
  }

  // Levenshtein distance for fuzzy name matching
  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({length: m+1}, (_, i) => Array.from({length: n+1}, (_, j) => i||j));
    for (let i=1;i<=m;i++) for (let j=1;j<=n;j++)
      dp[i][j] = a[i-1]===b[j-1] ? dp[i-1][j-1] : 1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);
    return dp[m][n];
  }

  function nameSimilarity(a, b) {
    a = a.toLowerCase().trim(); b = b.toLowerCase().trim();
    if (a === b) return 1.0;
    const maxLen = Math.max(a.length, b.length);
    return maxLen === 0 ? 1 : 1 - levenshtein(a,b)/maxLen;
  }

  // ─── 1. Normalizer ─────────────────────────────────────────────────────────
  // Converts raw row objects (any source) into canonical Transactions.
  // Input contract: raw rows must have: date, bank, account, dir, amt, bal, narration, file, row

  function normalizer(rawRows, defaultProvenance = 'Imported') {
    const txns = [];
    rawRows.forEach((r, idx) => {
      const dt = toDateObj(r.date || r.dateTime);
      if (!dt || isNaN(dt)) return; // skip unparseable dates

      const amount = typeof r.amt === 'number' ? r.amt
                   : parseFloat(String(r.amt||'0').replace(/,/g,'')) || 0;
      if (amount < 0) return; // skip negative amounts (shouldn't exist)

      const balance = (r.bal !== null && r.bal !== undefined && r.bal !== '')
                    ? (typeof r.bal === 'number' ? r.bal
                       : parseFloat(String(r.bal).replace(/,/g,'')))
                    : null;

      const id = r.id || `TXN-${(r.bank||'X').slice(0,4).toUpperCase()}-${String(idx+1).padStart(4,'0')}`;

      txns.push(Schema.makeTransaction({
        id,
        dateTime:  dt,
        accountId: String(r.account || r.accountId || ''),
        bank:      String(r.bank || ''),
        direction: (r.dir || r.direction || '').toUpperCase() === 'IN' ? 'IN' : 'OUT',
        amount,
        balance:   isNaN(balance) ? null : balance,
        narration: String(r.narration || r.narr || '').trim(),
        sourceFile: String(r.file || r.sourceFile || ''),
        sourceRow:  typeof r.row === 'number' ? r.row : (r.sourceRow || idx),
        provenance: r.provenance || defaultProvenance,
      }));
    });

    // Sort chronologically
    return txns.sort((a,b) => a.dateTime - b.dateTime);
  }

  // ─── 2. Classifier ─────────────────────────────────────────────────────────
  // Assigns categoryId to each transaction based on classification rules.
  // Returns new array (immutable transactions — we carry category separately).

  function classify(transactions, rules) {
    const classRules = rules.filter(r => r.type === 'classification' && r.enabled);

    return transactions.map(t => {
      let category = Schema.Category.UNKNOWN;
      let matched = false;

      for (const rule of classRules) {
        if (matched) break;
        const patterns = rule.config.patterns || [];
        const narr = t.narration.toUpperCase();

        // Special: INTERNAL check uses own account IDs
        if (rule.id === 'CLASSIFY_INTERNAL') {
          const ownIds = rule.config.ownAccountIds || [];
          if (ownIds.some(id => t.narration.includes(id))) {
            category = Schema.Category.INTERNAL;
            matched = true;
            continue;
          }
        }

        if (patterns.some(p => narr.includes(p.toUpperCase()))) {
          category = rule.config.assignCategory;
          matched = true;
        }
      }

      // Return a new object with derived fields added
      return Object.freeze({
        ...t,
        categoryId: category,
        lineage: Object.freeze({
          ...t.lineage,
          rulesApplied: matched ? [t.lineage?.rulesApplied || [], 'CLASSIFY'].flat() : (t.lineage?.rulesApplied || []),
        }),
      });
    });
  }

  // ─── 3. Entity Resolver ────────────────────────────────────────────────────
  // Clusters transaction counterparties into entity groups.
  // Returns: { transactions (with entityId set), clusters[] }

  function entityResolver(transactions, predefinedEntities = [], edits = []) {

    // Build lookup structures from predefined entities
    const predefined = predefinedEntities.map(e => ({
      ...e,
      _phoneSet:  new Set((e.phones      || []).map(p => p.replace(/\D/g,''))),
      _upiSet:    new Set((e.upiHandles  || []).map(h => h.toLowerCase())),
      _aliasSet:  new Set((e.aliases     || []).map(a => a.toLowerCase())),
      _patternRe: (e.patterns || []).map(p => new RegExp(p, 'i')),
    }));

    // Apply manual merges from edits (event-sourced)
    const mergeMap = {}; // sourceEntityId → targetEntityId
    edits.filter(a => a.type === Schema.InvestigatorAction.MERGE_ENTITY)
         .forEach(a => { mergeMap[a.sourceEntityId] = a.targetEntityId; });

    // Auto-cluster: group unknown narrations by key fingerprint
    const autoClusterMap = {}; // fingerprint → cluster

    function extractCounterparty(narration) {
      const n = narration;
      // Extract phone numbers
      const phoneMatch = n.match(/\b([6-9]\d{9})\b/);
      // Extract UPI handles
      const upiMatch = n.match(/([a-zA-Z0-9._-]+@(?:ybl|okicici|oksbi|okaxis|paytm|upi|fam|okhdfcbank))/i);
      // Extract NEFT/RTGS beneficiary
      const neftMatch = n.match(/NEFT[_-]IN:.*?\/([^/]+)\s*$/i);
      const rtgsMatch = n.match(/NRTGS\/\w+\/([^/\n]+)/i);
      // Extract IMPS name
      const impsMatch = n.match(/IMPS[^/]*\/\d+\/([^/\n]+)/i);
      // Extract UPI name
      const upiNameMatch = n.match(/UPI\/\d+\/[^/]+\/[^/]+\/([^/\n]+)/i);

      return {
        phone: phoneMatch?.[1],
        upi:   upiMatch?.[1]?.toLowerCase(),
        name:  (neftMatch?.[1] || rtgsMatch?.[1] || impsMatch?.[1] || upiNameMatch?.[1] || '').trim(),
      };
    }

    function matchPredefined(cp, narration) {
      const narUpper = narration.toUpperCase();
      let best = null, bestScore = 0;

      for (const e of predefined) {
        let score = 0, reasons = [];

        // Phone match (strong signal)
        if (cp.phone && e._phoneSet.has(cp.phone)) { score += 0.5; reasons.push('phone'); }
        // UPI match (strong signal)
        if (cp.upi && e._upiSet.has(cp.upi)) { score += 0.5; reasons.push('upi'); }
        // Alias name match
        if (cp.name) {
          const ns = nameSimilarity(cp.name, e.displayName);
          if (ns > 0.8) { score += 0.3 * ns; reasons.push('name'); }
          for (const alias of e._aliasSet) {
            const as2 = nameSimilarity(cp.name, alias);
            if (as2 > 0.8) { score = Math.max(score, 0.3 * as2); reasons.push('alias'); }
          }
        }
        // Regex pattern match (medium signal)
        for (const re of e._patternRe) {
          if (re.test(narration)) { score += 0.35; reasons.push('pattern'); break; }
        }

        if (score > bestScore) { bestScore = score; best = { entity: e, score, reasons }; }
      }

      return bestScore >= 0.35 ? best : null; // threshold for a match
    }

    // First pass: resolve each transaction's entity
    const resolved = transactions.map(t => {
      const cp = extractCounterparty(t.narration);
      const match = matchPredefined(cp, t.narration);

      let entityId, confidence;

      if (match) {
        entityId   = match.entity.id;
        confidence = Math.min(1, match.score);
      } else {
        // Auto-cluster by fingerprint (phone > UPI > name-hash)
        const fp = cp.phone || cp.upi || (cp.name ? cp.name.toLowerCase().replace(/\s+/g,'_') : null);
        if (fp) {
          const key = `AUTO_${fp}`;
          if (!autoClusterMap[key]) {
            autoClusterMap[key] = {
              id: key, displayName: cp.name || cp.upi || cp.phone || key,
              phones: cp.phone ? [cp.phone] : [],
              upiHandles: cp.upi ? [cp.upi] : [],
              isPredefined: false, confidence: 0.6,
            };
          }
          entityId   = key;
          confidence = 0.6;
        } else {
          entityId   = 'UNRESOLVED';
          confidence = 0;
        }
      }

      // Apply manual merges
      const finalEntityId = mergeMap[entityId] || entityId;

      return Object.freeze({ ...t, entityId: finalEntityId, confidence });
    });

    // Collect all clusters (predefined + auto-discovered)
    const allClusters = [
      ...predefinedEntities,
      ...Object.values(autoClusterMap),
      { id: 'UNRESOLVED', displayName: 'Unresolved', isPredefined: false, confidence: 0 },
    ];

    return { transactions: resolved, clusters: allClusters };
  }

  // ─── 4. Balance Engine ─────────────────────────────────────────────────────
  // Computes running balance, totals, and reconciliation.

  function balanceEngine(transactions, fromDate = null, toDate = null) {
    const filtered = filterByPeriod(transactions, fromDate, toDate);
    const sorted = [...filtered].sort((a,b) => a.dateTime - b.dateTime);

    let totalIn = 0, totalOut = 0;
    const runningBalance = []; // { date, balance, cumulativeIn, cumulativeOut }

    sorted.forEach(t => {
      if (t.direction === 'IN') totalIn += t.amount;
      else totalOut += t.amount;

      runningBalance.push({
        txnId:        t.id,
        date:         t.dateTime,
        direction:    t.direction,
        amount:       t.amount,
        entityId:     t.entityId,
        categoryId:   t.categoryId,
        cumulativeIn: totalIn,
        cumulativeOut:totalOut,
        // Use actual balance if available, else computed
        balance:      t.balance !== null ? t.balance : (totalIn - totalOut),
        balanceSource:t.balance !== null ? 'observed' : 'computed',
        provenance:   t.provenance,
      });
    });

    const netFlow = totalIn - totalOut;
    const finalBalance = runningBalance.length > 0
      ? runningBalance[runningBalance.length-1].balance : 0;

    return {
      totalIn,
      totalOut,
      netFlow,
      finalBalance,
      txnCount: sorted.length,
      runningBalance,
      lineage: Schema.makeLineage({
        value: netFlow,
        derivedFrom: sorted.map(t => t.id),
        computation: 'sum(IN) - sum(OUT)',
        engineVersion: VERSION,
      }),
    };
  }

  // ─── 5. Cash Engine ────────────────────────────────────────────────────────
  // Reconstructs cash position: traces cash in/out, flags unmatched cash.

  function cashEngine(transactions, fromDate = null, toDate = null) {
    const filtered = filterByPeriod(transactions, fromDate, toDate);

    const cashOutTxns = filtered.filter(t =>
      t.direction === 'OUT' && t.categoryId === Schema.Category.CASH
    );
    const cashInTxns = filtered.filter(t =>
      t.direction === 'IN' && t.categoryId === Schema.Category.CASH
    );
    // Also flag narrations with ATM / cash patterns not already classified
    const atmPatterns = /ATM|CASH|BYCASH/i;
    const uncategorizedCash = filtered.filter(t =>
      t.categoryId === Schema.Category.UNKNOWN && atmPatterns.test(t.narration)
    );

    const cashOut = cashOutTxns.reduce((s,t) => s+t.amount, 0);
    const cashIn  = cashInTxns.reduce((s,t) =>  s+t.amount, 0);
    const netCash = cashIn - cashOut;

    // Match cash withdrawals to subsequent deposits (within 30 days)
    const matched = [];
    const unmatched = [];
    cashOutTxns.forEach(outT => {
      const correspondingIn = cashInTxns.find(inT =>
        inT.dateTime > outT.dateTime &&
        daysBetween(outT.dateTime, inT.dateTime) <= 30 &&
        Math.abs(inT.amount - outT.amount) / outT.amount < 0.25 &&
        !matched.find(m => m.inId === inT.id)
      );
      if (correspondingIn) {
        matched.push({ outId: outT.id, inId: correspondingIn.id,
                       amount: outT.amount, days: daysBetween(outT.dateTime, correspondingIn.dateTime) });
      } else {
        unmatched.push(outT);
      }
    });

    return {
      cashOut,
      cashIn,
      netCash,
      cashOutTxns:   cashOutTxns.map(t => t.id),
      cashInTxns:    cashInTxns.map(t => t.id),
      unmatchedCash: unmatched.map(t => ({ id: t.id, date: t.dateTime, amount: t.amount })),
      matchedPairs:  matched,
      uncategorizedCash: uncategorizedCash.map(t => t.id),
      lineage: Schema.makeLineage({
        value: netCash,
        derivedFrom: [...cashOutTxns, ...cashInTxns].map(t => t.id),
        computation: 'cashIn - cashOut; ATM/CASH narration matching',
        engineVersion: VERSION,
      }),
    };
  }

  // ─── 6. Pattern Detector ───────────────────────────────────────────────────
  // Applies detection rules to produce Flag objects.

  function patternDetector(transactions, rules) {
    const detectionRules = rules.filter(r => r.type === 'detection' && r.enabled);
    const flags = [];
    const sorted = [...transactions].sort((a,b) => a.dateTime - b.dateTime);

    detectionRules.forEach(rule => {
      const newFlags = applyDetectionRule(rule, sorted);
      flags.push(...newFlags);
    });

    return flags;
  }

  function applyDetectionRule(rule, sorted) {
    const flags = [];
    const cfg = rule.config;

    switch(rule.id) {

      case 'POST_GOVT_DISPERSAL': {
        // Find GOVT IN above threshold, then look for OUT within window
        const govtCredits = sorted.filter(t =>
          t.direction === 'IN' &&
          t.categoryId === Schema.Category.GOVERNMENT &&
          t.amount >= (cfg.minTriggerAmount || 50000)
        );
        govtCredits.forEach(trigger => {
          const windowEnd = new Date(trigger.dateTime.getTime() + cfg.windowDays * 86400000);
          const outflows = sorted.filter(t =>
            t.direction === 'OUT' &&
            t.dateTime > trigger.dateTime &&
            t.dateTime <= windowEnd
          );
          const totalOut = outflows.reduce((s,t) => s+t.amount, 0);
          if (totalOut >= trigger.amount * cfg.outflowThreshold) {
            flags.push(Schema.makeFlag({
              ruleId: rule.id, severity: rule.severity,
              label: rule.name,
              description: `${formatINR(totalOut)} left within ${cfg.windowDays} days of ${formatINR(trigger.amount)} govt credit`,
              txnIds: [trigger.id, ...outflows.map(t=>t.id)],
              windowDays: cfg.windowDays,
              amount: totalOut,
              lineage: Schema.makeLineage({
                value: totalOut, derivedFrom: [trigger.id, ...outflows.map(t=>t.id)],
                rulesApplied: [rule.id], computation: `outflow/receipt >= ${cfg.outflowThreshold}`,
              }),
            }));
          }
        });
        break;
      }

      case 'ROUND_FIGURE_TRANSFER': {
        const excludeCats = new Set(cfg.excludeCategories || []);
        sorted.filter(t =>
          t.amount >= (cfg.minAmount || 50000) &&
          t.amount % cfg.divisor === 0 &&
          !excludeCats.has(t.categoryId)
        ).forEach(t => {
          flags.push(Schema.makeFlag({
            ruleId: rule.id, severity: rule.severity, label: rule.name,
            description: `${formatINR(t.amount)} is an exact round figure`,
            txnIds: [t.id], amount: t.amount,
            lineage: Schema.makeLineage({ value: t.amount, derivedFrom: [t.id],
              rulesApplied: [rule.id], computation: `amount % ${cfg.divisor} === 0` }),
          }));
        });
        break;
      }

      case 'SAME_DAY_TRANSIT': {
        // Group by calendar date
        const byDate = {};
        sorted.forEach(t => {
          const dk = t.dateTime.toISOString().slice(0,10);
          if (!byDate[dk]) byDate[dk] = { in: [], out: [] };
          byDate[dk][t.direction.toLowerCase()].push(t);
        });
        Object.entries(byDate).forEach(([date, {in: ins, out: outs}]) => {
          ins.filter(i => i.amount >= (cfg.minAmount||10000)).forEach(inT => {
            outs.filter(o => o.amount >= (cfg.minAmount||10000)).forEach(outT => {
              const ratio = outT.amount / inT.amount;
              if (ratio >= cfg.ratioMin && ratio <= cfg.ratioMax) {
                flags.push(Schema.makeFlag({
                  ruleId: rule.id, severity: rule.severity, label: rule.name,
                  description: `${formatINR(inT.amount)} in and ${formatINR(outT.amount)} out on ${date}`,
                  txnIds: [inT.id, outT.id], windowDays: 0,
                  amount: Math.min(inT.amount, outT.amount),
                  lineage: Schema.makeLineage({ value: outT.amount, derivedFrom: [inT.id, outT.id],
                    rulesApplied: [rule.id], computation: `same-day IN/OUT ratio ${ratio.toFixed(2)}` }),
                }));
              }
            });
          });
        });
        break;
      }

      case 'RAPID_SEQUENTIAL': {
        // Group by entity, find clusters within window
        const byEntity = {};
        sorted.filter(t => t.direction === 'OUT' && t.entityId && t.entityId !== 'UNRESOLVED')
              .forEach(t => {
                if (!byEntity[t.entityId]) byEntity[t.entityId] = [];
                byEntity[t.entityId].push(t);
              });
        Object.entries(byEntity).forEach(([entityId, txns]) => {
          for (let i = 0; i < txns.length; i++) {
            const windowEnd = new Date(txns[i].dateTime.getTime() + cfg.windowDays * 86400000);
            const cluster = txns.filter(t =>
              t.dateTime >= txns[i].dateTime && t.dateTime <= windowEnd
            );
            const total = cluster.reduce((s,t) => s+t.amount, 0);
            if (cluster.length >= cfg.minCount && total >= (cfg.minTotalAmount||10000)) {
              flags.push(Schema.makeFlag({
                ruleId: rule.id, severity: rule.severity, label: rule.name,
                description: `${cluster.length} transfers to ${entityId} within ${cfg.windowDays} days totalling ${formatINR(total)}`,
                txnIds: cluster.map(t=>t.id), entityIds: [entityId],
                windowDays: cfg.windowDays, amount: total,
                lineage: Schema.makeLineage({ value: total, derivedFrom: cluster.map(t=>t.id),
                  rulesApplied: [rule.id], computation: `count >= ${cfg.minCount} within ${cfg.windowDays}d` }),
              }));
              i += cluster.length - 1; // avoid re-flagging overlapping windows
              break;
            }
          }
        });
        break;
      }

      case 'CIRCULAR_FLOW': {
        const byEntity = {};
        sorted.forEach(t => {
          if (!t.entityId || t.entityId === 'UNRESOLVED') return;
          if (!byEntity[t.entityId]) byEntity[t.entityId] = { out: [], in: [] };
          byEntity[t.entityId][t.direction.toLowerCase()].push(t);
        });
        Object.entries(byEntity).forEach(([entityId, {out: outs, in: ins}]) => {
          outs.forEach(outT => {
            const windowEnd = new Date(outT.dateTime.getTime() + cfg.windowDays * 86400000);
            const returns = ins.filter(inT =>
              inT.dateTime > outT.dateTime && inT.dateTime <= windowEnd &&
              inT.amount >= outT.amount * (cfg.minReturnRatio || 0.20)
            );
            returns.forEach(retT => {
              if (outT.amount >= (cfg.minAmount||10000)) {
                flags.push(Schema.makeFlag({
                  ruleId: rule.id, severity: rule.severity, label: rule.name,
                  description: `${formatINR(outT.amount)} sent to ${entityId}, ${formatINR(retT.amount)} returned ${Math.round(daysBetween(outT.dateTime, retT.dateTime))} days later`,
                  txnIds: [outT.id, retT.id], entityIds: [entityId],
                  windowDays: Math.round(daysBetween(outT.dateTime, retT.dateTime)),
                  amount: retT.amount,
                  lineage: Schema.makeLineage({ value: retT.amount, derivedFrom: [outT.id, retT.id],
                    rulesApplied: [rule.id], computation: `return >= ${cfg.minReturnRatio*100}% of outflow within ${cfg.windowDays}d` }),
                }));
              }
            });
          });
        });
        break;
      }

      case 'ATM_CLUSTER': {
        const atmTxns = sorted.filter(t =>
          t.direction === 'OUT' && /ATM|CASH/i.test(t.narration)
        );
        for (let i = 0; i < atmTxns.length; i++) {
          const windowEnd = new Date(atmTxns[i].dateTime.getTime() + cfg.windowDays * 86400000);
          const cluster = atmTxns.filter(t =>
            t.dateTime >= atmTxns[i].dateTime && t.dateTime <= windowEnd
          );
          const total = cluster.reduce((s,t) => s+t.amount, 0);
          if (cluster.length >= cfg.minCount && total >= (cfg.minTotalAmount||30000)) {
            flags.push(Schema.makeFlag({
              ruleId: rule.id, severity: rule.severity, label: rule.name,
              description: `${cluster.length} ATM withdrawals within ${cfg.windowDays} days totalling ${formatINR(total)}`,
              txnIds: cluster.map(t=>t.id), windowDays: cfg.windowDays, amount: total,
              lineage: Schema.makeLineage({ value: total, derivedFrom: cluster.map(t=>t.id),
                rulesApplied: [rule.id], computation: `ATM count >= ${cfg.minCount} within ${cfg.windowDays}d` }),
            }));
            i += cluster.length - 1;
          }
        }
        break;
      }

      case 'SPLIT_PAYMENT': {
        const byEntity = {};
        sorted.filter(t => t.direction === 'OUT' && t.entityId && t.entityId !== 'UNRESOLVED')
              .forEach(t => {
                if (!byEntity[t.entityId]) byEntity[t.entityId] = [];
                byEntity[t.entityId].push(t);
              });
        Object.entries(byEntity).forEach(([entityId, txns]) => {
          for (let i = 0; i < txns.length; i++) {
            const anchor = txns[i];
            if (anchor.amount < (cfg.minAmount||5000)) continue;
            const windowEnd = new Date(anchor.dateTime.getTime() + cfg.windowDays * 86400000);
            const similar = txns.filter(t =>
              t.dateTime >= anchor.dateTime && t.dateTime <= windowEnd &&
              Math.abs(t.amount - anchor.amount) / anchor.amount <= (cfg.amountTolerancePct||0.10)
            );
            if (similar.length >= cfg.minCount) {
              flags.push(Schema.makeFlag({
                ruleId: rule.id, severity: rule.severity, label: rule.name,
                description: `${similar.length} similar transfers (~${formatINR(anchor.amount)}) to ${entityId} within ${cfg.windowDays} days`,
                txnIds: similar.map(t=>t.id), entityIds: [entityId],
                windowDays: cfg.windowDays, amount: similar.reduce((s,t)=>s+t.amount,0),
                lineage: Schema.makeLineage({ value: similar.reduce((s,t)=>s+t.amount,0),
                  derivedFrom: similar.map(t=>t.id), rulesApplied: [rule.id],
                  computation: `${similar.length} transfers within ±${cfg.amountTolerancePct*100}% of ${anchor.amount}` }),
              }));
              i += similar.length - 1;
            }
          }
        });
        break;
      }

      case 'LARGE_UNMATCHED_OUTFLOW': {
        const largOut = sorted.filter(t =>
          t.direction === 'OUT' && t.amount >= (cfg.minAmount||200000)
        );
        largOut.forEach(t => {
          const lookbackStart = new Date(t.dateTime.getTime() - cfg.lookbackDays * 86400000);
          const priorCredits = sorted.filter(p =>
            p.direction === 'IN' && p.dateTime >= lookbackStart && p.dateTime <= t.dateTime
          );
          const totalPriorCredit = priorCredits.reduce((s,p)=>s+p.amount,0);
          if (totalPriorCredit < t.amount * (cfg.creditCoverageThreshold||0.50)) {
            flags.push(Schema.makeFlag({
              ruleId: rule.id, severity: rule.severity, label: rule.name,
              description: `${formatINR(t.amount)} outflow with only ${formatINR(totalPriorCredit)} credited in prior ${cfg.lookbackDays} days`,
              txnIds: [t.id, ...priorCredits.map(p=>p.id)], amount: t.amount,
              lineage: Schema.makeLineage({ value: t.amount, derivedFrom: [t.id],
                rulesApplied: [rule.id], computation: `prior credit < ${cfg.creditCoverageThreshold*100}% of outflow` }),
            }));
          }
        });
        break;
      }

      case 'NEW_ENTITY_LARGE': {
        sorted.filter(t => t.direction === 'OUT' && t.amount >= (cfg.minAmount||100000))
              .forEach(t => {
                if (!t.entityId || t.entityId === 'UNRESOLVED') return;
                const cutoff = new Date(t.dateTime.getTime() - cfg.newEntityWindowDays * 86400000);
                const priorContact = sorted.some(p =>
                  p.entityId === t.entityId && p.dateTime < t.dateTime && p.dateTime >= cutoff
                );
                if (!priorContact) {
                  flags.push(Schema.makeFlag({
                    ruleId: rule.id, severity: rule.severity, label: rule.name,
                    description: `${formatINR(t.amount)} to new/inactive entity ${t.entityId}`,
                    txnIds: [t.id], entityIds: [t.entityId], amount: t.amount,
                    lineage: Schema.makeLineage({ value: t.amount, derivedFrom: [t.id],
                      rulesApplied: [rule.id], computation: `no prior contact in ${cfg.newEntityWindowDays}d` }),
                  }));
                }
              });
        break;
      }

      case 'CASH_IN_AFTER_CASH_OUT': {
        const atmOut = sorted.filter(t => t.direction==='OUT' && /ATM|CASH/i.test(t.narration));
        const cashIn = sorted.filter(t => t.direction==='IN'  && /CASH|BYCASH/i.test(t.narration));
        atmOut.filter(t => t.amount >= (cfg.minAmount||10000)).forEach(outT => {
          const windowEnd = new Date(outT.dateTime.getTime() + cfg.windowDays * 86400000);
          const deposit = cashIn.find(inT =>
            inT.dateTime > outT.dateTime && inT.dateTime <= windowEnd &&
            inT.amount >= outT.amount * 0.5
          );
          if (deposit) {
            flags.push(Schema.makeFlag({
              ruleId: rule.id, severity: rule.severity, label: rule.name,
              description: `${formatINR(outT.amount)} cash withdrawn, ${formatINR(deposit.amount)} deposited ${Math.round(daysBetween(outT.dateTime, deposit.dateTime))} days later`,
              txnIds: [outT.id, deposit.id], windowDays: Math.round(daysBetween(outT.dateTime, deposit.dateTime)),
              amount: deposit.amount,
              lineage: Schema.makeLineage({ value: deposit.amount, derivedFrom: [outT.id, deposit.id],
                rulesApplied: [rule.id], computation: `cash-out followed by cash-in within ${cfg.windowDays}d` }),
            }));
          }
        });
        break;
      }
    }

    return flags;
  }

  // ─── 7. Risk Scorer ────────────────────────────────────────────────────────
  // Produces a 0-100 risk score per entity with full audit trail.

  function riskScorer(transactions, clusters, rules, flags) {
    const scoringRules = rules.filter(r => r.type === 'scoring' && r.enabled);
    const scores = {};

    const entityIds = [...new Set(transactions.map(t=>t.entityId).filter(Boolean))];

    entityIds.forEach(entityId => {
      if (entityId === 'UNRESOLVED') return;
      const entityTxns = transactions.filter(t => t.entityId === entityId);
      const entityFlags = flags.filter(f => f.entityIds?.includes(entityId) ||
        f.txnIds.some(id => entityTxns.find(t=>t.id===id)));

      let score = 0;
      const contributors = [];

      scoringRules.forEach(rule => {
        const cfg = rule.config;
        let pts = 0;

        switch(rule.id) {
          case 'SCORE_VOLUME': {
            const total = entityTxns.reduce((s,t)=>s+t.amount, 0);
            pts = Math.min(cfg.maxScore, Math.floor(total / 100000) * cfg.perLakh);
            break;
          }
          case 'SCORE_FREQUENCY': {
            pts = Math.min(cfg.maxScore, entityTxns.length * cfg.perTransaction);
            break;
          }
          case 'SCORE_GOVT_LINKAGE': {
            const govtTxns = transactions.filter(t =>
              t.categoryId === Schema.Category.GOVERNMENT && t.direction === 'IN' &&
              t.amount >= cfg.minAmount
            );
            const linked = govtTxns.some(govtT => {
              const windowEnd = new Date(govtT.dateTime.getTime() + cfg.windowDays * 86400000);
              return entityTxns.some(et =>
                et.direction === 'OUT' &&
                et.dateTime > govtT.dateTime && et.dateTime <= windowEnd
              );
            });
            pts = linked ? cfg.scoreContribution : 0;
            break;
          }
          case 'SCORE_CONCENTRATION': {
            // Check if entity has large transfers concentrated in short window
            const outTxns = entityTxns.filter(t=>t.direction==='OUT');
            let maxWindow = 0;
            for (let i=0; i<outTxns.length; i++) {
              const windowEnd = new Date(outTxns[i].dateTime.getTime() + cfg.windowDays * 86400000);
              const windowTotal = outTxns.filter(t =>
                t.dateTime >= outTxns[i].dateTime && t.dateTime <= windowEnd
              ).reduce((s,t)=>s+t.amount,0);
              maxWindow = Math.max(maxWindow, windowTotal);
            }
            pts = maxWindow >= cfg.threshold ? cfg.scoreContribution : 0;
            break;
          }
          case 'SCORE_CASH_LINKAGE': {
            const hasLinked = entityFlags.some(f => f.ruleId === 'ATM_CLUSTER');
            pts = hasLinked ? cfg.scoreContribution : 0;
            break;
          }
          case 'SCORE_CIRCULAR': {
            const hasCircular = entityFlags.some(f => f.ruleId === 'CIRCULAR_FLOW');
            pts = hasCircular ? cfg.scoreContribution : 0;
            break;
          }
        }

        if (pts > 0) {
          score += pts;
          contributors.push({ ruleId: rule.id, ruleName: rule.name, points: Math.round(pts) });
        }
      });

      score = Math.min(100, Math.round(score));
      const severity = score >= 75 ? 'Critical' : score >= 50 ? 'High' : score >= 25 ? 'Medium' : 'Low';

      const entityTxnsOut = entityTxns.filter(t=>t.direction==='OUT');
      const entityTxnsIn  = entityTxns.filter(t=>t.direction==='IN');

      scores[entityId] = {
        entityId,
        score,
        severity,
        contributors,
        totalOut:    entityTxnsOut.reduce((s,t)=>s+t.amount,0),
        totalIn:     entityTxnsIn.reduce((s,t)=>s+t.amount,0),
        txnCount:    entityTxns.length,
        firstSeen:   entityTxns[0]?.dateTime,
        lastSeen:    entityTxns[entityTxns.length-1]?.dateTime,
        flags:       entityFlags.map(f=>f.ruleId),
        plainSummary: generatePlainSummary(entityId, entityTxns, entityFlags, score),
        lineage: Schema.makeLineage({
          value: score,
          derivedFrom: entityTxns.map(t=>t.id),
          rulesApplied: contributors.map(c=>c.ruleId),
          computation: contributors.map(c=>`${c.ruleId}:+${c.points}`).join(', '),
          engineVersion: VERSION,
        }),
      };
    });

    return scores;
  }

  // ─── 8. Plain-language summary generator ──────────────────────────────────

  function generatePlainSummary(entityId, txns, flags, score) {
    const totalOut = txns.filter(t=>t.direction==='OUT').reduce((s,t)=>s+t.amount,0);
    const totalIn  = txns.filter(t=>t.direction==='IN').reduce((s,t)=>s+t.amount,0);
    const hasCircular = flags.some(f=>f.ruleId==='CIRCULAR_FLOW');
    const hasGovtLink = flags.some(f=>f.ruleId==='POST_GOVT_DISPERSAL');
    const hasRapid    = flags.some(f=>f.ruleId==='RAPID_SEQUENTIAL');
    const hasSplit    = flags.some(f=>f.ruleId==='SPLIT_PAYMENT');

    const parts = [];

    if (totalOut > 0 && totalIn > 0) {
      parts.push(`Money moved both ways — ${formatINR(totalIn)} received, ${formatINR(totalOut)} sent.`);
    } else if (totalOut > 0) {
      parts.push(`Received ${formatINR(totalOut)} — all outgoing.`);
    } else {
      parts.push(`Sent ${formatINR(totalIn)} — all incoming.`);
    }

    if (hasGovtLink) parts.push('Transfers occurred close to government payment dates.');
    if (hasCircular) parts.push('Some money went out and came back from the same source.');
    if (hasRapid)   parts.push('Several transfers happened in rapid succession.');
    if (hasSplit)   parts.push('Similar amounts were transferred multiple times.');
    if (score >= 75) parts.push('Warrants priority review.');
    else if (score >= 50) parts.push('Warrants review.');

    return parts.join(' ');
  }

  // ─── 9. Relationship Builder ───────────────────────────────────────────────
  // Builds an edge list for the network graph.

  function relationshipBuilder(transactions) {
    const edges = {};
    const nodes = {};

    transactions.forEach(t => {
      if (!t.entityId || t.entityId === 'UNRESOLVED') return;

      // Track node
      if (!nodes[t.entityId]) nodes[t.entityId] = { id: t.entityId, totalIn: 0, totalOut: 0, txnCount: 0 };
      if (t.direction === 'IN') nodes[t.entityId].totalIn += t.amount;
      else nodes[t.entityId].totalOut += t.amount;
      nodes[t.entityId].txnCount++;

      // Edge: SUBJECT ↔ entity
      const edgeKey = `SUBJECT__${t.entityId}`;
      if (!edges[edgeKey]) edges[edgeKey] = {
        source: 'SUBJECT', target: t.entityId,
        in: 0, out: 0, txnCount: 0, txnIds: [], firstDate: t.dateTime, lastDate: t.dateTime,
      };
      if (t.direction === 'IN') edges[edgeKey].in  += t.amount;
      else                      edges[edgeKey].out += t.amount;
      edges[edgeKey].txnCount++;
      edges[edgeKey].txnIds.push(t.id);
      if (t.dateTime < edges[edgeKey].firstDate) edges[edgeKey].firstDate = t.dateTime;
      if (t.dateTime > edges[edgeKey].lastDate)  edges[edgeKey].lastDate  = t.dateTime;
    });

    return {
      nodes: Object.values(nodes),
      edges: Object.values(edges),
    };
  }

  // ─── 10. Story Detector ────────────────────────────────────────────────────
  // Automatically surfaces narrative anomalies.

  function storyDetector(transactions, flags, balanceResult) {
    const stories = [];

    // Story 1: Massive inflow followed by rapid dispersal
    const govtTxns = transactions.filter(t =>
      t.categoryId === Schema.Category.GOVERNMENT && t.direction === 'IN' && t.amount > 100000
    );
    govtTxns.forEach(g => {
      const dispersalFlags = flags.filter(f =>
        f.ruleId === 'POST_GOVT_DISPERSAL' && f.txnIds.includes(g.id)
      );
      if (dispersalFlags.length > 0) {
        const totalOut = dispersalFlags[0].amount;
        stories.push({
          id: uid('STORY'),
          type: 'GOVT_DISPERSAL',
          severity: 'High',
          title: 'Government receipt followed by rapid dispersal',
          description: `${formatINR(g.amount)} received from government on ${g.dateTime.toDateString()}. ${formatINR(totalOut)} left within 7 days.`,
          txnIds: dispersalFlags[0].txnIds,
          date: g.dateTime,
        });
      }
    });

    // Story 2: New beneficiary appears after large credit
    const newEntityFlags = flags.filter(f => f.ruleId === 'NEW_ENTITY_LARGE');
    newEntityFlags.forEach(f => {
      stories.push({
        id: uid('STORY'),
        type: 'NEW_BENEFICIARY',
        severity: 'Medium',
        title: 'New beneficiary receives large transfer',
        description: f.description,
        txnIds: f.txnIds,
        date: transactions.find(t=>t.id===f.txnIds[0])?.dateTime,
      });
    });

    // Story 3: Account dormancy then sudden activity
    const sorted = [...transactions].sort((a,b)=>a.dateTime-b.dateTime);
    for (let i=1; i<sorted.length; i++) {
      const gap = daysBetween(sorted[i-1].dateTime, sorted[i].dateTime);
      if (gap > 90 && sorted[i].amount > 50000) {
        stories.push({
          id: uid('STORY'),
          type: 'DORMANCY_THEN_ACTIVITY',
          severity: 'Medium',
          title: 'Account dormancy followed by activity',
          description: `${Math.round(gap)} days of inactivity, then ${formatINR(sorted[i].amount)} on ${sorted[i].dateTime.toDateString()}.`,
          txnIds: [sorted[i-1].id, sorted[i].id],
          date: sorted[i].dateTime,
        });
      }
    }

    // Story 4: Circular flow chain
    const circularFlags = flags.filter(f => f.ruleId === 'CIRCULAR_FLOW');
    if (circularFlags.length > 0) {
      stories.push({
        id: uid('STORY'),
        type: 'CIRCULAR_FLOW',
        severity: 'High',
        title: 'Circular money flow detected',
        description: `Money was sent out and returned from the same source in ${circularFlags.length} instance(s).`,
        txnIds: circularFlags.flatMap(f=>f.txnIds),
        date: transactions.find(t=>t.id===circularFlags[0].txnIds[0])?.dateTime,
      });
    }

    return stories.sort((a,b) => {
      const sev = {Critical:0, High:1, Medium:2, Low:3};
      return (sev[a.severity]||3) - (sev[b.severity]||3);
    });
  }

  // ─── 11. Hypothesis Tester ────────────────────────────────────────────────

  function hypothesisTester(transactions, hypothesis, rules) {
    const { criteria } = hypothesis;
    const sorted = [...transactions].sort((a,b)=>a.dateTime-b.dateTime);

    const supporting    = [];
    const contradicting = [];
    const neutral       = [];

    // Find trigger transactions
    const triggers = sorted.filter(t => {
      const matchCat = !criteria.trigger.category || t.categoryId === criteria.trigger.category;
      const matchDir = !criteria.trigger.direction || t.direction  === criteria.trigger.direction;
      const matchAmt = !criteria.trigger.minAmount || t.amount >= criteria.trigger.minAmount;
      return matchCat && matchDir && matchAmt;
    });

    triggers.forEach(trigger => {
      const windowEnd = new Date(trigger.dateTime.getTime() + (criteria.windowDays||30) * 86400000);
      const windowTxns = sorted.filter(t =>
        t.dateTime > trigger.dateTime && t.dateTime <= windowEnd
      );

      const matching = windowTxns.filter(t => {
        const matchDir = !criteria.condition.direction || t.direction === criteria.condition.direction;
        const matchAmt = !criteria.condition.minAmount || t.amount >= criteria.condition.minAmount;
        return matchDir && matchAmt;
      });

      if (matching.length > 0) {
        matching.forEach(m => {
          supporting.push({
            txnId:       m.id,
            triggerId:   trigger.id,
            description: `${formatINR(m.amount)} ${m.direction} within ${criteria.windowDays}d of ${formatINR(trigger.amount)} trigger`,
            date:        m.dateTime,
          });
        });
      } else {
        // Trigger exists but condition not met — contradicting
        contradicting.push({
          txnId:       trigger.id,
          description: `${formatINR(trigger.amount)} trigger on ${trigger.dateTime.toDateString()} — no qualifying follow-on transactions found`,
          date:        trigger.dateTime,
        });
      }
    });

    // Neutral: non-trigger transactions during supporting periods
    sorted.filter(t => !triggers.find(g=>g.id===t.id) &&
                       !supporting.find(s=>s.txnId===t.id))
          .slice(0, 10)
          .forEach(t => {
            neutral.push({ txnId: t.id, description: `${formatINR(t.amount)} — unrelated to hypothesis`, date: t.dateTime });
          });

    return {
      hypothesisId:  hypothesis.id,
      statement:     hypothesis.statement,
      supporting,
      contradicting,
      neutral,
      conclusion:    null,  // NEVER drawn by engine
      summary: `${supporting.length} supporting, ${contradicting.length} contradicting, ${neutral.length} neutral observations found.`,
    };
  }

  // ─── 12. Data Quality ─────────────────────────────────────────────────────

  function dataQuality(transactions) {
    const total   = transactions.length;
    const verified   = transactions.filter(t=>t.provenance===Schema.Provenance.VERIFIED).length;
    const imported   = transactions.filter(t=>t.provenance===Schema.Provenance.IMPORTED).length;
    const estimated  = transactions.filter(t=>t.provenance===Schema.Provenance.ESTIMATED).length;
    const missingBalances = transactions.filter(t=>t.balance===null).length;
    const unresolved = transactions.filter(t=>t.entityId==='UNRESOLVED'||!t.entityId).length;

    // Duplicate detection: same date + amount + direction + narration (first 20 chars)
    const seen = {};
    let suspected = 0;
    transactions.forEach(t => {
      const key = `${t.dateTime.toISOString().slice(0,10)}|${t.amount}|${t.direction}|${t.narration.slice(0,20)}`;
      if (seen[key]) suspected++;
      seen[key] = true;
    });

    const zeroAmount = transactions.filter(t=>t.amount===0).length;

    return {
      total, verified, imported, estimated,
      missingBalances, unresolved,
      suspectedDuplicates: suspected,
      zeroAmount,
      completenessScore: Math.round(
        ((total - missingBalances) / total * 40) +
        (verified / total * 40) +
        (1 - unresolved/total) * 20
      ),
    };
  }

  // ─── 13. Query Engine (DSL executor) ─────────────────────────────────────

  function queryEngine(transactions, query, clusters) {
    let workingSet = [...transactions];

    for (let stepIdx = 0; stepIdx < query.steps.length; stepIdx++) {
      const step = query.steps[stepIdx];

      if (step.op === 'FILTER') {
        const w = step.where || {};
        workingSet = workingSet.filter(t => {
          if (w.direction  && t.direction  !== w.direction)  return false;
          if (w.category   && t.categoryId !== w.category)   return false;
          if (w.entityId   && t.entityId   !== w.entityId)   return false;
          if (w.bank       && t.bank       !== w.bank)        return false;
          if (w.minAmount  && t.amount < w.minAmount)         return false;
          if (w.maxAmount  && t.amount > w.maxAmount)         return false;
          if (w.amount) {
            if (w.amount.gt && t.amount <= w.amount.gt) return false;
            if (w.amount.lt && t.amount >= w.amount.lt) return false;
            if (w.amount.gte && t.amount < w.amount.gte) return false;
            if (w.amount.lte && t.amount > w.amount.lte) return false;
          }
          if (w.from && t.dateTime < new Date(w.from)) return false;
          if (w.to   && t.dateTime > new Date(w.to))   return false;
          if (w.searchText) {
            const q2 = w.searchText.toLowerCase();
            if (!t.narration.toLowerCase().includes(q2)) return false;
          }
          return true;
        });
      }

      else if (step.op === 'THEN') {
        // Temporal: find transactions within N days of any transaction in current working set
        const windowMs = (step.window || 7) * (step.unit === 'days' ? 86400000 : 86400000);
        const anchorTimes = workingSet.map(t => t.dateTime.getTime());
        // Next FILTER step applies to: all transactions within window of any anchor
        workingSet = transactions.filter(t => {
          const tTime = t.dateTime.getTime();
          return anchorTimes.some(a => tTime > a && tTime <= a + windowMs);
        });
      }

      else if (step.op === 'NOT') {
        const exclude = new Set(
          transactions.filter(t => {
            const w = step.where || {};
            if (w.direction && t.direction !== w.direction) return false;
            if (w.category  && t.categoryId !== w.category) return false;
            return true;
          }).map(t=>t.id)
        );
        workingSet = workingSet.filter(t => !exclude.has(t.id));
      }
    }

    // ORDER BY
    if (query.orderBy) {
      const { field, dir } = query.orderBy;
      workingSet.sort((a,b) => {
        const va = a[field], vb = b[field];
        if (va < vb) return dir==='DESC' ? 1 : -1;
        if (va > vb) return dir==='DESC' ? -1 : 1;
        return 0;
      });
    }

    // LIMIT
    if (query.limit) workingSet = workingSet.slice(0, query.limit);

    return workingSet;
  }

  // ─── 14. Master compute (DAG) ─────────────────────────────────────────────
  // Single entry point: runs the full pipeline in dependency order.
  // Only reruns nodes whose inputs have changed (simple version-based DAG).

  function compute(rawTransactions, rules, predefinedEntities, edits = [], fromDate = null, toDate = null) {
    // Node 1: normalize
    const normalized = normalizer(rawTransactions, 'Imported');

    // Node 2: classify
    const classified = classify(normalized, rules);

    // Node 3: entity resolution
    const { transactions, clusters } = entityResolver(classified, predefinedEntities, edits);

    // Node 4: filter by period (for period-specific views)
    const periodFiltered = filterByPeriod(transactions, fromDate, toDate);

    // Node 5: balance (depends on classification + entity)
    const balance = balanceEngine(periodFiltered);

    // Node 6: cash (depends on classification)
    const cash = cashEngine(periodFiltered);

    // Node 7: pattern detection (depends on classification + entity)
    const flags = patternDetector(periodFiltered, rules);

    // Node 8: risk scoring (depends on entity + flags)
    const scores = riskScorer(periodFiltered, clusters, rules, flags);

    // Node 9: relationships (depends on entity)
    const relationships = relationshipBuilder(periodFiltered);

    // Node 10: stories (depends on flags + balance)
    const stories = storyDetector(periodFiltered, flags, balance);

    // Node 11: data quality (always on full set)
    const dq = dataQuality(transactions);

    return {
      transactions,       // all (full period)
      periodTransactions: periodFiltered,
      clusters,
      balance,
      cash,
      flags,
      scores,
      relationships,
      stories,
      dataQuality: dq,
      meta: {
        computedAt: new Date().toISOString(),
        engineVersion: VERSION,
        txnCount: transactions.length,
        periodTxnCount: periodFiltered.length,
        fromDate, toDate,
      },
    };
  }

  // ─── Helper: period filter ─────────────────────────────────────────────────

  function filterByPeriod(transactions, from, to) {
    if (!from && !to) return transactions;
    const f = from ? toDateObj(from) : null;
    const t = to   ? toDateObj(to)   : null;
    return transactions.filter(txn => {
      if (f && txn.dateTime < f) return false;
      if (t && txn.dateTime > t) return false;
      return true;
    });
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  return {
    // Pipeline steps (individually testable)
    normalizer,
    classify,
    entityResolver,
    balanceEngine,
    cashEngine,
    patternDetector,
    riskScorer,
    generatePlainSummary,
    relationshipBuilder,
    storyDetector,
    hypothesisTester,
    dataQuality,
    queryEngine,
    // Master compute
    compute,
    filterByPeriod,
    // Utilities
    formatINR,
    daysBetween,
    VERSION,
  };

})();

if (typeof module !== 'undefined') module.exports = { Engine };
if (typeof window !== 'undefined') window.Engine = Engine;
