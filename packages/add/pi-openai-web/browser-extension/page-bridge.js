(() => {
  const GLOBAL = "__PI_CHATGPT_PICKER_STATE__";
  const visible = (el) => Boolean(el && el.offsetParent !== null);
  const clean = (value) => (value || "").replace(/\s+/g, " ").trim();

  function readPickerState() {
    const models = [...document.querySelectorAll('[role="menuitemradio"]')]
      .filter(visible)
      .map((el) => ({
        browserModelLabel: clean(el.textContent),
        displayName: clean(el.textContent),
        checked: el.getAttribute("aria-checked") === "true"
      }))
      .filter((model) => model.browserModelLabel.length > 0);
    if (!models.length) return;

    const slider = [...document.querySelectorAll('[data-model-reasoning-effort-slider] [role="slider"]')].find(visible);
    const effort = slider
      ? clean(slider.getAttribute("aria-valuetext") || slider.getAttribute("aria-label"))
      : null;
    window[GLOBAL] = {
      source: "pi-chatgpt-picker-extension",
      updatedAt: Date.now(),
      models,
      effort
    };
  }

  const observer = new MutationObserver(readPickerState);
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  readPickerState();
})();
