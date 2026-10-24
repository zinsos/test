(() => {
  const bridge = window.snypra;

  function byId<T extends HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (node === null) {
      throw new Error(`missing #${id}`);
    }
    return node as T;
  }

  const status = byId<HTMLDivElement>("status");
  const dot = byId<HTMLSpanElement>("dot");
  const label = byId<HTMLSpanElement>("status-label");
  const host = byId<HTMLSpanElement>("host");
  const openWeb = byId<HTMLButtonElement>("open-web");
  const reload = byId<HTMLButtonElement>("reload");
  const settings = byId<HTMLButtonElement>("settings");

  function render(next: ToolbarStatus): void {
    dot.className = `dot ${next.state}`;
    label.textContent = next.label;
    host.textContent = next.host ?? "";
    host.hidden = next.host === null;
    status.title = next.host === null ? next.detail : `${next.detail} (${next.host})`;
    openWeb.disabled = !next.canOpenWeb;
    openWeb.title = next.canOpenWeb ? "Open the dashboard in your browser" : "Available once an https:// address is saved";
    reload.disabled = !next.canReload;
    settings.setAttribute("aria-pressed", String(next.view === "setup"));
    document.title = `snypra-edge: ${next.label}`;
  }

  openWeb.addEventListener("click", () => bridge.action("open-web"));
  reload.addEventListener("click", () => bridge.action("reload"));
  settings.addEventListener("click", () => bridge.action("settings"));
  bridge.onStatus(render);
  bridge.getStatus().then(render, () => undefined);
})();
