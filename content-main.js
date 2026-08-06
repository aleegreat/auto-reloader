// MAIN-world bridge: page-side pushState/replaceState are invisible to the
// isolated world, so patch them here and signal via a DOM event (DOM events
// cross world boundaries). content.js listens for it.
if (!window.__AUTO_RELOADER_MAIN_PATCHED__) {
  window.__AUTO_RELOADER_MAIN_PATCHED__ = true;
  for (const name of ["pushState", "replaceState"]) {
    const orig = history[name];
    history[name] = function (...args) {
      const ret = orig.apply(this, args);
      dispatchEvent(new Event("__auto_reloader_url_changed__"));
      return ret;
    };
  }
}
