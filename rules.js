/**
 * rules.js
 * Configurable rule definitions for the Investigation Engine.
 * Rules are data — not code. The engine reads and applies them.
 * Each rule carries full provenance: version, author, rationale, history.
 *
 * Rule Types:
 *   detection      → find patterns → produce flags on transactions/entities
 *   classification → assign category to transactions
 *   scoring        → contribute to entity risk score
 *   narrative      → generate plain-language observations
 */

'use strict';

const DEFAULT_RULES = [

  // ─── Detection Rules ──────────────────────────────────────────────────────

  {
    id:       'POST_GOVT_DISPERSAL',
    name:     'Rapid dispersal after government credit',
    type:     'detection',
    enabled:  true,
    severity: 'High',
    description: 'Large outgoing transfers detected within N days of a government credit, '
               + 'totalling more than T% of the received amount.',
    config: {
      triggerCategory: 'GOVERNMENT',
      triggerDirection: 'IN',
      windowDays: 7,
      outflowThreshold: 0.60,   // 60% of trigger amount must leave
      minTriggerAmount: 50000,
    },
    version:   '1.0.0',
    author:    'system',
    rationale: 'Large government receipts followed by rapid dispersal may indicate '
             + 'pre-arranged distribution of compensation. Threshold set at 60% to '
             + 'exclude routine household expenditure.',
    createdAt: '2026-06-25',
    history:   [],
  },

  {
    id:       'ROUND_FIGURE_TRANSFER',
    name:     'Round figure transfer',
    type:     'detection',
    enabled:  true,
    severity: 'Medium',
    description: 'Transfer amount is an exact round figure (divisible by 50,000), '
               + 'which is atypical for organic transactions.',
    config: {
      divisor: 50000,
      minAmount: 50000,
      excludeCategories: ['BANK'],
    },
    version:   '1.0.0',
    author:    'system',
    rationale: 'Organic transactions (grocery, utility, salary) rarely produce exact '
             + 'round numbers. Round figures in large transfers suggest pre-negotiated amounts.',
    createdAt: '2026-06-25',
    history:   [],
  },

  {
    id:       'SAME_DAY_TRANSIT',
    name:     'Same-day in-and-out',
    type:     'detection',
    enabled:  true,
    severity: 'High',
    description: 'A significant credit and a comparable debit occur on the same calendar day.',
    config: {
      windowDays: 0,
      minAmount: 10000,
      ratioMin: 0.75,    // OUT is between 75% and 125% of IN
      ratioMax: 1.25,
    },
    version:   '1.0.0',
    author:    'system',
    rationale: 'Transit use of an account — money comes in and leaves the same day — '
             + 'may indicate the account is used as a pass-through rather than for '
             + 'personal financial management.',
    createdAt: '2026-06-25',
    history:   [],
  },

  {
    id:       'RAPID_SEQUENTIAL',
    name:     'Rapid sequential transfers to same entity',
    type:     'detection',
    enabled:  true,
    severity: 'Medium',
    description: 'Three or more transfers to the same entity within a short window.',
    config: {
      windowDays: 5,
      minCount: 3,
      minTotalAmount: 10000,
    },
    version:   '1.0.0',
    author:    'system',
    rationale: 'Multiple transfers to the same beneficiary in quick succession may indicate '
             + 'payment splitting (to avoid detection thresholds) or urgency-driven dispersal.',
    createdAt: '2026-06-25',
    history:   [],
  },

  {
    id:       'CIRCULAR_FLOW',
    name:     'Money returned from same entity',
    type:     'detection',
    enabled:  true,
    severity: 'High',
    description: 'Money sent OUT to an entity is partially or fully returned IN '
               + 'from the same entity within a defined window.',
    config: {
      windowDays: 180,
      minReturnRatio: 0.20,  // at least 20% came back
      minAmount: 10000,
    },
    version:   '1.0.0',
    author:    'system',
    rationale: 'Circular flows may indicate loans, round-tripping, or temporary '
             + 'parking of funds. Flagged for investigator review rather than '
             + 'automatic conclusion.',
    createdAt: '2026-06-25',
    history:   [],
  },

  {
    id:       'ATM_CLUSTER',
    name:     'Clustered ATM withdrawals',
    type:     'detection',
    enabled:  true,
    severity: 'Medium',
    description: 'Three or more ATM withdrawals within a short window, '
               + 'suggesting deliberate cash extraction.',
    config: {
      windowDays: 10,
      minCount: 3,
      minTotalAmount: 30000,
    },
    version:   '1.0.0',
    author:    'system',
    rationale: 'Clustered ATM activity after large credits may indicate intentional '
             + 'conversion to untraceable cash. Normal ATM usage is distributed.',
    createdAt: '2026-06-25',
    history:   [],
  },

  {
    id:       'SPLIT_PAYMENT',
    name:     'Possible payment splitting',
    type:     'detection',
    enabled:  true,
    severity: 'Low',
    description: 'Multiple transfers of similar amounts to the same entity within a window, '
               + 'which may indicate deliberate splitting of a larger payment.',
    config: {
      windowDays: 30,
      minCount: 3,
      amountTolerancePct: 0.10,  // amounts within 10% of each other
      minAmount: 5000,
    },
    version:   '1.0.0',
    author:    'system',
    rationale: 'Structuring (splitting payments to avoid reporting thresholds) is a '
             + 'known technique. This rule flags the pattern for investigator review.',
    createdAt: '2026-06-25',
    history:   [],
  },

  {
    id:       'LARGE_UNMATCHED_OUTFLOW',
    name:     'Large outflow without clear prior credit',
    type:     'detection',
    enabled:  true,
    severity: 'High',
    description: 'A large single transfer with no corresponding inflow to explain it '
               + 'within the prior window.',
    config: {
      minAmount: 200000,
      lookbackDays: 30,
      creditCoverageThreshold: 0.50,  // if less than 50% of amount arrived in window
    },
    version:   '1.0.0',
    author:    'system',
    rationale: 'Large outflows not preceded by equivalent inflows may draw on '
             + 'pre-existing balance or undisclosed sources. Flagged for source tracing.',
    createdAt: '2026-06-25',
    history:   [],
  },

  {
    id:       'NEW_ENTITY_LARGE',
    name:     'New entity receiving large transfer',
    type:     'detection',
    enabled:  true,
    severity: 'Medium',
    description: 'A previously unseen entity receives a transfer above threshold.',
    config: {
      minAmount: 100000,
      newEntityWindowDays: 90,  // no prior transactions in last 90 days
    },
    version:   '1.0.0',
    author:    'system',
    rationale: 'New beneficiaries appearing after major receipts (especially government) '
             + 'warrant identification and verification.',
    createdAt: '2026-06-25',
    history:   [],
  },

  {
    id:       'CASH_IN_AFTER_CASH_OUT',
    name:     'Cash deposit following ATM withdrawal',
    type:     'detection',
    enabled:  true,
    severity: 'Low',
    description: 'A cash deposit occurs within a short window after an ATM withdrawal.',
    config: {
      windowDays: 30,
      minAmount: 10000,
    },
    version:   '1.0.0',
    author:    'system',
    rationale: 'Cash out followed by cash in may indicate conversion between accounts, '
             + 'cash-back schemes, or re-deposit of withdrawn funds.',
    createdAt: '2026-06-25',
    history:   [],
  },

  // ─── Classification Rules ─────────────────────────────────────────────────

  {
    id:       'CLASSIFY_GOVERNMENT',
    name:     'Classify government transactions',
    type:     'classification',
    enabled:  true,
    severity: 'Low',
    description: 'Assign GOVERNMENT category to narrations matching known government patterns.',
    config: {
      patterns: [
        'NHAI', 'CALA CUM DRO', 'LAND ACQ', 'NRTGS/INDBR',
        'INCOME TAX', 'BPXPK3032H',
        'NATIONAL HORTICULTUR', 'HNEEW3C',
        'DISTRICT TREASURY', 'RBIS0GOHREP', 'SDM',
        'HVPNL', 'HARYANA VIDYUT',
        'MISSION DIRECTOR', 'HSHDA', 'SPARSH NHM', 'NHM GEN',
        'IOC Ref No', 'IOCL LPG',
        'CROP COMP',
        'MREF/W01',
        'MARKET COMMITTEE',
        'HARYANA STATE CO OPERAT',
        'HARYANA PARIVAR PEHC',
        'GOHRSPARSH',
      ],
      assignCategory: 'GOVERNMENT',
    },
    version:   '1.0.0',
    author:    'system',
    rationale: 'Government transactions are identified by narration keywords associated with '
             + 'known government bodies, schemes, and payment references.',
    createdAt: '2026-06-25',
    history:   [],
  },

  {
    id:       'CLASSIFY_CASH',
    name:     'Classify cash transactions',
    type:     'classification',
    enabled:  true,
    severity: 'Low',
    description: 'Assign CASH category to ATM withdrawals and cash deposits.',
    config: {
      patterns: ['ATM', 'CASH', 'BYCASH', 'BY CASH', 'BY ATM'],
      assignCategory: 'CASH',
    },
    version:   '1.0.0',
    author:    'system',
    rationale: 'Cash transactions leave no beneficiary trail. Separating them '
             + 'enables cash-reconstruction analysis.',
    createdAt: '2026-06-25',
    history:   [],
  },

  {
    id:       'CLASSIFY_BANK',
    name:     'Classify bank charges and interest',
    type:     'classification',
    enabled:  true,
    severity: 'Low',
    description: 'Assign BANK category to charges, fees, GST, and interest entries.',
    config: {
      patterns: [
        'Int.Pd', 'INTT.', 'Int on Term Dep', 'IO For',
        'CHARGES', 'GST', 'SMS CHARGES', 'ANNUAL FEE',
        'AutoPay', 'NACH RETURN', 'ECS',
      ],
      assignCategory: 'BANK',
    },
    version:   '1.0.0',
    author:    'system',
    rationale: 'Bank-generated entries (interest, charges) are not discretionary '
             + 'transfers and should be excluded from person-to-person flow analysis.',
    createdAt: '2026-06-25',
    history:   [],
  },

  {
    id:       'CLASSIFY_INTERNAL',
    name:     'Classify internal self-transfers',
    type:     'classification',
    enabled:  true,
    severity: 'Low',
    description: 'Assign INTERNAL category to transfers between the subject\'s own accounts.',
    config: {
      ownAccountIds: ['916010013826348', '0361000101181752'],
      assignCategory: 'INTERNAL',
    },
    version:   '1.0.0',
    author:    'system',
    rationale: 'Self-transfers inflate gross IN/OUT figures. Identifying them prevents '
             + 'double-counting in balance and flow analyses.',
    createdAt: '2026-06-25',
    history:   [],
  },

  // ─── Scoring Rules ────────────────────────────────────────────────────────

  {
    id:       'SCORE_GOVT_LINKAGE',
    name:     'Risk score: government receipt linkage',
    type:     'scoring',
    enabled:  true,
    severity: 'High',
    description: 'Entities that receive transfers within 7 days of government credits '
               + 'receive elevated risk contribution.',
    config: {
      windowDays: 7,
      scoreContribution: 20,   // out of 100
      minAmount: 50000,
    },
    version:   '1.0.0',
    author:    'system',
    rationale: 'Proximity to government compensation disbursement is a key investigative '
             + 'signal when the entity is not an obvious household expense recipient.',
    createdAt: '2026-06-25',
    history:   [],
  },

  {
    id:       'SCORE_VOLUME',
    name:     'Risk score: total amount handled',
    type:     'scoring',
    enabled:  true,
    severity: 'Low',
    description: 'Higher total transaction volume increases entity risk contribution.',
    config: {
      // Score = min(40, floor(totalAmount / 100000))
      // Caps at 40 pts for ₹40L+ total
      maxScore: 40,
      perLakh: 1,
    },
    version:   '1.0.0',
    author:    'system',
    rationale: 'Entities handling larger absolute amounts warrant more scrutiny, '
             + 'independent of pattern.',
    createdAt: '2026-06-25',
    history:   [],
  },

  {
    id:       'SCORE_FREQUENCY',
    name:     'Risk score: transaction frequency',
    type:     'scoring',
    enabled:  true,
    severity: 'Low',
    description: 'Higher transaction count with an entity increases risk contribution.',
    config: {
      maxScore: 15,
      perTransaction: 0.5,  // 0.5 pt per transaction, capped at 15
    },
    version:   '1.0.0',
    author:    'system',
    rationale: 'High-frequency relationships deserve investigative attention '
             + 'regardless of individual transaction size.',
    createdAt: '2026-06-25',
    history:   [],
  },

  {
    id:       'SCORE_CONCENTRATION',
    name:     'Risk score: time concentration',
    type:     'scoring',
    enabled:  true,
    severity: 'High',
    description: 'Large amounts concentrated in a short period elevate risk score.',
    config: {
      windowDays: 30,
      threshold: 500000,    // more than 5L in 30 days
      scoreContribution: 10,
    },
    version:   '1.0.0',
    author:    'system',
    rationale: 'Normal financial relationships are distributed over time. '
             + 'Concentration suggests event-driven rather than routine transfers.',
    createdAt: '2026-06-25',
    history:   [],
  },

  {
    id:       'SCORE_CASH_LINKAGE',
    name:     'Risk score: cash linkage',
    type:     'scoring',
    enabled:  true,
    severity: 'Medium',
    description: 'ATM clusters near entity transfers elevate risk score.',
    config: {
      windowDays: 10,
      scoreContribution: 10,
    },
    version:   '1.0.0',
    author:    'system',
    rationale: 'Cash withdrawals following entity transfers may indicate conversion '
             + 'of traceable transfers to untraceable cash.',
    createdAt: '2026-06-25',
    history:   [],
  },

  {
    id:       'SCORE_CIRCULAR',
    name:     'Risk score: circular flow detected',
    type:     'scoring',
    enabled:  true,
    severity: 'High',
    description: 'Entities with detected circular flows receive elevated risk.',
    config: {
      scoreContribution: 15,
    },
    version:   '1.0.0',
    author:    'system',
    rationale: 'Circular flows — money leaving and returning through the same entity — '
             + 'are a pattern associated with round-tripping and fictitious transactions.',
    createdAt: '2026-06-25',
    history:   [],
  },

  // ─── Narrative Rules ──────────────────────────────────────────────────────

  {
    id:       'NARR_RAPID_DISPERSAL',
    name:     'Narrative: government money dispersed quickly',
    type:     'narrative',
    enabled:  true,
    severity: 'High',
    description: 'Generate observation when government money leaves rapidly.',
    config: {
      template: 'Government payment of ₹{amount} received on {date}. '
              + 'Within {days} days, ₹{outAmount} ({pct}%) was transferred out '
              + 'to {entityCount} recipient(s). This pattern warrants review.',
    },
    version:   '1.0.0',
    author:    'system',
    rationale: 'Plain-language observation for non-technical investigators.',
    createdAt: '2026-06-25',
    history:   [],
  },

  {
    id:       'NARR_CIRCULAR',
    name:     'Narrative: circular flow observed',
    type:     'narrative',
    enabled:  true,
    severity: 'High',
    description: 'Generate observation when money goes out and returns from same source.',
    config: {
      template: '₹{outAmount} was transferred to {entity} on {outDate}. '
              + '₹{returnAmount} was received back from the same entity on {inDate} '
              + '({days} days later). The net flow was ₹{netAmount} {direction}.',
    },
    version:   '1.0.0',
    author:    'system',
    rationale: 'Circular flow narrative for investigator review panel.',
    createdAt: '2026-06-25',
    history:   [],
  },

  {
    id:       'NARR_DOMINANT_RECIPIENT',
    name:     'Narrative: single dominant recipient',
    type:     'narrative',
    enabled:  true,
    severity: 'Medium',
    description: 'Generate observation when one entity receives disproportionate share.',
    config: {
      thresholdPct: 0.40,   // one entity gets >40% of all outflows
      template: '{entity} received ₹{amount} ({pct}% of total outflows) '
              + 'across {count} transactions — the largest single recipient.',
    },
    version:   '1.0.0',
    author:    'system',
    rationale: 'Dominant recipient identification helps focus investigation.',
    createdAt: '2026-06-25',
    history:   [],
  },
];

// ─── Exports ─────────────────────────────────────────────────────────────────

if (typeof module !== 'undefined') module.exports = { DEFAULT_RULES };
if (typeof window !== 'undefined') window.DEFAULT_RULES = DEFAULT_RULES;
