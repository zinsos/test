(() => {
  const bridge = window.snypra;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICONS: Record<"good" | "warn" | "bad", string[]> = {
    good: ["M5 12.5l4.5 4.5L19 7.5"],
    warn: ["M12 4.5l8.5 15h-17z", "M12 10v4", "M12 17.2v.1"],
    bad: ["M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17z", "M12 8v5", "M12 16.2v.1"]
  };

  function byId<T extends HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (node === null) {
      throw new Error(`missing #${id}`);
    }
    return node as T;
  }

  const form = byId<HTMLFormElement>("form");
  const heading = byId<HTMLHeadingElement>("heading");
  const note = byId<HTMLDivElement>("note");
  const noteText = byId<HTMLSpanElement>("note-text");
  const url = byId<HTMLInputElement>("url");
  const urlError = byId<HTMLParagraphElement>("url-error");
  const token = byId<HTMLInputElement>("token");
  const tokenHelp = byId<HTMLParagraphElement>("token-help");
  const tokenError = byId<HTMLParagraphElement>("token-error");
  const reveal = byId<HTMLButtonElement>("reveal");
  const result = byId<HTMLDivElement>("result");
  const resultIcon = byId<HTMLSpanElement>("result-icon");
  const resultText = byId<HTMLSpanElement>("result-text");
  const save = byId<HTMLButtonElement>("save");
  const cancel = byId<HTMLButtonElement>("cancel");

  function icon(kind: "good" | "warn" | "bad"): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    for (const d of ICONS[kind]) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  }

  function fieldError(input: HTMLInputElement, target: HTMLParagraphElement, message: string | null): void {
    target.textContent = message ?? "";
    target.hidden = message === null;
    input.setAttribute("aria-invalid", String(message !== null));
  }

  function showResult(kind: "busy" | "good" | "warn" | "bad" | null, message: string): void {
    result.hidden = kind === null;
    result.className = `banner ${kind === "busy" ? "info" : (kind ?? "")}`;
    resultText.textContent = message;
    resultIcon.replaceChildren();
    if (kind === "busy") {
      const spinner = document.createElement("span");
      spinner.className = "spinner";
      resultIcon.append(spinner);
    } else if (kind !== null) {
      resultIcon.append(icon(kind));
    }
  }

  function setBusy(busy: boolean): void {
    save.disabled = busy;
    url.readOnly = busy;
    token.readOnly = busy;
    save.textContent = busy ? "Testing…" : "Test and save";
  }

  function describeStorage(info: SetupInfo): string {
    const where = info.tokenStorage === "encrypted" ? "Stored encrypted by the operating system." : "Stored unencrypted on this computer (system encryption is unavailable).";
    return info.hasToken ? `A token is saved. Leave this blank to keep it. ${where}` : `Paste the DASHBOARD_TOKEN of the server. ${where}`;
  }

  function apply(info: SetupInfo): void {
    if (info.origin !== null) {
      url.value = `${info.origin}/`;
    }
    token.placeholder = info.hasToken ? "Saved (leave blank to keep)" : "Paste the token";
    tokenHelp.textContent = describeStorage(info);
    cancel.hidden = !info.canCancel;
    heading.textContent = info.canCancel ? "Dashboard connection" : "Connect to your dashboard";
    note.hidden = info.note === null;
    noteText.textContent = info.note ?? "";
    (info.origin === null ? url : token).focus();
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (save.disabled) {
      return;
    }
    fieldError(url, urlError, null);
    fieldError(token, tokenError, null);
    setBusy(true);
    showResult("busy", "Testing the connection…");
    bridge
      .saveSetup(url.value, token.value)
      .then((outcome) => {
        if (outcome.ok) {
          token.value = "";
          showResult(outcome.warning === null ? "good" : "warn", outcome.warning === null ? "Connected. Opening the dashboard…" : `${outcome.warning} Opening the dashboard…`);
          return;
        }
        setBusy(false);
        showResult(null, "");
        if (outcome.field === "token") {
          fieldError(token, tokenError, outcome.message);
          token.focus();
        } else {
          fieldError(url, urlError, outcome.message);
          url.focus();
        }
      })
      .catch(() => {
        setBusy(false);
        showResult("bad", "Something went wrong while testing. Try again.");
      });
  });

  reveal.addEventListener("click", () => {
    const visible = token.type === "password";
    token.type = visible ? "text" : "password";
    reveal.setAttribute("aria-pressed", String(visible));
    reveal.setAttribute("aria-label", visible ? "Hide token" : "Show token");
  });

  cancel.addEventListener("click", () => bridge.action("cancel-setup"));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !cancel.hidden) {
      bridge.action("cancel-setup");
    }
  });

  bridge.getSetup().then(apply, () => showResult("bad", "Could not read the saved settings."));
})();
