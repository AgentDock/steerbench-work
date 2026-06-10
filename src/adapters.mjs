// Maps evidence and actions to the storage adapter that would observe them at
// runtime. The adapter audit attached to each event records which adapter read
// each piece of evidence, so a steering decision is traceable to its sources.

/** Storage adapters and the evidence source types each one observes. */
export const STORAGE_ADAPTERS = [
  {
    adapter: "document_store_adapter",
    source_types: ["document"],
    purpose: "Reads policy, invoice, ticket, calendar, and report documents."
  },
  {
    adapter: "file_snapshot_adapter",
    source_types: ["file_snapshot"],
    purpose: "Captures durable workspace file state before a write crosses the boundary."
  },
  {
    adapter: "tool_call_adapter",
    source_types: ["tool_call", "score"],
    purpose: "Captures command, benchmark, payment, export, and scheduling tool state."
  }
];

/**
 * Project a raw evidence record into the normalized shape events carry,
 * tagging it with its adapter and the extra fields it observed.
 *
 * @param {object} record - Raw evidence record.
 * @returns {object} Normalized evidence record.
 */
export function normalizeEvidenceRecord(record) {
  return {
    adapter: adapterNameForSourceType(record.source_type),
    evidence_id: record.evidence_id,
    source_type: record.source_type,
    title: record.title,
    status: record.status,
    raw_ref: record.raw_ref,
    observed_fields: Object.keys(record).filter((key) => ![
      "evidence_id",
      "source_type",
      "title",
      "status",
      "raw_ref"
    ].includes(key))
  };
}

/**
 * Map an action type to the source type its produced evidence would carry.
 * Unmapped action types fall back to "tool_call".
 *
 * @param {object} action - Action with an action_type field.
 * @returns {string} Source type label.
 */
export function actionSourceType(action) {
  const map = {
    durable_write: "file_snapshot",
    external_send: "draft_message",
    publish: "publication_candidate",
    cost_action: "payment_tool_call",
    privileged_tool_call: "privileged_tool_call",
    destructive_action: "file_snapshot",
    submit_final: "final_answer",
    schedule_external: "calendar_tool_call",
    internal_note: "document",
    internal_summary: "document"
  };
  return map[action.action_type] || "tool_call";
}

/**
 * Build the adapter audit for an event: the adapter responsible for the action
 * plus the normalized adapter view of every evidence record.
 *
 * @param {object} args
 * @param {object} args.action - Proposed action.
 * @param {Array<object>} args.evidence - Evidence records.
 * @returns {{action_adapter: string, evidence_adapters: Array<object>}}
 */
export function buildAdapterAudit({ action, evidence }) {
  return {
    action_adapter: adapterNameForAction(action),
    evidence_adapters: evidence.map(normalizeEvidenceRecord)
  };
}

function adapterNameForAction(action) {
  if (action.action_type === "durable_write" || action.action_type === "destructive_action") {
    return "file_snapshot_adapter";
  }
  if (action.action_type === "external_send" || action.action_type === "publish") {
    return "document_store_adapter";
  }
  if (action.action_type === "internal_note" || action.action_type === "internal_summary") {
    return "document_store_adapter";
  }
  return "tool_call_adapter";
}

function adapterNameForSourceType(sourceType) {
  const match = STORAGE_ADAPTERS.find((item) => item.source_types.includes(sourceType));
  return match?.adapter || "tool_call_adapter";
}
