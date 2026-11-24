# Parchment

A Markdown reader for local files. It has a clean sans-serif layout with a teal accent. It has four themes: Light, Low light, Dark, and E-ink.

Parchment is a Tauri app. The package is about 2.3 MB as a `.deb` and 5.6 MB installed. It uses the web engine that the OS already has: WebKit on macOS, WebKitGTK on Linux, and WebView2 on Windows.

It also builds to one HTML file that works in any browser.

## Build the Tauri app

You need Node 20 or newer and Rust 1.80 or newer (`https://rustup.rs`).

On macOS, you also need the Xcode Command Line Tools (`xcode-select --install`).

On Ubuntu or Pop!_OS, you also need these packages:

```
sudo apt install build-essential libwebkit2gtk-4.1-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

Then build:

```
npm install
npm run tauri:mac      # macOS: .app and .dmg
npm run tauri:linux    # Linux: .deb and .rpm
npm run tauri:win      # Windows: installer
```

The output is in `src-tauri/target/release/bundle/`. The first build compiles about 400 Rust crates and takes several minutes. Later builds take about 1 minute.

### macOS

Copy `bundle/macos/Parchment.app` to `/Applications`. The build signs the app ad hoc (`signingIdentity: "-"` in `src-tauri/tauri.conf.json`). This is not a Developer ID signature. A copy you download from another computer can show a Gatekeeper warning. To clear it:

```
xattr -dr com.apple.quarantine /Applications/Parchment.app
```

### Linux

```
sudo apt install ./src-tauri/target/release/bundle/deb/Parchment_1.3.0_amd64.deb
```

The package depends on `libwebkit2gtk-4.1-0` and `libgtk-3-0`. Ubuntu 24.04 and Pop!_OS 24.04 include them. The package registers Parchment for `text/markdown`, so Open With in the file manager works.

`npm run tauri:appimage` builds an AppImage. An AppImage must carry its own copy of WebKitGTK, so it is about 80 MB. Use the `.deb` or `.rpm` when you can.

## Open a file

- Press `Cmd+O` (`Ctrl+O` on Windows and Linux).
- Drag a file onto the window or onto the Dock icon.
- Run `open -a Parchment notes.md` (macOS) or `parchment notes.md` (Linux).
- In Finder, choose Get Info, then Open with, then Parchment, then Change All. This makes Parchment the default for `.md` files.

The window title shows the file name. Each file opens in an empty window or in a new window. A second launch on Linux or Windows sends its files to the app that is already running.

## What it does

| Feature | Behavior |
| --- | --- |
| Live reload | The view updates when the file changes on disk. The scroll position stays. This works when an editor replaces the file on save, such as vi. |
| Links | A link to another `.md` file opens in the same window. `Cmd+[` and `Cmd+]` go back and forward. Web links open in your browser. Links to other local files show the file in the file manager. |
| Images | Images with a relative path load from the file folder. |
| Code blocks | A language label and a Copy button show on each block. Syntax color is on for about 40 languages. |
| Front matter | YAML front matter shows as a code block. |
| Themes | Light, Low light (a warm light theme for low light: every color keeps blue below red to cut blue light, and the accent is olive), Dark, and E-ink (black on white, no color: bold and borders replace color). Auto follows the system light or dark setting. In the browser version and on Android, the Theme control in the top bar offers all five. In the desktop apps, View > Appearance offers System, Light, Low Light, and Dark. The choice persists. |
| Find | `Cmd+F` opens find. `Enter` or `Cmd+G` goes to the next match, and `Shift+Enter` or `Cmd+Shift+G` to the previous one. `Esc` closes find. It searches text and code blocks, ignores case unless Match case (Aa) is on, opens collapsed sections, and scrolls wide code and tables to the match. It marks up to 10,000 matches. Use `Ctrl` on Windows and Linux. |
| Zoom | `Cmd+=`, `Cmd+-`, and `Cmd+0`. |
| Safety | Raw HTML in a file is cleaned before display. Scripts, styles, and forms are removed. The page has a strict content security policy. |

## Browser version

`npm run build` writes `dist/parchment.html`. Open it in any browser, then choose a file or drop one on the page. The top bar has Theme, Find, Open, and Close. `Cmd+F` opens find; a second `Cmd+F` opens the browser's own find. `Cmd+O` on macOS or `Ctrl+O` on other systems also opens a file; the page detects the OS to show the right shortcut. It has no live reload. Relative images do not load because the browser does not give the file path.

## Android

The Android app is a small WebView that shows the browser version (`dist/parchment.html`). It has all five themes, including E-ink, in the top bar. It needs Android 8.0 or newer.

- Open a file with Open file, or from a file manager with Open with. Share a `.md` file or text to Parchment from another app.
- The status and navigation bars take the page color of the theme.
- The open file stays open after a dark mode switch or a screen rotation.
- As in the browser version, there is no live reload, and relative images and links to other `.md` files do not work, because Android gives the app a file, not a folder.
- Some file managers give `.md` files no Markdown type. Then Parchment is not in Open with; use Open file in the app.

### Build the APK

GitHub Actions builds the signed APK: `gh workflow run build-android.yml -f tag=vX.Y.Z`, then `gh run download RUN --dir ../ci-X.Y.Z`. The APK is `Parchment_X.Y.Z.apk`.

The workflow needs two repository secrets, made once from your own release key:

| Secret | Value |
| --- | --- |
| `PARCHMENT_KEYSTORE_BASE64` | The keystore file, base64-encoded |
| `PARCHMENT_KEYSTORE_PASSWORD` | The keystore password |

The key alias is `parchment`. Android accepts an update only if it has the same key as the installed app. Keep a backup of the keystore and its password outside the repository.

A local test build needs the Android SDK, JDK 17, and Gradle 8.9 or newer: `npm run build`, then `gradle -p android :app:assembleDebug`. A debug APK has a different key, so uninstall the release app first.

## Not included

- Math, Mermaid diagrams, and footnotes
- Files larger than 10 MB

## Files

| Path | Purpose |
| --- | --- |
| `src/render.js` | Markdown to safe HTML |
| `src/styles.css` | All visual style |
| `src/app.js` | Page behavior: drop, links, copy |
| `src/find.js` | Find in the document |
| `src/tauri-bridge.js` | Connects the page to the Tauri main process |
| `src-tauri/src/main.rs` | Tauri main process: windows, menus, file access, live reload |
| `src-tauri/tauri.conf.json` | Tauri settings: CSP, file associations, bundles |
| `android/` | Android app: `MainActivity.java` (WebView, Open with, Share, file picker), manifest, Gradle build |
| `.github/workflows/build-android.yml` | Builds and signs the APK for a tag |
| `scripts/build.js` | Bundles `src/` into `renderer-tauri/` (Tauri) and `dist/parchment.html` |

## Fonts

Text uses the system sans-serif face: SF Pro on macOS, Segoe UI on Windows, and the desktop default on Linux. Code uses the system monospace face. No fonts are bundled.

## Contrast

In Light, Low light, and Dark, all text and syntax colors meet WCAG AA (4.5:1 or more) against their background. Code comments are among the lowest: 4.6:1 in Light, 5.6:1 in Low light, and 5.4:1 in Dark. E-ink is 21:1.

## License

Parchment is free software. You can use, study, change, and share it under the terms of the GNU Affero General Public License, version 3 or (at your option) any later version. See [LICENSE](LICENSE).

Parchment comes with no warranty.
