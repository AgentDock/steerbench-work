/**
 * Client for the SteerBench human validation labeler.
 *
 * A real static asset (not embedded in a server template string). On load it
 * fetches the glossary once, then drives a one-card-at-a-time review loop over a
 * small JSON API:
 *   GET  /api/glossary            -> [{ group, terms }]   (definitions, display only)
 *   GET  /api/state?rater=<id>    -> { rater, total, answered, done, item }
 *   POST /api/answer              -> the next state
 *
 * Per-card term matching is done on the server (src/glossary.mjs); each item
 * arrives with its `glossary_terms`, so the client never matches text itself.
 * State (the rater id and progress) lives on the server; this file only renders
 * and submits.
 */
(() => {
  /** @type {string} Saved rater id, restored from localStorage. */
  let rater = localStorage.getItem("sb-gold-rater") || "";
  /** @type {object|null} The verdict item currently shown. */
  let current = null;
  /** @type {number} Index of the keyboard-highlighted option. */
  let sel = 0;
  /** @type {boolean} Whether the glossary panel shows the full list vs this card's terms. */
  let showAllTerms = false;
  /** @type {boolean} True while an answer POST is in flight (debounces fast keypresses). */
  let busy = false;
  /** @type {Array<[string, Record<string,string>]>} Glossary groups as [name, terms] pairs. */
  let glossaryGroups = [];
  /** @type {Record<string,string>} Flat term -> definition map for lookups. */
  const glossary = {};

  const el = (id) => document.getElementById(id);

  /**
   * Escapes a string for safe insertion as HTML text/attribute content.
   * @param {unknown} s
   * @returns {string}
   */
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  /** @returns {string[]} The terms to show for the current card (computed server-side). */
  function termsOnCard() {
    return current ? (current.glossary_terms || []) : [];
  }

  /** @returns {string} HTML for the full grouped glossary. */
  function glossaryFull() {
    return glossaryGroups.map((g) => "<h3>" + esc(g[0]) + "</h3><dl>" +
      Object.keys(g[1]).map((k) => "<dt>" + esc(k) + "</dt><dd>" + esc(g[1][k]) + "</dd>").join("") + "</dl>").join("");
  }

  /** Renders the glossary panel: this card's terms by default, the full list on demand. */
  function renderGlossary() {
    const g = el("glossary");
    if (showAllTerms) {
      g.innerHTML = glossaryFull() + '<p class="gloss-link"><a href="#" id="gloss-less">show only this card\'s terms</a></p>';
    } else {
      const terms = termsOnCard();
      const body = terms.length
        ? "<h3>Terms on this card</h3><dl>" + terms.map((k) => "<dt>" + esc(k) + "</dt><dd>" + esc(glossary[k]) + "</dd>").join("") + "</dl>"
        : '<p class="gloss-empty">No special terms on this card.</p>';
      g.innerHTML = body + '<p class="gloss-link"><a href="#" id="gloss-all">show all terms</a></p>';
    }
    const all = el("gloss-all");
    if (all) all.addEventListener("click", (e) => { e.preventDefault(); showAllTerms = true; renderGlossary(); });
    const less = el("gloss-less");
    if (less) less.addEventListener("click", (e) => { e.preventDefault(); showAllTerms = false; renderGlossary(); });
  }

  /** Shows or hides the glossary panel, keeping aria-expanded on the toggle in sync. */
  function toggleGlossary() {
    const g = el("glossary");
    g.hidden = !g.hidden;
    el("terms-toggle").setAttribute("aria-expanded", String(!g.hidden));
    if (!g.hidden) renderGlossary();
  }

  /**
   * Maps an evidence status to a visual class. Only the known-good set reads as
   * "ok"; everything else (superseded, suspect, missing, ...) defaults to "warn".
   * @param {string} s
   * @returns {"ok"|"warn"}
   */
  function statusClass(s) {
    const ok = ["current", "passed", "verified"];
    return ok.indexOf(String(s).toLowerCase()) >= 0 ? "ok" : "warn";
  }

  /**
   * Renders the card body from the server-built blocks. All text is escaped;
   * chip and evidence-status labels get their definition as a hover title.
   * @param {object[]} blocks
   */
  function renderCard(blocks) {
    el("card").innerHTML = blocks.map((b) => {
      if (b.kind === "situation") return '<div class="situation">' + esc(b.text) + "</div>";
      if (b.kind === "action") return '<div class="label">' + esc(b.label) + "</div>" +
        '<div class="action-text">' + esc(b.text) +
        (b.tag ? ' <span class="tag">' + esc(b.tag) + "</span>" : "") + "</div>";
      if (b.kind === "chips") return '<div class="label">' + esc(b.label) + "</div>" +
        '<div class="chips">' + b.items.map((x) => '<span class="chip" title="' + esc(glossary[x] || "") + '">' + esc(x) + "</span>").join("") + "</div>";
      if (b.kind === "evidence") return '<div class="label">' + esc(b.label) + '</div><ul class="evlist">' +
        b.items.map((e) => '<li><span class="evname">' + esc(e.name) + "</span>" +
          (e.status ? ' <span class="evstatus ' + statusClass(e.status) + '" title="' + esc(glossary[e.status] || "") + '">' + esc(e.status) + "</span>" : "") +
          (e.extra ? '<span class="evextra"> &mdash; ' + esc(e.extra) + "</span>" : "") + "</li>").join("") + "</ul>";
      if (b.kind === "context") return '<div class="label">' + esc(b.label) + "</div>" +
        '<div class="context">' + b.items.map((kv) => esc(kv[0]) + " " + "<b>" + esc(String(kv[1])) + "</b>").join("  &middot;  ") + "</div>";
      if (b.kind === "list") return '<div class="label">' + esc(b.label) + "</div><ul>" +
        b.items.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul>";
      return '<div class="label">' + esc(b.label) + '</div><div class="text">' + esc(b.text) + "</div>";
    }).join("");
  }

  /** Renders the option buttons for the current item plus the flag action. */
  function renderOptions() {
    const opts = current.options;
    el("options").innerHTML = opts.map((o, i) =>
      '<button class="opt' + (i === sel ? " sel" : "") + '" data-i="' + i + '">' +
      '<span class="n">' + (i + 1) + "</span>" + esc(o.label) +
      '<span class="hint">' + esc(o.hint) + "</span></button>"
    ).join("") +
    '<button class="opt flag" data-flag="1">' +
    '<span class="n">F</span>Flag this case<span class="hint">something is wrong or you cannot judge it; it goes to review instead of counting</span></button>';
    el("options").querySelectorAll("button[data-i]").forEach((b) =>
      b.addEventListener("click", () => choose(current.options[Number(b.dataset.i)].value)));
    el("options").querySelector("button[data-flag]").addEventListener("click", () => choose("flag"));
  }

  /**
   * Renders a state response: either the finished panel or the next card.
   * @param {object} state - { rater, total, answered, done, item }
   */
  function show(state) {
    el("gate").hidden = true;
    el("who").textContent = state.rater;
    el("work-error").textContent = "";
    if (state.done) {
      el("work").hidden = true;
      el("finished").hidden = false;
      el("summary").textContent = state.answered + " of " + state.total + " answers saved for " + state.rater +
        ". The other raters do the same on their own slot, then the team computes agreement and the gold labels.";
      return;
    }
    current = state.item;
    sel = 0;
    showAllTerms = false;
    if (!el("glossary").hidden) renderGlossary();
    el("work").hidden = false;
    el("counter").textContent = "step " + (state.answered + 1) + " of " + state.total;
    el("bar").style.width = (100 * state.answered / state.total) + "%";
    renderCard(current.card_blocks);
    el("question").textContent = current.question;
    renderOptions();
    el("fineprint").textContent = current.scenario_id + " / " + current.axis;
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
   * (e.g. a 409 when the scenario set changed) instead of failing silently.
   * @param {string} value
   */
  async function choose(value) {
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
          (res.status === 409 ? " — reload the page to pick up the new scenario set." : "");
        return;
      }
      show(state);
    } finally {
      busy = false;
    }
  }

  /** Moves the keyboard selection by `d`, wrapping within the option list. */
  function moveSel(d) {
    if (!current) return;
    const n = current.options.length;
    sel = (sel + d + n) % n;
    el("options").querySelectorAll("button[data-i]").forEach((b, i) => b.classList.toggle("sel", i === sel));
  }

  el("gate").addEventListener("submit", (e) => {
    e.preventDefault();
    rater = el("rater-input").value.trim();
    localStorage.setItem("sb-gold-rater", rater);
    refresh();
  });
  el("terms-toggle").addEventListener("click", () => toggleGlossary());
  document.addEventListener("keydown", (e) => {
    // Never hijack keys while the rater is typing (e.g. entering their id).
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.key === "?") { toggleGlossary(); return; }
    if (el("work").hidden || !current) return;
    if (e.key === "ArrowUp") { moveSel(-1); e.preventDefault(); }
    else if (e.key === "ArrowDown") { moveSel(1); e.preventDefault(); }
    else if (e.key === "Enter") { choose(current.options[sel].value); }
    else if (e.key === "f" || e.key === "F") { choose("flag"); }
    else if (/^[1-9]$/.test(e.key) && Number(e.key) <= current.options.length) {
      choose(current.options[Number(e.key) - 1].value);
    }
  });

  // Load the glossary (display data), then resume the saved rater session if any.
  fetch("/api/glossary")
    .then((r) => r.json())
    .then((groups) => {
      glossaryGroups = groups.map((g) => [g.group, g.terms]);
      glossaryGroups.forEach((g) => Object.assign(glossary, g[1]));
      if (rater) { el("rater-input").value = rater; refresh(); }
    })
    .catch((e) => { el("gate-error").textContent = "Could not load glossary: " + e.message; });
})();
