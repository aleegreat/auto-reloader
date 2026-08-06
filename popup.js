const $ = (id) => document.getElementById(id);

const DEFAULT_SECONDS = 300; // default interval: 5 minutes
const DEFAULT_JITTER = 5;    // default jitter: ±5%

// parseInt(...) || fallback would treat a legit 0 as missing; use NaN check instead.
const parseOr = (v, fallback) => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
};

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function showStatus(text) {
  $("status").textContent = text;
  setTimeout(() => { $("status").textContent = ""; }, 2000);
}

async function loadForActiveTab() {
  const tab = await getActiveTab();
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "getSettingsForTab", tabId: tab.id }, (resp) => {
      void chrome.runtime.lastError; // swallow messaging errors
      const s = resp?.settings || null;

      $("seconds").value = s?.seconds ?? DEFAULT_SECONDS;
      $("jitter").value = s?.jitterPct ?? DEFAULT_JITTER;
      $("enabled").checked = s ? !!s.enabled : true; // default ON; Apply activates

      // Migrate legacy single toggle (autoDisableOnUrlChange) if present
      const legacy = s?.autoDisableOnUrlChange;
      $("autoDisableDomain").checked = (s?.autoDisableOnDomainChange !== undefined)
        ? !!s.autoDisableOnDomainChange
        : (legacy !== undefined ? !!legacy : true); // default ON
      $("autoDisablePath").checked = (s?.autoDisableOnPathChange !== undefined)
        ? !!s.autoDisableOnPathChange
        : (legacy !== undefined ? !!legacy : false); // default OFF

      resolve({ tab, settings: s });
    });
  });
}

async function applyToActiveTab() {
  const tab = await getActiveTab();

  const seconds = Math.max(1, parseOr($("seconds").value, DEFAULT_SECONDS));
  const jitterPct = Math.max(0, Math.min(100, parseOr($("jitter").value, DEFAULT_JITTER)));
  const enabled = $("enabled").checked;
  const autoDisableOnDomainChange = $("autoDisableDomain").checked;
  const autoDisableOnPathChange = $("autoDisablePath").checked;

  // Instant UI feedback — don't wait for background round-trips.
  if (enabled) {
    const flags = [];
    if (autoDisableOnDomainChange) flags.push("domain/IP");
    if (autoDisableOnPathChange) flags.push("path");
    const autoNote = flags.length ? ` • auto-disable on ${flags.join(" & ")} change` : "";
    showStatus(`Enabled: every ${seconds}s (±${jitterPct}%)${autoNote}`);
  } else {
    showStatus("Disabled for this tab");
  }

  const settings = enabled
    ? {
        enabled: true,
        seconds,
        jitterPct,
        autoDisableOnDomainChange,
        autoDisableOnPathChange,
        lastUrl: tab.url // seed for comparison immediately
      }
    : null; // manual disable clears this tab's entry

  // Persist settings; background handles injecting content.js (works even if
  // this popup closes right away). Fire-and-forget for a snappy UI.
  chrome.runtime.sendMessage({ type: "updateSettingsForTab", tabId: tab.id, settings }, (resp) => {
    void chrome.runtime.lastError;
    // Background rejects pages where content.js cannot run (chrome:// etc.).
    if (enabled && resp && !resp.ok) showStatus("Cannot run on this page");
  });
}

async function disableForActiveTab() {
  const tab = await getActiveTab();
  $("enabled").checked = false;
  showStatus("Disabled for this tab");
  chrome.runtime.sendMessage({ type: "updateSettingsForTab", tabId: tab.id, settings: null }, () => {
    void chrome.runtime.lastError;
  });
}

// Script is at the end of <body>: DOM is ready, bind immediately (no waiting
// for DOMContentLoaded), so the popup feels instant.
(async () => {
  $("apply").addEventListener("click", applyToActiveTab);
  $("disable").addEventListener("click", disableForActiveTab);
  // Toggles/inputs only change local state; settings take effect on "Apply".
  loadForActiveTab();
})();
