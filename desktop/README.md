# snypra-edge desktop

A Windows app that opens the snypra-edge dashboard in its own window. It loads the real dashboard from your server, so the theme, tabs, live feed, charts, exports and actions are exactly the ones in the web version. Above the dashboard a slim toolbar shows:

- the connection status (green when the server's `/healthz` answers, checked every 30 s),
- **Open web version**: opens the same dashboard in your default browser (https addresses only, the token is never put in that link),
- **Reload** (F5 or Ctrl+R),
- **Settings** (Ctrl+,): change the dashboard address or token.

If the dashboard cannot load (for example the Cloudflare quick tunnel restarted and its address changed, or the server is down), the window shows an error page with **Try again** and **Change URL**.

On a phone, use the web version in the phone's browser. This app is only for the PC. A browser keeps its own copy of the token, so the first time the web version opens there it asks for the dashboard token (or open the address once with `?token=` added, as before).

## Install and run

1. Unzip `snypra-edge-win32-x64.zip` into a folder you keep, for example `Documents\snypra-edge`.
2. Open the folder and run `snypra-edge.exe`.
3. The app is not code-signed, so Windows SmartScreen shows "Windows protected your PC" the first time. Click **More info**, then **Run anyway**.
4. To find it again: right-click `snypra-edge.exe` and pick **Pin to taskbar** or **Send to > Desktop (create shortcut)**.

On the first start the app asks for:

- **Dashboard URL**: the https address of the dashboard (the tunnel address). Pasting a link that ends in `?token=...` also fills in the token. Plain `http://` is accepted only for `127.0.0.1` and `localhost`.
- **Dashboard token**: the server's `DASHBOARD_TOKEN`.

**Test and save** calls `GET /healthz` and then `GET /api/rpc` with the token, and explains what is wrong: address unreachable, tunnel address gone, wrong token, not a snypra-edge server. When it passes, the app saves the settings and opens the dashboard.

When the quick tunnel address changes, click **Change URL** (or Settings), paste the new address and leave the token empty to keep the saved one.

Only one copy of the app runs at a time; starting it again brings the open window to the front. The window remembers its size and position.

## Where things are stored

Everything lives in `%APPDATA%\snypra-edge`:

- `config.json`: the dashboard address and the token. The token is encrypted with Windows' data protection (Electron `safeStorage`), so the file is useless on another PC or another Windows account.
- `window-state.json`: window size and position.
- `Partitions\dashboard`: the dashboard's browser storage (its saved token and view preferences).

Delete that folder to reset the app.

## Security

- The dashboard runs in a sandboxed view with context isolation, no Node.js and no preload script. It may only load and request its own address; other links open in your default browser, and only if they are https.
- The app's own pages (toolbar, setup, error) are local files with a strict Content Security Policy and a minimal bridge of five calls; every call is checked in the main process (sender, page and arguments).
- Every permission request (camera, microphone, location, notifications and so on) is refused. The one exception is clipboard writing for the dashboard's copy buttons.
- Downloads are allowed only for files the dashboard itself produces (CSV exports).
- Developer tools are disabled in the packaged app.

## Keyboard

| Keys | Action |
| --- | --- |
| F5, Ctrl+R | Reload |
| Ctrl+, | Settings |
| Ctrl+= / Ctrl+- / Ctrl+0 | Zoom the dashboard in, out, reset |
| Esc | Leave Settings without saving |

## Build it yourself on Windows

You need Node.js 22 or newer.

```bat
cd desktop
npm ci
npm run package
```

The app is written to `desktop\out\snypra-edge-win32-x64\`; run `snypra-edge.exe` from there or zip that folder. Other scripts:

- `npm start`: build and run from source (developer tools allowed).
- `npm test`: unit tests for the address rules, the connection test, settings storage and window placement.
- `npm run typecheck`
- `npm run icon`: redraws `assets/icon.png` and `assets/icon.ico` (the amber underscore mark).

`npm run package` also works on Linux and macOS (the exe icon and version info are written without Wine). If the Electron download fails behind a proxy, download `electron-v45.0.0-win32-x64.zip` from the Electron releases yourself, check it against that release's `SHASUMS256.txt`, and run `node scripts/package.mjs --electron-zip-dir <folder with the zip>` after `npm run build`.

This folder is separate from the main service: it has its own `package.json` and is not part of the root `npm run check`.
