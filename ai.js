/**
 * ai.js
 * Gemini AI integration for the Financial Investigation Platform.
 * Gemini ONLY explains, summarizes, and translates natural language.
 * Gemini NEVER computes, alters data, or draws conclusions.
 *
 * All financial calculations remain in engine.js.
 * All data displayed is computed by JS before Gemini sees it.
 *
 * Version: 1.0.0
 */

'use strict';

const AI = (() => {

  const MODEL = 'claude-sonnet-4-6';
  const API_URL = 'https://api.anthropic.com/v1/messages';

  // System prompt enforces evidence-only framing
  const SYSTEM_PROMPT = `You are a financial investigation assistant working with verified bank transaction data.

Your role:
- Describe patterns, timing correlations, and sequences visible in the data
- Flag what an investigator should examine further
- Present evidence neutrally — never assume wrongdoing
- Use precise language: "data shows", "records indicate", "this pattern may warrant review"
- Never say "fraud", "theft", "laundering", or "misappropriation" — those are legal conclusions
- Never compute totals or averages yourself — use only the figures provided
- Keep responses concise and structured for investigative use

When describing money flows:
- Note amounts, dates, and counterparty names exactly as provided
- Describe timing relationships precisely ("5 days after", "same day as")
- Flag unusual patterns without characterizing intent
- Always note what data is NOT available (estimated vs verified)`;

  // ── Core API call ─────────────────────────────────────────────────────────────

  async function call(userMessage, context = '') {
    const key = State.geminiKey;
    if (!key) throw new Error('No API key. Enter your Anthropic API key in the AI panel.');

    const messages = [];
    if (context) messages.push({ role: 'user', content: context });
    if (context) messages.push({ role: 'assistant', content: 'Understood. I have the transaction data.' });
    messages.push({ role: 'user', content: userMessage });

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `API error ${response.status}`);
    }

    const data = await response.json();
    return data.content?.[0]?.text || '(No response)';
  }

  // ── Context builders ──────────────────────────────────────────────────────────

  function buildPeriodContext(computed) {
    const { balance, cash, flags, stories, dataQuality } = computed;
    const filter = computed.activeFilter || {};

    const topEntities = Object.values(computed.scores || {})
      .sort((a,b) => b.score - a.score)
      .slice(0, 5)
      .map(e => `${e.entityId}: OUT=${fmt(e.totalOut)} IN=${fmt(e.totalIn)} txns=${e.txnCount} risk=${e.score}/${e.severity}`);

    const flagSummary = {};
    (flags || []).forEach(f => { flagSummary[f.ruleId] = (flagSummary[f.ruleId] || 0) + 1; });

    return `TRANSACTION DATA SUMMARY
Period: ${filter.from || 'all time'} to ${filter.to || 'present'}
Total transactions: ${computed.displayTransactions?.length || 0}
Data quality: Verified=${dataQuality?.verified || 0} Imported=${dataQuality?.imported || 0}

FINANCIAL SUMMARY
Total IN:  ${fmt(balance.totalIn)}
Total OUT: ${fmt(balance.totalOut)}
Net flow:  ${fmt(balance.netFlow)}
Cash (ATM/withdrawn): ${fmt(cash?.cashOut || 0)}
Unmatched cash outflows: ${cash?.unmatchedCash?.length || 0}

TOP ENTITIES BY RISK
${topEntities.join('\n') || 'None'}

PATTERN FLAGS DETECTED
${Object.entries(flagSummary).map(([k,v]) => `${k}: ${v} instance(s)`).join('\n') || 'None'}

AUTO-DETECTED STORIES
${(stories || []).map(s => `[${s.severity}] ${s.title}: ${s.description}`).join('\n') || 'None'}`;
  }

  function buildEntityContext(entityId, computed) {
    const score = computed.scores?.[entityId];
    const txns  = (computed.transactions || []).filter(t => t.entityId === entityId);
    const flags  = (computed.flags || []).filter(f => f.entityIds?.includes(entityId) || f.txnIds?.some(id => txns.find(t => t.id === id)));

    if (!score) return `Entity ${entityId} not found in computed data.`;

    const sample = txns.slice(0, 20).map(t =>
      `${t.dateTime?.slice?.(0,10) || ''} ${t.direction} ${fmt(t.amount)} — ${t.narration?.slice(0,50)}`
    );

    return `ENTITY PROFILE: ${entityId}
Risk Score: ${score.score}/100 [${score.severity}]
Total OUT: ${fmt(score.totalOut)}
Total IN: ${fmt(score.totalIn)}
Transactions: ${score.txnCount}
First seen: ${score.firstSeen?.toISOString?.()?.slice(0,10) || 'unknown'}
Last seen:  ${score.lastSeen?.toISOString?.()?.slice(0,10) || 'unknown'}
Flags: ${score.flags?.join(', ') || 'none'}

RISK CONTRIBUTORS
${score.contributors?.map(c => `${c.ruleName}: +${c.points}pts`).join('\n') || 'None'}

SAMPLE TRANSACTIONS (last 20)
${sample.join('\n')}

FLAGS ON THIS ENTITY
${flags.map(f => `[${f.severity}] ${f.ruleId}: ${f.description}`).join('\n') || 'None'}`;
  }

  // ── Translate natural language query to DSL ───────────────────────────────────

  async function translateQuery(nlQuery) {
    const key = State.geminiKey;
    if (!key) return null;

    const prompt = `Translate this investigation query into a JSON filter object.

Query: "${nlQuery}"

Available filter fields:
- from: ISO date string (e.g. "2021-01-01")
- to: ISO date string
- direction: "IN" or "OUT"
- minAmount: number in INR
- maxAmount: number in INR
- categories: array of "GOVERNMENT","FAMILY","CASH","BUSINESS","BANK","INTERNAL","UNKNOWN"
- entityIds: array of entity IDs like "NIRAJ","DHEERAJ","MANJULA_GILL","GOVT"
- searchText: string to search in narration
- flags: array of rule IDs like "POST_GOVT_DISPERSAL","ATM_CLUSTER","CIRCULAR_FLOW","ROUND_FIGURE_TRANSFER","SAME_DAY_TRANSIT","RAPID_SEQUENTIAL","SPLIT_PAYMENT"

Return ONLY a valid JSON object with only the relevant fields. Nothing else.

Examples:
"show transfers to Neeraj above 10000" → {"entityIds":["NIRAJ"],"direction":"OUT","minAmount":10000}
"government credits in 2021" → {"from":"2021-01-01","to":"2021-12-31","direction":"IN","categories":["GOVERNMENT"]}
"large cash withdrawals" → {"categories":["CASH"],"direction":"OUT","minAmount":10000}
"suspicious flags only" → {"flags":["POST_GOVT_DISPERSAL","CIRCULAR_FLOW","SAME_DAY_TRANSIT"]}`;

    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL, max_tokens: 300,
          system: 'You are a query translator. Return only valid JSON, no other text.',
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!response.ok) return null;
      const data = await response.json();
      const text = data.content?.[0]?.text || '';
      const clean = text.replace(/```json|```/g, '').trim();
      return JSON.parse(clean);
    } catch { return null; }
  }

  // ── Public investigation functions ────────────────────────────────────────────

  async function explainPeriod(computed) {
    const context = buildPeriodContext(computed);
    return call('Describe the key patterns in this financial data. What should an investigator focus on? Be specific about timing, amounts, and relationships.', context);
  }

  async function explainEntity(entityId, computed) {
    const context = buildEntityContext(entityId, computed);
    return call(`Analyse the transaction pattern for ${entityId}. Describe the nature of the financial relationship, timing patterns, and what warrants closer review.`, context);
  }

  async function compareEntities(entityIdA, entityIdB, computed) {
    const contextA = buildEntityContext(entityIdA, computed);
    const contextB = buildEntityContext(entityIdB, computed);
    return call(`Compare the financial patterns of these two entities. Note similarities, differences, and whether there are timing correlations between them.\n\nEntity A:\n${contextA}\n\nEntity B:\n${contextB}`, '');
  }

  async function answerQuestion(question, computed) {
    // First try to translate to a filter
    const filter = await translateQuery(question);
    if (filter) {
      // Apply filter and report on results
      State.setFilter(filter);
      const filtered = State.computed;
      const context = buildPeriodContext(filtered);
      const result = await call(`The investigator asked: "${question}"\n\nI've filtered the data accordingly. Here is the filtered data summary:\n\n${context}\n\nPlease describe what the filtered data shows in relation to the question.`, '');
      return { filter, answer: result };
    } else {
      const context = buildPeriodContext(computed);
      const answer = await call(question, context);
      return { filter: null, answer };
    }
  }

  async function generateReport(computed) {
    const context = buildPeriodContext(computed);
    const caseInfo = State.activeCase;
    const metrics = State.getInvestigationMetrics();

    const prompt = `Generate a concise investigation summary report for case "${caseInfo?.name || 'Investigation'}".

Structure the report as:
1. SUMMARY (2-3 sentences)
2. KEY FINANCIAL OBSERVATIONS (bullet points, most significant first)
3. PATTERNS REQUIRING REVIEW (specific timing/amount observations)
4. DATA QUALITY NOTES (what is verified vs imported)
5. RECOMMENDED NEXT STEPS (3-5 specific investigative actions)

Use neutral, evidence-based language throughout. Do not draw legal conclusions.`;

    return call(prompt, context);
  }

  async function generateReplayNarration(computed) {
    // Pre-generate narration script for replay mode
    // One call — JS plays it back in sync
    const context = buildPeriodContext(computed);
    const txns = (computed.transactions || [])
      .sort((a,b) => new Date(a.dateTime) - new Date(b.dateTime))
      .filter(t => t.amount > 10000 || (computed.flags||[]).some(f => f.txnIds?.includes(t.id)))
      .slice(0, 30)
      .map(t => `${t.dateTime?.slice?.(0,10)} ${t.direction} ${fmt(t.amount)} [${t.entityId||'?'}] ${t.narration?.slice(0,40)}`);

    const prompt = `For a financial investigation replay, generate brief narration lines (max 10 words each) for these significant transactions. Return a JSON array of strings, one per transaction, in the same order.

Transactions:
${txns.join('\n')}

Return only the JSON array. Example: ["Government credit received", "Large transfer to known entity", ...]`;

    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL, max_tokens: 600,
          system: 'Return only a JSON array of strings. No other text.',
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!response.ok) return [];
      const data = await response.json();
      const text = data.content?.[0]?.text || '[]';
      return JSON.parse(text.replace(/```json|```/g,'').trim());
    } catch { return []; }
  }

  function fmt(n) {
    if (!n && n !== 0) return '—';
    if (Math.abs(n) >= 10000000) return '₹' + (n/10000000).toFixed(2) + 'Cr';
    if (Math.abs(n) >= 100000)   return '₹' + (n/100000).toFixed(2) + 'L';
    if (Math.abs(n) >= 1000)     return '₹' + (n/1000).toFixed(1) + 'K';
    return '₹' + Math.round(n).toLocaleString('en-IN');
  }

  return {
    call,
    translateQuery,
    explainPeriod,
    explainEntity,
    compareEntities,
    answerQuestion,
    generateReport,
    generateReplayNarration,
  };

})();

if (typeof window !== 'undefined') window.AI = AI;
