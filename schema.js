/**
 * schema.js
 * Canonical data model for the Financial Investigation Platform.
 * All types defined here. Nothing downstream may deviate from these shapes.
 * Version: 1.0.0
 */

'use strict';

// ─── Enums ────────────────────────────────────────────────────────────────────

const Provenance = Object.freeze({
  VERIFIED:  'Verified',   // Original electronic statement (CSV/XLS)
  IMPORTED:  'Imported',   // Extracted from PDF or secondary source
  ESTIMATED: 'Estimated',  // Inferred or reconstructed
});

const Direction = Object.freeze({
  IN:  'IN',
  OUT: 'OUT',
});

const Category = Object.freeze({
  GOVERNMENT: 'GOVERNMENT',   // Govt bodies, NHAI, IOC, IT dept
  FAMILY:     'FAMILY',       // Known family members
  CASH:       'CASH',         // ATM, cash in/out
  BUSINESS:   'BUSINESS',     // Commercial counterparties
  BANK:       'BANK',         // Charges, interest, fees
  INTERNAL:   'INTERNAL',     // Self-transfers between own accounts
  UNKNOWN:    'UNKNOWN',      // Unresolved
});

const Severity = Object.freeze({
  LOW:      'Low',
  MEDIUM:   'Medium',
  HIGH:     'High',
  CRITICAL: 'Critical',
});

const RuleType = Object.freeze({
  DETECTION:      'detection',      // Find patterns → produce flags
  CLASSIFICATION: 'classification', // Assign categories
  SCORING:        'scoring',        // Affect risk score
  NARRATIVE:      'narrative',      // Generate plain-language observations
});

const EventType = Object.freeze({
  FINANCIAL:    'financial',
  FAMILY:       'family',
  LEGAL:        'legal',
  HEALTH:       'health',
  PROPERTY:     'property',
  INVESTIGATOR: 'investigator',
  EXTERNAL:     'external',
});

const InvestigatorAction = Object.freeze({
  MERGE_ENTITY:    'MergeEntity',
  RENAME_ENTITY:   'RenameEntity',
  CREATE_MARKER:   'CreateMarker',
  ADD_NOTE:        'AddNote',
  DISABLE_RULE:    'DisableRule',
  ENABLE_RULE:     'EnableRule',
  CREATE_SNAPSHOT: 'CreateSnapshot',
  SET_FILTER:      'SetFilter',
  CREATE_CASE:     'CreateCase',
  SET_HYPOTHESIS:  'SetHypothesis',
});

// ─── Core Transaction ─────────────────────────────────────────────────────────

/**
 * Canonical Transaction — everything downstream consumes this shape.
 * Observed fields are immutable after normalization.
 * Derived fields are recomputed by the engine.
 */
function makeTransaction(observed, derived = {}) {
  return Object.freeze({
    // Observed (immutable, from source)
    id:          observed.id,
    dateTime:    observed.dateTime,        // Date object
    accountId:   observed.accountId,
    bank:        observed.bank,
    direction:   observed.direction,       // Direction enum
    amount:      observed.amount,          // Number, always positive
    balance:     observed.balance ?? null, // Number or null
    narration:   observed.narration,       // Raw, unmodified string
    sourceFile:  observed.sourceFile,
    sourceRow:   observed.sourceRow,       // Integer row index
    provenance:  observed.provenance,      // Provenance enum

    // Derived (computed, recomputable)
    entityId:    derived.entityId    ?? null,
    categoryId:  derived.categoryId  ?? Category.UNKNOWN,
    confidence:  derived.confidence  ?? 0,   // 0–1
    flags:       derived.flags       ?? [],
    riskContrib: derived.riskContrib ?? 0,

    // Lineage — makes every derived value reproducible
    lineage: Object.freeze({
      value:         observed.amount,
      derivedFrom:   derived.lineage?.derivedFrom   ?? [observed.id],
      rulesApplied:  derived.lineage?.rulesApplied  ?? [],
      engineVersion: derived.lineage?.engineVersion ?? '1.0.0',
    }),
  });
}

// ─── Identity & Entity ────────────────────────────────────────────────────────

/**
 * Identity — a real-world person or organisation.
 * One identity may own multiple accounts and entities.
 */
function makeIdentity(data) {
  return {
    id:           data.id,
    displayName:  data.displayName,
    aliases:      data.aliases      ?? [],   // String[]
    phones:       data.phones       ?? [],
    upiHandles:   data.upiHandles   ?? [],
    accounts:     data.accounts     ?? [],   // accountId[]
    emails:       data.emails       ?? [],
    notes:        data.notes        ?? '',
    isSubject:    data.isSubject    ?? false, // Primary account holder
    isPredefined: data.isPredefined ?? false, // From defaultEntities
  };
}

/**
 * Entity — a cluster of transaction counterparties resolved to one identity.
 * Many-to-one: many narration patterns → one EntityCluster → one Identity.
 */
function makeEntityCluster(data) {
  return {
    id:           data.id,
    identityId:   data.identityId,
    displayName:  data.displayName,
    patterns:     data.patterns     ?? [],   // Regex or string patterns matched
    phones:       data.phones       ?? [],
    upiHandles:   data.upiHandles   ?? [],
    confidence:   data.confidence   ?? 1.0,  // Resolution confidence 0–1
    isPredefined: data.isPredefined ?? false,
    manuallyVerified: data.manuallyVerified ?? false,
    mergedFrom:   data.mergedFrom   ?? [],   // entityIds that were merged into this
  };
}

// ─── Rule ────────────────────────────────────────────────────────────────────

function makeRule(data) {
  return Object.freeze({
    id:          data.id,
    name:        data.name,
    type:        data.type,        // RuleType enum
    enabled:     data.enabled ?? true,
    severity:    data.severity,    // Severity enum
    description: data.description ?? '',
    // Detection config (flexible, rule-specific)
    config:      Object.freeze(data.config ?? {}),
    // Provenance of the rule itself
    version:     data.version     ?? '1.0.0',
    author:      data.author      ?? 'system',
    rationale:   data.rationale   ?? '',
    createdAt:   data.createdAt   ?? new Date().toISOString(),
    history:     Object.freeze(data.history ?? []), // threshold change log
  });
}

// ─── Flag ────────────────────────────────────────────────────────────────────

function makeFlag(data) {
  return Object.freeze({
    ruleId:       data.ruleId,
    severity:     data.severity,
    label:        data.label,
    description:  data.description,
    txnIds:       Object.freeze(data.txnIds ?? []),  // supporting transactions
    entityIds:    Object.freeze(data.entityIds ?? []),
    windowDays:   data.windowDays ?? null,
    amount:       data.amount     ?? null,
    computedAt:   new Date().toISOString(),
    lineage:      Object.freeze(data.lineage ?? {}),
  });
}

// ─── Case & Versioning ───────────────────────────────────────────────────────

function makeCase(data) {
  return {
    id:           data.id,
    name:         data.name,
    description:  data.description ?? '',
    createdAt:    data.createdAt   ?? new Date().toISOString(),
    subjectId:    data.subjectId   ?? null,   // Identity id of primary subject
    // Event sourcing: array of investigator actions (append-only)
    actionLog:    data.actionLog   ?? [],
    // Derived current state (rebuilt by replaying actionLog)
    currentState: data.currentState ?? makeDefaultCaseState(),
    snapshots:    data.snapshots   ?? [],
    hypotheses:   data.hypotheses  ?? [],
  };
}

function makeDefaultCaseState() {
  return {
    filter:        makeDefaultFilter(),
    entityEdits:   [],   // manual merges, renames
    disabledRules: [],
    eventMarkers:  [],
    notes:         {},   // keyed by entityId or txnId
    activeHypothesis: null,
  };
}

function makeDefaultFilter() {
  return {
    from:      null,   // Date or null (null = all time)
    to:        null,
    entityIds: [],     // empty = all entities
    banks:     [],     // empty = all banks
    direction: null,   // null = both
    flags:     [],     // filter to transactions with these flags
    minAmount: null,
    maxAmount: null,
    categories:[],
    searchText:'',
  };
}

function makeSnapshot(data) {
  return Object.freeze({
    id:        data.id,
    label:     data.label,
    createdAt: data.createdAt ?? new Date().toISOString(),
    filter:    Object.freeze(data.filter),
    notes:     data.notes    ?? '',
    // Serialized computed state at snapshot time
    computed:  data.computed ?? null,
  });
}

// ─── Event Marker ────────────────────────────────────────────────────────────

function makeEventMarker(data) {
  return {
    id:          data.id,
    date:        data.date,       // Date object
    label:       data.label,
    description: data.description ?? '',
    type:        data.type,       // EventType enum
    linkedTxnIds:data.linkedTxnIds ?? [],
    source:      data.source      ?? 'investigator',
  };
}

// ─── Computed Output shapes ───────────────────────────────────────────────────

/**
 * The standard payload every engine module returns.
 * charts.js consumes chartData, ai.js consumes explanations,
 * export.js consumes exportPayload.
 */
function makeModuleOutput(data) {
  return Object.freeze({
    moduleName:    data.moduleName,
    metrics:       Object.freeze(data.metrics       ?? {}),
    chartData:     Object.freeze(data.chartData     ?? {}),
    explanations:  Object.freeze(data.explanations  ?? []),
    exportPayload: Object.freeze(data.exportPayload ?? {}),
    computedAt:    new Date().toISOString(),
    engineVersion: '1.0.0',
  });
}

/**
 * Lineage object — attaches to every derived value.
 */
function makeLineage(data) {
  return Object.freeze({
    value:        data.value,
    derivedFrom:  Object.freeze(data.derivedFrom  ?? []),
    rulesApplied: Object.freeze(data.rulesApplied ?? []),
    computation:  data.computation  ?? '',  // human-readable formula
    engineVersion: '1.0.0',
  });
}

// ─── Query DSL ───────────────────────────────────────────────────────────────

/**
 * Internal query language.
 * Gemini translates natural language → this structure.
 * Engine executes this structure. Gemini never touches numbers.
 *
 * Example:
 *   "Show govt credits followed by transfers over 5L within 7 days"
 * →
 *   { steps: [
 *       { op: 'FILTER', where: { category: 'GOVERNMENT', direction: 'IN' } },
 *       { op: 'THEN', window: 7, unit: 'days' },
 *       { op: 'FILTER', where: { direction: 'OUT', amount: { gt: 500000 } } }
 *     ],
 *     groupBy: 'entityId',
 *     orderBy: { field: 'amount', dir: 'DESC' },
 *     limit: null,
 *     explain: true
 *   }
 */
function makeQuery(data) {
  return Object.freeze({
    steps:   Object.freeze(data.steps   ?? []),
    groupBy: data.groupBy ?? null,
    orderBy: data.orderBy ?? null,
    limit:   data.limit   ?? null,
    explain: data.explain ?? false,
    label:   data.label   ?? '',  // human-readable description
  });
}

// ─── Validation ──────────────────────────────────────────────────────────────

function validateTransaction(t) {
  const errors = [];
  if (!t.id)                                      errors.push('Missing id');
  if (!(t.dateTime instanceof Date))              errors.push('dateTime must be Date');
  if (isNaN(t.dateTime))                          errors.push('dateTime is invalid');
  if (!t.accountId)                               errors.push('Missing accountId');
  if (!Object.values(Direction).includes(t.direction)) errors.push(`Invalid direction: ${t.direction}`);
  if (typeof t.amount !== 'number' || t.amount < 0)    errors.push('amount must be non-negative number');
  if (!Object.values(Provenance).includes(t.provenance)) errors.push(`Invalid provenance: ${t.provenance}`);
  return errors;
}

function validateRule(r) {
  const errors = [];
  if (!r.id)   errors.push('Rule missing id');
  if (!r.name) errors.push('Rule missing name');
  if (!Object.values(RuleType).includes(r.type))   errors.push(`Invalid rule type: ${r.type}`);
  if (!Object.values(Severity).includes(r.severity)) errors.push(`Invalid severity: ${r.severity}`);
  return errors;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

const Schema = {
  // Enums
  Provenance, Direction, Category, Severity, RuleType, EventType, InvestigatorAction,
  // Factories
  makeTransaction, makeIdentity, makeEntityCluster, makeRule, makeFlag,
  makeCase, makeDefaultCaseState, makeDefaultFilter, makeSnapshot,
  makeEventMarker, makeModuleOutput, makeLineage, makeQuery,
  // Validation
  validateTransaction, validateRule,
};

if (typeof module !== 'undefined') module.exports = Schema;
if (typeof window !== 'undefined') window.Schema = Schema;
