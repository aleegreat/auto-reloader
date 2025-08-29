// Guard against duplicate injection if we both declared and programmatically inject.
if (window.__AUTO_RELOADER_ACTIVE__) {
  // Already running on this page.
} else {
  window.__AUTO_RELOADER_ACTIVE__ = true;

  let currentTimer = null;
  let countdownInterval = null;
  let lastApplied = null; // {enabled, seconds, jitterPct, autoDisableOnUrlChange, lastUrl}
  let myTabId = null;

  let currentHref = location.href;

  // ---------- Helpers ----------
  function clearTimerAndBadge() {
    if (currentTimer) { clearTimeout(currentTimer); currentTimer = null; }
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    if (myTabId != null) {
      chrome.runtime.sendMessage({ type: "setBadge", tabId: myTabId, text: "", title: "" });
    }
  }

  function computeDelaySeconds(seconds, jitterPct) {
    const pct = Math.max(0, Number(jitterPct) || 0) / 100;
    const base = Math.max(1, Math.floor(Number(seconds) || 60));
    const min = base * (1 - pct);
    const max = base * (1 + pct);
    return Math.max(1, Math.round(min + Math.random() * (max - min)));
  }

  function startCountdown(delaySec) {
    let remaining = delaySec;
    const format = (n) => (n > 9999 ? "∞" : String(n));

    const tick = () => {
      if (myTabId != null) {
        chrome.runtime.sendMessage({
          type: "setBadge",
          tabId: myTabId,
          text: format(remaining),
          title: `Reload in ${remaining}s`
        });
      }
      remaining -= 1;
      if (remaining < 0) {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }
    };

    tick();
    countdownInterval = setInterval(tick, 1000);
  }

  function scheduleReload(seconds, jitterPct) {
    const delaySec = computeDelaySeconds(seconds, jitterPct);

    if (currentTimer) clearTimeout(currentTimer);
    currentTimer = setTimeout(() => {
      try { location.reload(); } catch (e) { location.href = location.href; }
    }, delaySec * 1000);

    startCountdown(delaySec);
  }

  async function getMyTabId() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "getTabId" }, (resp) => {
        resolve(resp?.tabId ?? null);
      });
    });
  }

  async function loadSettingsForTab(tabId) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "getSettingsForTab", tabId }, (resp) => {
        resolve(resp?.settings ?? null);
      });
    });
  }

  function updateSettingsForTab(settings, opts = { silent: false }) {
    return new Promise((resolve) => {
      if (myTabId == null) return resolve();
      chrome.runtime.sendMessage(
        { type: "updateSettingsForTab", tabId: myTabId, settings, silent: !!opts.silent },
        () => resolve()
      );
    });
  }

  async function disableDueToUrlChange(newHref) {
    if (!lastApplied) return;
    const newSettings = { ...lastApplied, enabled: false, lastUrl: newHref };
    await updateSettingsForTab(newSettings, { silent: true }); // avoid echo -> reset
    applySettings(newSettings);
  }

  function applySettings(settings) {
    // Default autoDisable to true if missing
    settings = settings ? { autoDisableOnUrlChange: true, ...settings } : null;

    lastApplied = settings;
    clearTimerAndBadge();
    if (!settings) return;

    // If enabled and URL drifted since last time, auto-disable
    if (settings.enabled && settings.autoDisableOnUrlChange && settings.lastUrl && settings.lastUrl !== location.href) {
      void disableDueToUrlChange(location.href);
      return;
    }

    if (settings.enabled) {
      // Ensure lastUrl stored matches current page, but do it silently to avoid reset loop
      if (settings.lastUrl !== location.href) {
        const merged = { ...settings, lastUrl: location.href };
        lastApplied = merged;
        void updateSettingsForTab(merged, { silent: true });
      }
      scheduleReload(settings.seconds, settings.jitterPct);
    }
  }

  // ---------- URL-change detection (SPA + hash + history APIs) ----------
  function handleUrlMaybeChanged() {
    const newHref = location.href;
    if (newHref === currentHref) return;
    currentHref = newHref;

    if (lastApplied?.enabled && lastApplied?.autoDisableOnUrlChange) {
      void disableDueToUrlChange(newHref);
    }
  }

  window.addEventListener("popstate", handleUrlMaybeChanged);
  window.addEventListener("hashchange", handleUrlMaybeChanged);

  // Patch history to catch pushState/replaceState
  {
    const origPush = history.pushState;
    history.pushState = function (...args) {
      const ret = origPush.apply(this, args);
      handleUrlMaybeChanged();
      return ret;
    };
    const origReplace = history.replaceState;
    history.replaceState = function (...args) {
      const ret = origReplace.apply(this, args);
      handleUrlMaybeChanged();
      return ret;
    };
  }

  // ---------- Boot ----------
  (async () => {
    myTabId = await getMyTabId();
    if (!myTabId) return;

    const settings = await loadSettingsForTab(myTabId);
    applySettings(settings);
  })();

  // Live updates from popup/background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "applySettings") {
      applySettings(msg.settings || null);
    }
  });
}
