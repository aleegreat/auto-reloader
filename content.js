// Guard against duplicate injection if we both declared and programmatically inject.
// If a fresh copy is injected while this one is still healthy, it must bail out.
// If this instance detects its extension context died (extension reloaded/updated),
// it clears the flag so the fresh copy can take over.
if (window.__AUTO_RELOADER_ACTIVE__ &&
    Date.now() - (window.__AUTO_RELOADER_HEARTBEAT__ || 0) < 12000) {
  // A healthy instance is already running; bail out.
} else {
  // Announce takeover so any stale instance stops its timers.
  window.dispatchEvent(new Event("__auto_reloader_takeover__"));
  window.__AUTO_RELOADER_ACTIVE__ = true;
  // Seed the heartbeat immediately so the guard window has no startup gap.
  window.__AUTO_RELOADER_HEARTBEAT__ = Date.now();

  let currentTimer = null;
  let countdownInterval = null;
  let watchdog = null;
  let lastApplied = null; // {enabled, seconds, jitterPct, autoDisableOnDomainChange, autoDisableOnPathChange, lastUrl}
  let myTabId = null;
  let isPaused = false;
  let inactivityTimer = null;
  let lastInteractionTime = Date.now();
  let contextLost = false;
  let retired = false; // true once a newer instance took over

  let currentHref = location.href;

  // ---------- Messaging (always safe) ----------
  // Every chrome.runtime.sendMessage is wrapped: after an extension reload the
  // context becomes invalid and raw calls throw, which previously killed timers.
  function safeSendMessage(msg) {
    return new Promise((resolve) => {
      try {
        if (contextLost || !chrome?.runtime?.id) return resolve(null);
        chrome.runtime.sendMessage(msg, (resp) => {
          void chrome.runtime.lastError; // swallow "receiving end does not exist" etc.
          resolve(resp ?? null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function setBadge(text, title) {
    if (myTabId == null) return;
    void safeSendMessage({ type: "setBadge", tabId: myTabId, text, title });
  }

  // ---------- Helpers ----------
  function clearReloadTimers() {
    if (currentTimer) { clearTimeout(currentTimer); currentTimer = null; }
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  }

  function clearTimerAndBadge() {
    clearReloadTimers();
    if (myTabId != null && !isPaused) setBadge("", "");
  }

  function computeDelaySeconds(seconds, jitterPct) {
    const pct = Math.max(0, Number(jitterPct) || 0) / 100;
    const base = Math.max(1, Math.floor(Number(seconds) || 300));
    const min = base * (1 - pct);
    const max = base * (1 + pct);
    // Clamp to setTimeout's 32-bit limit (~24.8 days); larger delays fire immediately.
    return Math.max(1, Math.min(2147483, Math.round(min + Math.random() * (max - min))));
  }

  function startCountdown(delaySec) {
    let remaining = delaySec;
    // README format: 59s, 2m5s, 1h0m7s
    const format = (n) => {
      if (n > 9999) return "∞";
      const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), s = n % 60;
      return h > 0 ? `${h}h${m}m${s}s` : m > 0 ? `${m}m${s}s` : `${s}s`;
    };

    const tick = () => {
      setBadge(format(remaining), `Reload in ${remaining}s`);
      remaining -= 1;
      if (remaining < 0) {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }
    };

    tick();
    countdownInterval = setInterval(tick, 1000);
  }

  function handleUserInteraction() {
    lastInteractionTime = Date.now();
    // No side effects on tabs where reloading isn't enabled.
    if (retired || !lastApplied?.enabled) return;
    if (!isPaused) {
      isPaused = true;
      clearReloadTimers();
      setBadge("⏸", "Paused - will resume after 1 minute of inactivity");
    }

    // Reset inactivity timer
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      inactivityTimer = null;
      isPaused = false;
      if (lastApplied?.enabled) {
        scheduleReload(lastApplied.seconds, lastApplied.jitterPct);
      }
    }, 1 * 60 * 1000); // 1 minute
  }

  function scheduleReload(seconds, jitterPct) {
    if (retired || isPaused) return;

    const delaySec = computeDelaySeconds(seconds, jitterPct);

    if (currentTimer) clearTimeout(currentTimer);
    currentTimer = setTimeout(() => {
      currentTimer = null;
      try { location.reload(); } catch (e) { /* ignore */ }
      // If reload() somehow didn't navigate (rare), force navigation as fallback.
      setTimeout(() => {
        try { location.reload(); } catch (e) { /* ignore */ }
      }, 2000);
    }, delaySec * 1000);

    startCountdown(delaySec);
  }

  async function getMyTabId() {
    const resp = await safeSendMessage({ type: "getTabId" });
    return resp?.tabId ?? null;
  }

  async function loadSettingsForTab(tabId) {
    const resp = await safeSendMessage({ type: "getSettingsForTab", tabId });
    return resp?.settings ?? null;
  }

  async function updateSettingsForTab(settings, opts = { silent: false }) {
    if (myTabId == null) return;
    await safeSendMessage({
      type: "updateSettingsForTab",
      tabId: myTabId,
      settings,
      silent: !!opts.silent
    });
  }

  async function disableDueToUrlChange(newHref) {
    if (!lastApplied) return;
    clearReloadTimers(); // stop any pending reload immediately, before async I/O
    const newSettings = { ...lastApplied, enabled: false, lastUrl: newHref };
    await updateSettingsForTab(newSettings, { silent: true }); // avoid echo -> reset
    applySettings(newSettings);
  }

  function applySettings(settings) {
    if (retired) return;
    if (settings) {
      // Migrate legacy single toggle (autoDisableOnUrlChange) to the two new
      // options. The old toggle meant "disable on any URL change", so map it
      // to BOTH new options. (Note: query/hash-only changes no longer disable
      // reloading — intentional narrowing of the new design.)
      if (settings.autoDisableOnUrlChange !== undefined &&
          settings.autoDisableOnDomainChange === undefined &&
          settings.autoDisableOnPathChange === undefined) {
        const legacy = !!settings.autoDisableOnUrlChange;
        const { autoDisableOnUrlChange: _dropped, ...rest } = settings;
        settings = { ...rest, autoDisableOnDomainChange: legacy, autoDisableOnPathChange: legacy };
      }
      // Defaults: domain/IP change ON, path change OFF
      settings = { autoDisableOnDomainChange: true, autoDisableOnPathChange: false, ...settings };
    } else {
      settings = null;
    }

    lastApplied = settings;

    // An explicit apply from the popup is a fresh user intent: reset pause state
    // so a stale "paused" flag can never silently block reloading forever.
    isPaused = false;
    if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null; }

    clearTimerAndBadge();
    if (!settings) return;

    // If enabled and URL drifted (per the two options) since last time, auto-disable
    if (settings.enabled && settings.lastUrl &&
        urlChangeTriggersDisable(settings.lastUrl, location.href, settings)) {
      void disableDueToUrlChange(location.href);
      return;
    }

    if (settings.enabled) {
      ensureAttached();
      startWatchdog();
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
  // Decide whether an URL change should disable reloading, based on the two
  // independent options: domain/IP (host) change and path change.
  // Query/hash-only changes never trigger a disable.
  function urlChangeTriggersDisable(oldHref, newHref, settings) {
    if (!settings?.autoDisableOnDomainChange && !settings?.autoDisableOnPathChange) {
      return false;
    }
    try {
      const a = new URL(oldHref);
      const b = new URL(newHref);
      if (settings.autoDisableOnDomainChange) {
        // Compare host (includes port). Scheme-only changes (e.g. an
        // http -> https upgrade on the same host) do NOT trigger.
        // file:// URLs have no host: treat switching between file:// and a
        // real origin as a domain change, but never compare file:// hosts.
        const fileSwitch = (a.protocol === "file:") !== (b.protocol === "file:");
        if (fileSwitch || (a.protocol !== "file:" && a.host !== b.host)) return true;
      }
      if (settings.autoDisableOnPathChange && a.pathname !== b.pathname) return true;
      return false;
    } catch (e) {
      // Unparseable URL: fall back to any-change behavior.
      return oldHref !== newHref;
    }
  }

  function handleUrlMaybeChanged() {
    if (retired) return;
    const newHref = location.href;
    const oldHref = currentHref;
    if (newHref === oldHref) return;
    currentHref = newHref;

    if (lastApplied?.enabled && urlChangeTriggersDisable(oldHref, newHref, lastApplied)) {
      void disableDueToUrlChange(newHref);
    }
  }

  // ---------- Watchdog ----------
  // Periodically self-heal:
  //  1) If reloading should be active but the timer vanished, re-schedule it.
  //  2) If the extension context died (extension updated/reloaded), clear the
  //     guard flag so a freshly injected copy can take over, and keep the
  //     reload timer running so the user's schedule is not lost.
  function startWatchdog() {
    if (watchdog || retired) return;
    watchdog = setInterval(async () => {
      try {
        if (retired) { clearInterval(watchdog); watchdog = null; return; }
        window.__AUTO_RELOADER_HEARTBEAT__ = Date.now();
        if (!chrome?.runtime?.id) {
          if (!contextLost) {
            contextLost = true;
            window.__AUTO_RELOADER_ACTIVE__ = false; // let fresh injection take over
            if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
            // keep currentTimer: the pending reload should still happen
          }
          return;
        }
        // Boot failed earlier (SW was cold): keep retrying until we get a tab id.
        if (myTabId == null) {
          myTabId = await getMyTabId();
          if (myTabId != null && !retired) {
            applySettings(await loadSettingsForTab(myTabId));
          }
          return;
        }
        if (lastApplied?.enabled && !isPaused && currentTimer == null && countdownInterval == null) {
          scheduleReload(lastApplied.seconds, lastApplied.jitterPct);
        }
      } catch (e) { /* never let watchdog die */ }
    }, 5000);
  }

  // A newer instance was injected (e.g., after extension reload): retire.
  window.addEventListener("__auto_reloader_takeover__", () => {
    retired = true;
    clearReloadTimers();
    if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null; }
    if (watchdog) { clearInterval(watchdog); watchdog = null; }
  });

  // ---------- Listeners (registered lazily, only once reloading matters) ----------
  // Patches happen in the MAIN world (content-main.js): the isolated world
  // cannot see page-side pushState/replaceState calls, but DOM events cross.
  let attached = false;
  function ensureAttached() {
    if (attached) return;
    attached = true;
    window.addEventListener("keydown", handleUserInteraction);
    window.addEventListener("mousedown", handleUserInteraction);
    window.addEventListener("popstate", handleUrlMaybeChanged);
    window.addEventListener("hashchange", handleUrlMaybeChanged);
    window.addEventListener("__auto_reloader_url_changed__", handleUrlMaybeChanged);
  }

  // ---------- Boot (with retries: SW may be starting up) ----------
  (async () => {
    for (let attempt = 0; attempt < 5 && myTabId == null; attempt++) {
      myTabId = await getMyTabId();
      if (myTabId == null) await new Promise((r) => setTimeout(r, 1000));
    }
    if (retired) return;
    if (!myTabId) {
      // Still can't talk to background; watchdog will keep retrying.
      startWatchdog();
      return;
    }

    const settings = await loadSettingsForTab(myTabId);
    if (retired) return;
    applySettings(settings); // starts watchdog itself when enabled
  })();

  // Live updates from popup/background
  chrome.runtime.onMessage.addListener((msg) => {
    if (retired) return;
    if (msg?.type === "applySettings") {
      applySettings(msg.settings || null);
    }
  });
}
