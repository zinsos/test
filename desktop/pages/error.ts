(() => {
  const bridge = window.snypra;
  const params = new URLSearchParams(window.location.search);

  function byId<T extends HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (node === null) {
      throw new Error(`missing #${id}`);
    }
    return node as T;
  }

  const title = params.get("title") ?? "Dashboard unavailable";
  byId<HTMLHeadingElement>("title").textContent = title;
  byId<HTMLParagraphElement>("message").textContent = params.get("message") ?? "The dashboard did not load.";
  byId<HTMLElement>("host").textContent = params.get("host") || "not set";
  byId<HTMLDivElement>("tip").hidden = params.get("code") === "tls";
  document.title = `snypra-edge: ${title}`;

  const retry = byId<HTMLButtonElement>("retry");
  retry.addEventListener("click", () => {
    retry.disabled = true;
    retry.textContent = "Connecting…";
    bridge.action("retry");
  });
  byId<HTMLButtonElement>("change").addEventListener("click", () => bridge.action("change-url"));
  retry.focus();
})();
