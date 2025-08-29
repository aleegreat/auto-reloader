// Keeps simple per-tab settings in chrome.storage.local under settingsByTab[tabId]
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
  await setBadge(tabId, "", "");
}

// ---- Storage helpers -------------------------------------------------------
async function readSettingsMap() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return data[SETTINGS_KEY] || {};
}
async function writeSettingsMap(map) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: map });
}

// ---- Content injection for already-open tabs -------------------------------
async function ensureContent(tabId) {
  try {
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
      const { tabId, settings, silent } = msg;
      const map = await readSettingsMap();

      if (settings) {
        map[tabId] = settings;
      } else {
        delete map[tabId];
      }
      await writeSettingsMap(map);

      // Only echo applySettings when not a 'silent' write
      if (!silent) {
        try {
          await chrome.tabs.sendMessage(tabId, {
            type: "applySettings",
            settings: map[tabId] || null
          });
        } catch (e) {
          // Tab may not host content (chrome:// etc.) — ignore
        }
      }

      // Clear badge when disabling entirely
      if (!settings) await clearBadge(tabId);

      sendResponse({ ok: true });
      return;
    }

    // Content asks us to set the badge each second
    if (msg?.type === "setBadge") {
      const { tabId, text, title } = msg;
      await setBadge(tabId, text, title);
      sendResponse({ ok: true });
      return;
    }
  })();

  return true; // respond async
});

// Clean up when a tab is closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const map = await readSettingsMap();
  if (map[tabId]) {
    delete map[tabId];
    await writeSettingsMap(map);
  }
  await clearBadge(tabId);
});
