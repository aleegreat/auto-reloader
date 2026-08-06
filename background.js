// Keeps simple per-tab settings in chrome.storage.session under settingsByTab[tabId]
// (session storage: survives SW restarts, auto-cleared on browser exit so stale
// tab ids can never be reused by a new session)
const SETTINGS_KEY = "settingsByTab";

// ---- Badge helpers ---------------------------------------------------------
async function setBadge(tabId, text, title) {
  try {
    await chrome.action.setBadgeText({ tabId, text: String(text || "") });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#444" });
    if (chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ tabId, color: "#fff" });
    }
    if (title !== undefined) {
      await chrome.action.setTitle({ tabId, title: title || "" });
    }
  } catch (e) {
    // Ignore (e.g., chrome:// pages)
  }
}
async function clearBadge(tabId) {
  await setBadge(tabId, "", "Auto Reloader");
}

// ---- Storage helpers -------------------------------------------------------
async function readSettingsMap() {
  const data = await chrome.storage.session.get(SETTINGS_KEY);
  return data[SETTINGS_KEY] || {};
}
async function writeSettingsMap(map) {
  await chrome.storage.session.set({ [SETTINGS_KEY]: map });
}

// Serialize all read-modify-write cycles so concurrent messages (popup apply,
// silent content writes, tab-closed cleanup) can't overwrite each other.
let settingsQueue = Promise.resolve();
function mutateSettings(fn) {
  settingsQueue = settingsQueue.then(async () => {
    const map = await readSettingsMap();
    const result = fn(map);
    await writeSettingsMap(map);
    return result;
  }, async () => {
    // Previous op failed; retry with a fresh read instead of poisoning the queue.
    const map = await readSettingsMap();
    const result = fn(map);
    await writeSettingsMap(map);
    return result;
  });
  return settingsQueue;
}

// ---- Content injection for already-open tabs -------------------------------
async function ensureContent(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-main.js"],
      world: "MAIN"
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ---- Messaging -------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "getTabId") {
        sendResponse({ tabId: sender?.tab?.id });
        return;
      }

      if (msg?.type === "ensureContent") {
        const r = await ensureContent(msg.tabId);
        sendResponse(r);
        return;
      }

      if (msg?.type === "getSettingsForTab") {
        const map = await readSettingsMap();
        sendResponse({ settings: map[msg.tabId] || null });
        return;
      }

      if (msg?.type === "updateSettingsForTab") {
        const { settings, silent } = msg;
        // Content-script messages: trust sender.tab.id over msg.tabId (defense
        // in depth against cross-tab tampering). Popup has no sender.tab.
        const tabId = sender.tab?.id ?? msg.tabId;

        // Probe injection before persisting: don't store settings that can
        // never take effect (chrome://, Web Store, etc.). The duplicate-
        // injection guard makes this cheap when content is already present.
        if (settings && !silent) {
          const probe = await ensureContent(tabId);
          if (!probe.ok) { sendResponse(probe); return; }
        }

        await mutateSettings((map) => {
          if (settings) {
            map[tabId] = settings;
          } else {
            delete map[tabId];
          }
        });

        // Only echo applySettings when not a 'silent' write
        if (!silent) {
          try {
            await chrome.tabs.sendMessage(tabId, {
              type: "applySettings",
              settings: settings || null
            });
          } catch (e) {
            // Tab may not host content (chrome:// etc.) — ignore
          }
          // content.js was already ensured by the probe above
        }

        // Clear badge when disabling entirely
        if (!settings) await clearBadge(tabId);

        sendResponse({ ok: true });
        return;
      }

      // Content asks us to set the badge each second
      if (msg?.type === "setBadge") {
        const { text, title } = msg;
        await setBadge(sender.tab?.id ?? msg.tabId, text, title);
        sendResponse({ ok: true });
        return;
      }
    } catch (e) {
      try { sendResponse({ ok: false, error: String(e) }); } catch (_) { /* tab gone */ }
    }
  })();

  return true; // respond async
});

// Clean up when a tab is closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await mutateSettings((map) => {
    delete map[tabId];
  });
  await clearBadge(tabId);
});
