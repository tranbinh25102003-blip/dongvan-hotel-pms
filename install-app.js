(() => {
  "use strict";
  const standalone = window.matchMedia("(display-mode: standalone)");
  const dialog = document.querySelector("#install-guide");
  let promptEvent;
  const reflect = () => {
    document.documentElement.classList.toggle("installed-pms", standalone.matches || navigator.standalone === true);
  };
  reflect();
  standalone.addEventListener?.("change", reflect);
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    promptEvent = event;
  });
  window.addEventListener("appinstalled", () => {
    promptEvent = undefined;
    document.documentElement.classList.add("installed-pms");
    if (dialog.open) dialog.close();
  });
  document.addEventListener("click", async event => {
    if (!event.target.closest("[data-install-pms]")) return;
    const install = promptEvent;
    promptEvent = undefined;
    if (install) {
      try {
        await install.prompt();
        await install.userChoice;
        return;
      } catch { /* The browser can expire the installation prompt. */ }
    }
    if (!dialog.open) dialog.showModal();
  });
})();
