const $ = (id) => document.getElementById(id);

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
      const s = resp?.settings || null;

      $("seconds").value = s?.seconds ?? 60;
      $("jitter").value = s?.jitterPct ?? 0;
      $("enabled").checked = !!(s?.enabled);
      $("autoDisable").checked = (s?.autoDisableOnUrlChange !== undefined)
        ? !!s.autoDisableOnUrlChange
        : true; // default ON

      resolve({ tab, settings: s });
    });
  });
}

function ensureContent(tabId) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "ensureContent", tabId }, () => resolve());
  });
}

async function applyToActiveTab() {
  const tab = await getActiveTab();

  // Make sure content.js is present even if you just reloaded the extension.
  await ensureContent(tab.id);

  const seconds = Math.max(1, parseInt($("seconds").value, 10) || 60);
  const jitterPct = Math.max(0, Math.min(100, parseInt($("jitter").value, 10) || 0));
  const enabled = $("enabled").checked;
  const autoDisableOnUrlChange = $("autoDisable").checked;

  const settings = enabled
    ? {
        enabled: true,
        seconds,
        jitterPct,
        autoDisableOnUrlChange,
        lastUrl: tab.url // seed for comparison immediately
      }
    : null; // manual disable clears this tab's entry

  chrome.runtime.sendMessage({ type: "updateSettingsForTab", tabId: tab.id, settings }, () => {
    if (enabled) {
      showStatus(`Enabled: every ${seconds}s (±${jitterPct}%)${autoDisableOnUrlChange ? " • auto-disable on URL change" : ""}`);
    } else {
      $("enabled").checked = false;
      showStatus("Disabled for this tab");
    }
  });
}

async function disableForActiveTab() {
  const tab = await getActiveTab();
  chrome.runtime.sendMessage({ type: "updateSettingsForTab", tabId: tab.id, settings: null }, () => {
    $("enabled").checked = false;
    showStatus("Disabled for this tab");
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadForActiveTab();
  $("apply").addEventListener("click", applyToActiveTab);
  $("disable").addEventListener("click", disableForActiveTab);
  $("enabled").addEventListener("change", () => applyToActiveTab());
  $("autoDisable").addEventListener("change", () => {
    if ($("enabled").checked) applyToActiveTab();
  });
});
