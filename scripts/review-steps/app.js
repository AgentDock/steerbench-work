/**
 * Client for the SteerBench step-evidence labeler (the process-reward path).
 *
 * A real static asset, not embedded in a server template string. It drives a
 * one-card-at-a-time loop over a small JSON API:
 *   GET  /api/state?rater=<id>  -> { rater, total, answered, done, item, calibration? }
 *   POST /api/answer            -> the next state
 *
 * Each card shows what a model said when it decided plus one evidence item; the
 * rater answers whether the rationale used that evidence (yes / no / can't tell)
 * or flags a broken card. The two layouts (focused card, two-panel) are the same
 * markup; the URL path picks one and CSS does the rest, so there is no
 * server-side branching. State lives on the server; this file only renders and
 * submits.
 */
(() => {
  /** @type {string} Saved rater id, restored from localStorage. */
  let rater = localStorage.getItem("sb-rater") || "";
  /** @type {object|null} The item currently shown. */
  let current = null;
  /** @type {boolean} True while an answer POST is in flight (debounces fast keypresses). */
  let busy = false;

  const el = (id) => document.getElementById(id);

  /**
   * Escapes a string for safe insertion as HTML (used only for the calibration
   * summary, the one place this client builds markup from values).
   * @param {unknown} s
   * @returns {string}
   */
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // Layout is chosen by the URL path: /panel is the two-panel view, anything
  // else is the focused card. Set the body attribute the CSS keys off, and point
  // the header link at the other layout.
  const view = window.location.pathname === "/panel" ? "panel" : "card";
  document.body.dataset.view = view;
  const otherView = view === "panel" ? "card" : "panel";
  const otherLabel = view === "panel" ? "focused card" : "two-panel";
  const layoutLink = el("layout-link");
  layoutLink.href = "/" + otherView;
  layoutLink.textContent = "switch to the " + otherLabel + " layout";

  /**
   * Renders the calibration summary on the finish screen, if the server scored
   * this rater against a key.
   * @param {object} cal - { matched, keyed, score, pass_bar, passed, provisional, mismatches }
   */
  function renderCalibration(cal) {
    let html = "<strong>Calibration: " + cal.matched + " of " + cal.keyed +
      " matched (" + Math.round(cal.score * 100) + "%), " +
      (cal.passed ? "PASS" : "BELOW THE BAR") +
      " (bar " + Math.round(cal.pass_bar * 100) + "%).</strong>";
    if (cal.provisional) {
      html += "<br>The answer key is a draft pending adjudication; treat this " +
        "score as practice, not qualification.";
    }
    if (cal.mismatches.length > 0) {
      html += "<br>Review these with the adjudicator:";
      for (const m of cal.mismatches) {
        html += '<br><span class="miss">' + esc(m.item_id) + " (expected " +
          esc(m.expected) + ", got " + esc(m.got || "no answer") + ")</span>";
      }
    }
    el("calibration").innerHTML = html;
    el("calibration").hidden = false;
  }

  /**
   * Renders a state response: either the finished panel or the next card.
   * @param {object} state - { rater, total, answered, done, item, calibration? }
   */
  function show(state) {
    el("gate").hidden = true;
    el("work-error").textContent = "";
    if (state.done) {
      el("work").hidden = true;
      el("finished").hidden = false;
      el("summary").textContent = state.answered + " answers saved for " + state.rater;
      if (state.calibration) renderCalibration(state.calibration);
      return;
    }
    current = state.item;
    el("work").hidden = false;
    el("counter").textContent = "question " + (state.answered + 1) + " of " + state.total;
    el("bar").style.width = (100 * state.answered / state.total) + "%";
    el("situation").textContent = current.scenario_title ||
      "An AI agent was deciding whether to go ahead with an action.";
    el("rationale").textContent = current.rationale;
    el("fact-label").textContent = current.evidence_kind === "missing"
      ? "A safeguard that was missing"
      : "One fact it could have checked";
    el("fact-text").textContent = current.evidence_text;
    el("question").textContent = current.evidence_kind === "missing"
      ? "Did the AI notice this safeguard was missing?"
      : "Did the AI's explanation use this fact?";
    el("fineprint").textContent = current.scenario_id + " / " + current.variant_key +
      " / trial " + current.trial + " / " + current.evidence_src;
  }

  /** Loads the current rater's state and renders it. Surfaces gate errors. */
  async function refresh() {
    const res = await fetch("/api/state?rater=" + encodeURIComponent(rater));
    const state = await res.json();
    if (!res.ok) { el("gate-error").textContent = state.error || ("HTTP " + res.status); return; }
    show(state);
  }

  /**
   * Submits an answer (or "flag") for the current item and renders the next
   * state. Guards against overlapping submits, and surfaces any server error
   * (e.g. a 409 when the queue was regenerated) instead of failing silently.
   * @param {string} value
   */
  async function answer(value) {
    if (busy || !current) return;
    busy = true;
    try {
      const res = await fetch("/api/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rater, item_id: current.item_id, item_sha256: current.item_sha256, answer: value })
      });
      const state = await res.json();
      if (!res.ok) {
        el("work-error").textContent = (state.error || ("HTTP " + res.status)) +
          (res.status === 409 ? " — reload the page to pick up the new queue." : "");
        return;
      }
      show(state);
    } finally {
      busy = false;
    }
  }

  el("gate").addEventListener("submit", (e) => {
    e.preventDefault();
    rater = el("rater-input").value.trim();
    localStorage.setItem("sb-rater", rater);
    refresh();
  });
  el("options").querySelectorAll("button[data-answer]").forEach((b) =>
    b.addEventListener("click", () => answer(b.dataset.answer)));
  document.addEventListener("keydown", (e) => {
    // Never hijack keys while the rater is typing (e.g. entering their id).
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (el("work").hidden || !current) return;
    if (e.key === "y" || e.key === "Y") answer("yes");
    else if (e.key === "n" || e.key === "N") answer("no");
    else if (e.key === "u" || e.key === "U") answer("unclear");
    else if (e.key === "f" || e.key === "F") answer("flag");
  });

  // Auto-resume: a returning rater (including after a layout switch) goes
  // straight back to their next unanswered card, no second Start click.
  if (rater) {
    el("rater-input").value = rater;
    refresh();
  }
})();
