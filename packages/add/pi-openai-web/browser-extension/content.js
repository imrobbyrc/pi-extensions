(() => {
  // Content scripts run in an isolated world. Inject only the small DOM bridge
  // into page context; it reads visible picker controls, never React internals.
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("page-bridge.js");
  script.dataset.piChatgptPickerBridge = "true";
  (document.head || document.documentElement).appendChild(script);
  script.addEventListener("load", () => script.remove(), { once: true });
})();
