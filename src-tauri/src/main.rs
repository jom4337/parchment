// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jo

// Parchment: Tauri shell. The page code is in src/.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{
    AppHandle, DragDropEvent, Emitter, EventTarget, Manager, RunEvent, Theme, Url, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const MAX_BYTES: u64 = 10 * 1024 * 1024;
const READABLE: [&str; 5] = ["md", "markdown", "mdown", "mkd", "txt"];
const IS_MAC: bool = cfg!(target_os = "macos");

// ---- State ---------------------------------------------------------------

#[derive(Default)]
struct Win {
    file: Option<PathBuf>,
    stamp: Option<(SystemTime, u64)>,
    history: Vec<(PathBuf, String)>,
    index: usize,
    ready: bool,
    queue: Vec<(&'static str, Value)>,
    zoom: f64,
}

#[derive(Clone)]
struct MenuHandles {
    reload: MenuItem<Wry>,
    back: MenuItem<Wry>,
    forward: MenuItem<Wry>,
    system: CheckMenuItem<Wry>,
    light: CheckMenuItem<Wry>,
    dim: CheckMenuItem<Wry>,
    dark: CheckMenuItem<Wry>,
}

#[derive(Default)]
struct State {
    wins: Mutex<HashMap<String, Win>>,
    active: Mutex<Option<String>>,
    theme: Mutex<String>,
    next: AtomicUsize,
    menu: Mutex<Option<MenuHandles>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FilePayload {
    path: String,
    name: String,
    base_url: String,
    content: String,
    hash: String,
    reason: &'static str,
}

fn state(app: &AppHandle) -> tauri::State<'_, State> {
    app.state::<State>()
}

fn target(label: &str) -> EventTarget {
    EventTarget::WebviewWindow { label: label.to_string() }
}

// ---- Paths ---------------------------------------------------------------

fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn readable(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| READABLE.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = |c: u8| (c as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn has_scheme(href: &str) -> bool {
    match href.find(':') {
        Some(i) if i > 0 => {
            let s = &href[..i];
            s.chars().next().map_or(false, |c| c.is_ascii_alphabetic())
                && s.chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
        }
        _ => false,
    }
}

fn files_from_args(args: &[String], cwd: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for a in args {
        if a.is_empty() || a.starts_with('-') {
            continue;
        }
        // Linux file managers can pass file:// URLs (desktop entry field %U).
        let p = if a.to_ascii_lowercase().starts_with("file://") {
            match Url::parse(a).ok().and_then(|u| u.to_file_path().ok()) {
                Some(p) => p,
                None => continue,
            }
        } else {
            cwd.join(a)
        };
        let p = normalize(&p);
        if p.is_dir() || out.contains(&p) {
            continue;
        }
        out.push(p);
    }
    out
}

// ---- Reading and showing files ------------------------------------------

fn io_text(e: std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound => "The file does not exist.".into(),
        std::io::ErrorKind::PermissionDenied => "Permission denied.".into(),
        _ => e.to_string(),
    }
}

fn stamp_of(p: &Path) -> Option<(SystemTime, u64)> {
    let m = fs::metadata(p).ok()?;
    Some((m.modified().ok()?, m.len()))
}

fn read_doc(p: &Path) -> Result<String, String> {
    let m = fs::metadata(p).map_err(io_text)?;
    if !m.is_file() {
        return Err("This is not a file.".into());
    }
    if m.len() > MAX_BYTES {
        return Err("The file is larger than 10 MB.".into());
    }
    let buf = fs::read(p).map_err(io_text)?;
    if buf.contains(&0) {
        return Err("The file is not a text file.".into());
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Send an event to one window. Events wait until the page has its listeners.
fn send(app: &AppHandle, label: &str, event: &'static str, value: Value) {
    let st = state(app);
    let mut wins = st.wins.lock().unwrap();
    let Some(w) = wins.get_mut(label) else { return };
    if w.ready {
        let _ = app.emit_to(target(label), event, value);
    } else {
        w.queue.push((event, value));
    }
}

/// Returns true when the window shows the file.
fn show_file(app: &AppHandle, label: &str, path: &Path, hash: &str, reload: bool) -> bool {
    let content = match read_doc(path) {
        Ok(c) => c,
        Err(msg) => {
            if !reload {
                send(app, label, "file-error", json!(format!("{}: {}", file_name(path), msg)));
            }
            return false;
        }
    };
    {
        let st = state(app);
        let mut wins = st.wins.lock().unwrap();
        let Some(w) = wins.get_mut(label) else { return false };
        if reload && w.file.as_deref() != Some(path) {
            return false; // the user went elsewhere
        }
        w.file = Some(path.to_path_buf());
        w.stamp = stamp_of(path);
    }
    let name = file_name(path);
    let base_url = path
        .parent()
        .and_then(|d| Url::from_directory_path(d).ok())
        .map(|u| u.to_string())
        .unwrap_or_default();
    let payload = FilePayload {
        path: path.to_string_lossy().into_owned(),
        name: name.clone(),
        base_url,
        content,
        hash: hash.to_string(),
        reason: if reload { "reload" } else { "open" },
    };
    send(app, label, "file", serde_json::to_value(payload).unwrap_or(Value::Null));
    if !reload {
        if let Some(win) = app.get_webview_window(label) {
            let title = if IS_MAC { name } else { format!("{name} - Parchment") };
            let _ = win.set_title(&title);
        }
    }
    true
}

/// Open a file in a window and add it to that window's history.
fn navigate(app: &AppHandle, label: &str, path: PathBuf, hash: String) {
    if !show_file(app, label, &path, &hash, false) {
        return;
    }
    {
        let st = state(app);
        let mut wins = st.wins.lock().unwrap();
        if let Some(w) = wins.get_mut(label) {
            let keep = if w.history.is_empty() { 0 } else { w.index + 1 };
            w.history.truncate(keep);
            w.history.push((path, hash));
            w.index = w.history.len() - 1;
        }
    }
    refresh_menu(app);
}

fn go(app: &AppHandle, label: &str, delta: isize) {
    let entry = {
        let st = state(app);
        let wins = st.wins.lock().unwrap();
        let Some(w) = wins.get(label) else { return };
        if w.history.is_empty() {
            return;
        }
        let i = w.index as isize + delta;
        if i < 0 || i as usize >= w.history.len() {
            return;
        }
        (i as usize, w.history[i as usize].clone())
    };
    if show_file(app, label, &entry.1 .0, &entry.1 .1, false) {
        let st = state(app);
        let mut wins = st.wins.lock().unwrap();
        if let Some(w) = wins.get_mut(label) {
            w.index = entry.0;
        }
    }
    refresh_menu(app);
}

// ---- Windows -------------------------------------------------------------

fn theme_value(mode: &str) -> Option<Theme> {
    match mode {
        // Low light is a warm light theme, so the native window stays light.
        "light" | "dim" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    }
}

fn create_window(app: &AppHandle) -> Option<String> {
    let st = state(app);
    let label = format!("w{}", st.next.fetch_add(1, Ordering::SeqCst));
    st.wins.lock().unwrap().insert(label.clone(), Win { zoom: 1.0, ..Default::default() });
    let theme = theme_value(&st.theme.lock().unwrap());
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("Parchment")
        .inner_size(960.0, 820.0)
        .min_inner_size(420.0, 320.0)
        .theme(theme)
        .on_navigation(|url| url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost"))
        .build();
    match built {
        Ok(_) => {
            *st.active.lock().unwrap() = Some(label.clone());
            Some(label)
        }
        Err(e) => {
            eprintln!("window: {e}");
            st.wins.lock().unwrap().remove(&label);
            None
        }
    }
}

/// Reuse a window that shows no file. Otherwise make a new one.
fn window_for_new_file(app: &AppHandle) -> Option<String> {
    {
        let st = state(app);
        let active = st.active.lock().unwrap().clone();
        let wins = st.wins.lock().unwrap();
        if let Some(a) = active {
            if wins.get(&a).map_or(false, |w| w.file.is_none()) {
                return Some(a);
            }
        }
        if let Some((l, _)) = wins.iter().find(|(_, w)| w.file.is_none()) {
            return Some(l.clone());
        }
    }
    create_window(app)
}

fn open_paths(app: &AppHandle, paths: Vec<PathBuf>) {
    for p in paths {
        if let Some(label) = window_for_new_file(app) {
            if let Some(win) = app.get_webview_window(&label) {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
            navigate(app, &label, normalize(&p), String::new());
        }
    }
}

/// Run work off the event-loop thread. Building a window there can deadlock on Windows.
fn spawn(app: &AppHandle, f: impl FnOnce(AppHandle) + Send + 'static) {
    let app = app.clone();
    std::thread::spawn(move || f(app));
}

fn pick_files(app: &AppHandle, parent: Option<WebviewWindow>) {
    let mut d = app
        .dialog()
        .file()
        .add_filter("Markdown", &READABLE)
        .add_filter("All files", &["*"]);
    if let Some(w) = &parent {
        d = d.set_parent(w);
    }
    let app2 = app.clone();
    d.pick_files(move |paths| {
        let list: Vec<PathBuf> = paths
            .unwrap_or_default()
            .into_iter()
            .filter_map(|p| p.into_path().ok())
            .collect();
        if !list.is_empty() {
            spawn(&app2, move |app| open_paths(&app, list));
        }
    });
}

// ---- Commands from the page ---------------------------------------------

#[tauri::command]
fn ready(app: AppHandle, window: WebviewWindow) {
    let label = window.label().to_string();
    let theme = state(&app).theme.lock().unwrap().clone();
    let st = state(&app);
    let mut wins = st.wins.lock().unwrap();
    let _ = app.emit_to(target(&label), "theme", theme);
    if let Some(w) = wins.get_mut(&label) {
        w.ready = true;
        for (event, value) in std::mem::take(&mut w.queue) {
            let _ = app.emit_to(target(&label), event, value);
        }
    }
}

#[tauri::command]
fn open_dialog(app: AppHandle, window: WebviewWindow) {
    pick_files(&app, Some(window));
}

#[tauri::command]
async fn open_dropped(app: AppHandle, window: WebviewWindow, paths: Vec<String>) {
    let mut list: Vec<PathBuf> = paths.into_iter().filter(|p| !p.is_empty()).take(20).map(PathBuf::from).collect();
    if list.is_empty() {
        return;
    }
    let first = list.remove(0);
    navigate(&app, window.label(), normalize(&first), String::new());
    open_paths(&app, list);
}

#[tauri::command]
async fn open_link(app: AppHandle, window: WebviewWindow, href: String) {
    if href.len() > 4096 {
        return;
    }
    if has_scheme(&href) {
        let lower = href.to_ascii_lowercase();
        if lower.starts_with("http:") || lower.starts_with("https:") || lower.starts_with("mailto:") {
            let _ = app.opener().open_url(href, None::<&str>);
        }
        return;
    }
    let label = window.label().to_string();
    let current = {
        let st = state(&app);
        let wins = st.wins.lock().unwrap();
        wins.get(&label).and_then(|w| w.file.clone())
    };
    let Some(current) = current else { return };
    let (raw, hash) = href.split_once('#').unwrap_or((&href, ""));
    let raw = raw.split('?').next().unwrap_or("");
    if raw.is_empty() {
        return;
    }
    let dir = current.parent().unwrap_or(Path::new("/"));
    let target_path = normalize(&dir.join(percent_decode(raw)));
    if readable(&target_path) {
        navigate(&app, &label, target_path, hash.to_string());
    } else if target_path.exists() {
        let _ = app.opener().reveal_item_in_dir(&target_path); // never run a file from a link
    }
}

#[tauri::command]
fn copy_text(app: AppHandle, text: String) {
    if text.len() <= 1_000_000 {
        let _ = app.clipboard().write_text(text);
    }
}

// ---- Settings ------------------------------------------------------------

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

fn load_theme(app: &AppHandle) -> String {
    settings_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("theme").and_then(|t| t.as_str()).map(String::from))
        .filter(|t| ["system", "light", "dim", "dark"].contains(&t.as_str()))
        .unwrap_or_else(|| "system".into())
}

fn set_theme(app: &AppHandle, mode: &str) {
    *state(app).theme.lock().unwrap() = mode.to_string();
    if let Some(p) = settings_path(app) {
        if let Some(d) = p.parent() {
            let _ = fs::create_dir_all(d);
        }
        let _ = fs::write(p, json!({ "theme": mode }).to_string()); // a failed write only loses the choice
    }
    for win in app.webview_windows().values() {
        let _ = win.set_theme(theme_value(mode));
    }
    let labels: Vec<String> = state(app).wins.lock().unwrap().keys().cloned().collect();
    for l in labels {
        send(app, &l, "theme", json!(mode));
    }
    refresh_menu(app);
}

// ---- Menu ----------------------------------------------------------------

fn build_menu(app: &AppHandle, theme: &str) -> tauri::Result<(Menu<Wry>, MenuHandles)> {
    let sep = || PredefinedMenuItem::separator(app);
    let open = MenuItem::with_id(app, "open", "Open\u{2026}", true, Some("CmdOrCtrl+O"))?;
    let reload = MenuItem::with_id(app, "reload", "Reload", false, Some("CmdOrCtrl+R"))?;
    let close = MenuItem::with_id(app, "close", "Close Window", true, Some("CmdOrCtrl+W"))?;
    let quit = MenuItem::with_id(
        app,
        "quit",
        if IS_MAC { "Quit Parchment" } else { "Quit" },
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    let back = MenuItem::with_id(app, "back", "Back", false, Some("CmdOrCtrl+BracketLeft"))?;
    let forward = MenuItem::with_id(app, "forward", "Forward", false, Some("CmdOrCtrl+BracketRight"))?;
    let system = CheckMenuItem::with_id(app, "theme-system", "Match System", true, theme == "system", None::<&str>)?;
    let light = CheckMenuItem::with_id(app, "theme-light", "Light", true, theme == "light", None::<&str>)?;
    let dim = CheckMenuItem::with_id(app, "theme-dim", "Low Light", true, theme == "dim", None::<&str>)?;
    let dark = CheckMenuItem::with_id(app, "theme-dark", "Dark", true, theme == "dark", None::<&str>)?;
    let zoom_reset = MenuItem::with_id(app, "zoom-reset", "Actual Size", true, Some("CmdOrCtrl+Digit0"))?;
    let zoom_in = MenuItem::with_id(app, "zoom-in", "Zoom In", true, Some("CmdOrCtrl+Equal"))?;
    let zoom_out = MenuItem::with_id(app, "zoom-out", "Zoom Out", true, Some("CmdOrCtrl+Minus"))?;

    let (s1, s2, s3, s4) = (sep()?, sep()?, sep()?, sep()?);
    let mut file_items: Vec<&dyn IsMenuItem<Wry>> = vec![&open, &s1, &reload, &s2, &close];
    if !IS_MAC {
        file_items.push(&s3);
        file_items.push(&quit);
    }
    let file = Submenu::with_items(app, "File", true, &file_items)?;
    let copy = PredefinedMenuItem::copy(app, None)?;
    let select_all = PredefinedMenuItem::select_all(app, None)?;
    let edit = Submenu::with_items(app, "Edit", true, &[&copy, &select_all])?;
    let appearance = Submenu::with_items(app, "Appearance", true, &[&system, &light, &dim, &dark])?;
    let (v1, v2) = (sep()?, sep()?);
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[&back, &forward, &v1, &appearance, &v2, &zoom_reset, &zoom_in, &zoom_out],
    )?;

    let menu = Menu::new(app)?;
    #[cfg(target_os = "macos")]
    {
        let app_menu = Submenu::with_items(
            app,
            "Parchment",
            true,
            &[
                &PredefinedMenuItem::about(app, None, None)?,
                &sep()?,
                &PredefinedMenuItem::services(app, None)?,
                &sep()?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &sep()?,
                &quit,
            ],
        )?;
        menu.append(&app_menu)?;
    }
    menu.append(&file)?;
    menu.append(&edit)?;
    menu.append(&view)?;
    #[cfg(target_os = "macos")]
    {
        let window_menu = Submenu::with_items(
            app,
            "Window",
            true,
            &[
                &PredefinedMenuItem::minimize(app, None)?,
                &PredefinedMenuItem::maximize(app, None)?,
                &sep()?,
                &PredefinedMenuItem::fullscreen(app, None)?,
            ],
        )?;
        menu.append(&window_menu)?;
    }
    let _ = (&s3, &quit, &s4);
    Ok((menu, MenuHandles { reload, back, forward, system, light, dim, dark }))
}

fn refresh_menu(app: &AppHandle) {
    let st = state(app);
    let active = st.active.lock().unwrap().clone();
    let (has_file, can_back, can_fwd) = {
        let wins = st.wins.lock().unwrap();
        active
            .as_ref()
            .and_then(|l| wins.get(l))
            .map(|w| {
                let n = w.history.len();
                (w.file.is_some(), n > 0 && w.index > 0, n > 0 && w.index + 1 < n)
            })
            .unwrap_or_default()
    };
    let theme = st.theme.lock().unwrap().clone();
    // Menu calls wait for the main thread. Hold no lock while making them.
    let menu = st.menu.lock().unwrap().clone();
    if let Some(m) = menu {
        let _ = m.reload.set_enabled(has_file);
        let _ = m.back.set_enabled(can_back);
        let _ = m.forward.set_enabled(can_fwd);
        let _ = m.system.set_checked(theme == "system");
        let _ = m.light.set_checked(theme == "light");
        let _ = m.dim.set_checked(theme == "dim");
        let _ = m.dark.set_checked(theme == "dark");
    }
}

fn on_menu(app: &AppHandle, id: &str) {
    let active = state(app).active.lock().unwrap().clone();
    let win = active.as_ref().and_then(|l| app.get_webview_window(l));
    match id {
        "open" => pick_files(app, win),
        "reload" => {
            if let Some(l) = active {
                spawn(app, move |app| {
                    let file = state(&app).wins.lock().unwrap().get(&l).and_then(|w| w.file.clone());
                    if let Some(f) = file {
                        show_file(&app, &l, &f, "", true);
                    }
                });
            }
        }
        "back" | "forward" => {
            if let Some(l) = active {
                let delta = if id == "back" { -1 } else { 1 };
                spawn(app, move |app| go(&app, &l, delta));
            }
        }
        "theme-system" => set_theme(app, "system"),
        "theme-light" => set_theme(app, "light"),
        "theme-dim" => set_theme(app, "dim"),
        "theme-dark" => set_theme(app, "dark"),
        "zoom-reset" | "zoom-in" | "zoom-out" => {
            let (Some(l), Some(w)) = (active, win) else { return };
            let st = state(app);
            let mut wins = st.wins.lock().unwrap();
            if let Some(s) = wins.get_mut(&l) {
                s.zoom = match id {
                    "zoom-in" => (s.zoom * 1.1).min(3.0),
                    "zoom-out" => (s.zoom / 1.1).max(0.5),
                    _ => 1.0,
                };
                let _ = w.set_zoom(s.zoom);
            }
        }
        "close" => {
            if let Some(w) = win {
                let _ = w.close();
            }
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

// ---- Window events -------------------------------------------------------

fn on_window_event(app: &AppHandle, label: &str, event: &WindowEvent) {
    match event {
        WindowEvent::Focused(true) => {
            *state(app).active.lock().unwrap() = Some(label.to_string());
            refresh_menu(app);
        }
        WindowEvent::Destroyed => {
            let st = state(app);
            let next = {
                let mut wins = st.wins.lock().unwrap();
                wins.remove(label);
                wins.keys().next().cloned()
            };
            let mut active = st.active.lock().unwrap();
            if active.as_deref() == Some(label) {
                *active = next;
            }
            drop(active);
            refresh_menu(app);
        }
        WindowEvent::DragDrop(DragDropEvent::Enter { .. }) => send(app, label, "drag", json!(true)),
        WindowEvent::DragDrop(DragDropEvent::Leave) => send(app, label, "drag", json!(false)),
        WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
            send(app, label, "drag", json!(false));
            let mut list: Vec<PathBuf> = paths.iter().take(20).cloned().collect();
            if list.is_empty() {
                return;
            }
            let label = label.to_string();
            spawn(app, move |app| {
                let first = list.remove(0);
                navigate(&app, &label, normalize(&first), String::new());
                open_paths(&app, list);
            });
        }
        _ => {}
    }
}

// ---- Live reload ---------------------------------------------------------
// Polling works when an editor saves by replacing the file (vi, many others).

fn watch_loop(app: AppHandle) {
    loop {
        std::thread::sleep(Duration::from_millis(400));
        let changed: Vec<(String, PathBuf)> = {
            let st = state(&app);
            let mut wins = st.wins.lock().unwrap();
            let mut out = Vec::new();
            for (label, w) in wins.iter_mut() {
                let Some(f) = w.file.clone() else { continue };
                let now = stamp_of(&f);
                if now.is_some() && now != w.stamp {
                    w.stamp = now; // try each change once
                    out.push((label.clone(), f));
                }
            }
            out
        };
        for (label, f) in changed {
            show_file(&app, &label, &f, "", true);
        }
    }
}

// ---- Start-up ------------------------------------------------------------

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let files = files_from_args(argv.get(1..).unwrap_or(&[]), Path::new(&cwd));
            if files.is_empty() {
                if let Some(w) = app.webview_windows().values().next() {
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                } else {
                    spawn(app, |app| {
                        create_window(&app);
                    });
                }
            } else {
                spawn(app, move |app| open_paths(&app, files));
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(State::default())
        .invoke_handler(tauri::generate_handler![ready, open_dialog, open_dropped, open_link, copy_text])
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .on_window_event(|window, event| on_window_event(window.app_handle(), window.label(), event))
        .setup(|app| {
            let handle = app.handle().clone();
            let theme = load_theme(&handle);
            *state(&handle).theme.lock().unwrap() = theme.clone();
            let (menu, handles) = build_menu(&handle, &theme)?;
            app.set_menu(menu)?;
            *state(&handle).menu.lock().unwrap() = Some(handles);

            let w = handle.clone();
            std::thread::spawn(move || watch_loop(w));

            let args: Vec<String> = std::env::args().skip(1).collect();
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
            let files = files_from_args(&args, &cwd);
            // The first window opens now. Files load into it when its page is ready.
            create_window(&handle);
            if !files.is_empty() {
                spawn(&handle, move |app| open_paths(&app, files));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to start Parchment");

    app.run(|app, event| match event {
        #[cfg(target_os = "macos")]
        RunEvent::Opened { urls } => {
            // Finder "Open With", Dock drop, and `open -a Parchment file.md`.
            let files: Vec<PathBuf> = urls.into_iter().filter_map(|u| u.to_file_path().ok()).collect();
            spawn(app, move |app| open_paths(&app, files));
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { has_visible_windows, .. } => {
            if !has_visible_windows {
                spawn(app, |app| {
                    create_window(&app);
                });
            }
        }
        RunEvent::ExitRequested { code, api, .. } => {
            // macOS apps stay open with no windows. Quit from the menu passes a code.
            if IS_MAC && code.is_none() {
                api.prevent_exit();
            }
        }
        _ => {
            let _ = app;
        }
    });
}
