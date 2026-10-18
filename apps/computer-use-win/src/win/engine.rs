// 分发主进程来的 JSON-RPC 方法，在主线程上依次处理。
// 观察（listApps、getAppState）、动作（七个）、握手与诊断、回合结束、关闭。截图号对应的坐标映射存在这里，
// 坐标动作据它换算并判 stale。
use super::{activity, apps, capture, foreground, hooks, input, overlay, system, uia};
use crate::copy::{self, Language};
use crate::geometry::{Rect, ShotMap};
use crate::ident::integrity_name;
use crate::keys;
use crate::wire::RpcResult;
use crate::{fail, VERSION};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;

/// 用户在目标窗口里动过后，多久内不动作（照 macOS 的 2 秒静默期）
const USER_SILENCE: Duration = Duration::from_secs(2);

/// 一张截图和它覆盖的窗口状态：坐标映射，加截图那一刻窗口的边界（判 stale 用）
struct Shot {
    session: String,
    map: ShotMap,
    frame: Rect,
}

pub struct Engine {
    parent: Option<u32>,
    handshook: bool,
    own_integrity: u32,
    language: Language,
    shots: HashMap<String, Shot>,
    next_shot: u64,
    watchers: bool,
}

impl Engine {
    pub fn new(parent: Option<u32>) -> Engine {
        Engine {
            parent,
            handshook: false,
            own_integrity: system::own_integrity(),
            language: Language::En,
            shots: HashMap::new(),
            next_shot: 1,
            watchers: false,
        }
    }

    pub fn handle(&mut self, method: &str, params: &Value) -> RpcResult<Value> {
        match method {
            "hello" => self.hello(params),
            "diagnostics" => self.diagnostics(),
            "setLanguage" => {
                self.language = copy::language(str_of(params, "lang").as_deref());
                activity::set_language(self.language);
                Ok(json!({}))
            }
            "listApps" => self.list_apps(),
            "getAppState" => self.get_app_state(params),
            "click" => self.click(params),
            "typeText" => self.type_text(params),
            "pressKey" => self.press_key(params),
            "scroll" => self.scroll(params),
            "setValue" => self.set_value(params),
            "drag" => self.drag(params),
            "selectText" => self.select_text(params),
            "turnEnded" => {
                let session = req_str(params, "session")?;
                activity::end_session(&session);
                self.shots.retain(|_, s| s.session != session);
                Ok(json!({}))
            }
            "shutdown" => Ok(json!({})),
            other => Err(fail!(Invalid, "unknown method \"{other}\"")),
        }
    }

    fn hello(&mut self, p: &Value) -> RpcResult<Value> {
        let protocol = p.get("protocol").and_then(Value::as_u64).unwrap_or(0);
        if protocol != crate::wire::PROTOCOL {
            return Err(fail!(Unauthorized, "helper protocol is {}, host asked for {protocol}", crate::wire::PROTOCOL));
        }
        self.language = copy::language(str_of(p, "lang").as_deref());
        activity::set_language(self.language);
        self.handshook = true;
        Ok(json!({
            "protocol": crate::wire::PROTOCOL,
            "pid": std::process::id(),
            "version": VERSION,
            "platform": "win32",
            "integrity": integrity_name(self.own_integrity),
            "uacEnabled": system::uac_enabled(),
        }))
    }

    fn diagnostics(&self) -> RpcResult<Value> {
        let exe = std::env::current_exe().ok().and_then(|p| p.to_str().map(str::to_string)).unwrap_or_default();
        Ok(json!({
            "pid": std::process::id(),
            "parentPid": self.parent,
            "exe": exe,
            "version": VERSION,
            "osVersion": system::os_version(),
            "integrity": integrity_name(self.own_integrity),
            "inputDesktop": system::input_desktop().unwrap_or_else(|| "unknown".into()),
            "dpiAwareness": "perMonitorV2",
            "uia": uia::available(),
            "wgc": capture::wgc_supported(),
            "borderlessCapture": capture::borderless_supported(),
        }))
    }

    fn require_handshake(&self) -> RpcResult<()> {
        if self.handshook {
            Ok(())
        } else {
            Err(fail!(Unauthorized, "call hello before any other request"))
        }
    }

    fn list_apps(&self) -> RpcResult<Value> {
        self.require_handshake()?;
        let apps: Vec<Value> = apps::list()
            .into_iter()
            .map(|a| {
                let windows: Vec<Value> = a
                    .windows
                    .iter()
                    .map(|w| json!({ "id": w.hwnd, "title": w.title, "active": w.active, "minimized": w.minimized }))
                    .collect();
                json!({
                    "appId": a.app_id, "name": a.name, "exe": a.exe, "aumid": a.aumid,
                    "originalFilename": a.original_filename,
                    "pid": a.pid, "active": a.active(), "integrity": integrity_name(a.integrity), "windows": windows,
                })
            })
            .collect();
        Ok(json!({ "apps": apps }))
    }

    /// 起 Esc 钩子和屏幕提示（只起一次）
    fn ensure_watchers(&mut self) {
        if !self.watchers {
            self.watchers = true;
            hooks::start();
            overlay::start();
        }
    }

    fn get_app_state(&mut self, p: &Value) -> RpcResult<Value> {
        self.require_handshake()?;
        let session = req_str(p, "session")?;
        let (app, win) = apps::resolve(&req_str(p, "appId")?, window_id(p))?;
        if crate::baseline::is_forbidden(&app.exe, app.original_filename.as_deref()) {
            return Err(fail!(Forbidden, "{} cannot be used by Litch", app.name));
        }
        self.ensure_watchers();
        activity::begin(&session, &app.app_id, &app.name, win.hwnd);
        let hwnd = apps::hwnd(win.hwnd);
        if win.minimized {
            apps::restore(hwnd);
            std::thread::sleep(Duration::from_millis(80));
        }

        let want_shot = p.get("screenshot").and_then(Value::as_bool).unwrap_or(true);
        let max_nodes = p.get("maxNodes").and_then(Value::as_u64).unwrap_or(800) as usize;
        let max_depth = p.get("maxDepth").and_then(Value::as_u64).unwrap_or(25) as u32;
        let mut notes: Vec<String> = vec![];

        let frame = apps::bounds(hwnd);
        let (map, screenshot) = if want_shot {
            match capture::window(hwnd, app.pid, &mut notes) {
                Some((image, area)) => {
                    let map = ShotMap::for_window(area);
                    let data = capture::jpeg(&image, &map).map_err(|e| fail!(Failed, "could not encode the screenshot: {e}"))?;
                    let id = self.store_shot(&session, map, frame);
                    let shot = json!({ "id": id.to_string(), "mime": "image/jpeg", "data": STANDARD.encode(&data), "width": map.width, "height": map.height });
                    (map, shot)
                }
                None => {
                    notes.push("Could not capture a screenshot of this window.".into());
                    (ShotMap::for_window(frame), Value::Null)
                }
            }
        } else {
            (ShotMap::for_window(frame), Value::Null)
        };

        let (tree, truncated) = uia::read_tree(hwnd, &map, max_nodes, max_depth, &mut notes)?;
        let windows: Vec<Value> = app.windows.iter().map(|w| json!({ "id": w.hwnd, "title": w.title })).collect();
        Ok(json!({
            "app": { "appId": app.app_id, "name": app.name, "exe": app.exe, "aumid": app.aumid, "pid": app.pid },
            "window": { "id": win.hwnd, "title": win.title, "width": map.width, "height": map.height },
            "windows": windows,
            "screenshot": screenshot,
            "tree": tree,
            "truncated": truncated,
            "notes": notes,
        }))
    }

    fn store_shot(&mut self, session: &str, map: ShotMap, frame: Rect) -> u64 {
        let id = self.next_shot;
        self.next_shot += 1;
        self.shots.insert(id.to_string(), Shot { session: session.into(), map, frame });
        id
    }

    /// 动作前的统一关卡：禁区、管理员、被 Esc 停、锁屏、用户在动；过了就登记并回窗口句柄
    fn guard(&mut self, p: &Value) -> RpcResult<(super::apps::App, super::apps::Win)> {
        self.require_handshake()?;
        let session = req_str(p, "session")?;
        let (app, win) = apps::resolve(&req_str(p, "appId")?, window_id(p))?;
        if crate::baseline::is_forbidden(&app.exe, app.original_filename.as_deref()) {
            return Err(fail!(Forbidden, "{} cannot be used by Litch", app.name));
        }
        if app.integrity > self.own_integrity {
            return Err(fail!(Elevated, "{} runs as administrator; Litch cannot control it. Ask the user to do it themselves.", app.name));
        }
        if activity::is_stopped(&session, &app.app_id) {
            return Err(fail!(Stopped, "the user pressed Esc to stop Litch using {} this turn", app.name));
        }
        if let Some(reason) = system::locked_reason() {
            return Err(fail!(Locked, "the screen is not available ({reason}); ask the user to unlock it"));
        }
        let hwnd = apps::hwnd(win.hwnd);
        if hooks::last_user_input(win.hwnd, &apps::bounds(hwnd)).is_some_and(|t| t.elapsed() < USER_SILENCE) {
            return Err(fail!(UserActive, "the user is interacting with this window; wait a moment and try again"));
        }
        self.ensure_watchers();
        activity::begin(&session, &app.app_id, &app.name, win.hwnd);
        Ok((app, win))
    }

    /// 取某张截图的映射，并判 stale（窗口挪过、缩放过）
    fn shot(&self, p: &Value, hwnd: windows::Win32::Foundation::HWND) -> RpcResult<&Shot> {
        let id = shot_id(p)?;
        let shot = self.shots.get(&id).ok_or_else(|| fail!(Stale, "screenshot {id} is unknown; read the window state again"))?;
        if apps::bounds(hwnd) != shot.frame {
            return Err(fail!(Stale, "the window moved or resized since the screenshot; read the window state again"));
        }
        Ok(shot)
    }

    fn click(&mut self, p: &Value) -> RpcResult<Value> {
        let (_, win) = self.guard(p)?;
        let hwnd = apps::hwnd(win.hwnd);
        let button = str_of(p, "button").unwrap_or_else(|| "left".into());
        let count = p.get("count").and_then(Value::as_u64).unwrap_or(1) as u32;
        let modifiers = keys::modifiers(&modifier_list(p))?;
        if let Some(reference) = str_of(p, "ref") {
            let el = uia::find(hwnd, &reference)?;
            let plain = button == "left" && count <= 1 && modifiers.is_empty();
            if plain && uia::activate(&el)? {
                return self.done();
            }
            let (x, y) = uia::element_center(&el)?;
            foreground::ensure(hwnd)?;
            foreground::hit_ok(hwnd, x, y)?;
            input::click(x, y, &button, count, &modifiers)?;
        } else {
            let (x, y) = self.shot(p, hwnd)?.map.to_screen(req_f64(p, "x")?, req_f64(p, "y")?)?;
            foreground::ensure(hwnd)?;
            foreground::hit_ok(hwnd, x, y)?;
            input::click(x, y, &button, count, &modifiers)?;
        }
        self.done()
    }

    fn type_text(&mut self, p: &Value) -> RpcResult<Value> {
        let (_, win) = self.guard(p)?;
        let hwnd = apps::hwnd(win.hwnd);
        let text = req_str(p, "text")?;
        foreground::ensure(hwnd)?;
        let el = match str_of(p, "ref") {
            Some(reference) => {
                let el = uia::find(hwnd, &reference)?;
                let _ = uia::set_focus(&el);
                Some(el)
            }
            None => None,
        };
        let class = apps::class(hwnd);
        // 有元素就用它的值变化确认粘贴已落下，再恢复剪贴板；没有就固定等
        match &el {
            Some(el) => {
                let before = uia::snapshot_value(el);
                let check = || uia::snapshot_value(el) != before;
                let check: &dyn Fn() -> bool = &check;
                input::enter_text(&text, &class, Some(check));
            }
            None => input::enter_text(&text, &class, None),
        }
        self.done()
    }

    fn press_key(&mut self, p: &Value) -> RpcResult<Value> {
        let (_, win) = self.guard(p)?;
        let hwnd = apps::hwnd(win.hwnd);
        let combo = keys::parse(&req_str(p, "key")?, &modifier_list(p))?;
        let repeat = p.get("repeat").and_then(Value::as_u64).unwrap_or(1) as u32;
        foreground::ensure(hwnd)?;
        input::press_key(&combo, repeat);
        self.done()
    }

    fn scroll(&mut self, p: &Value) -> RpcResult<Value> {
        let (_, win) = self.guard(p)?;
        let hwnd = apps::hwnd(win.hwnd);
        let direction = req_str(p, "direction")?;
        let amount = p.get("amount").and_then(Value::as_i64).unwrap_or(5) as i32;
        if let Some(reference) = str_of(p, "ref") {
            let el = uia::find(hwnd, &reference)?;
            if uia::scroll(&el, &direction, amount)? {
                return self.done();
            }
            let (x, y) = uia::element_center(&el)?;
            foreground::ensure(hwnd)?;
            input::wheel(x, y, &direction, amount)?;
        } else if p.get("x").is_some() || p.get("y").is_some() {
            let (x, y) = self.shot(p, hwnd)?.map.to_screen(req_f64(p, "x")?, req_f64(p, "y")?)?;
            foreground::ensure(hwnd)?;
            input::wheel(x, y, &direction, amount)?;
        } else {
            let (x, y) = apps::bounds(hwnd).center();
            foreground::ensure(hwnd)?;
            input::wheel(x, y, &direction, amount)?;
        }
        self.done()
    }

    fn set_value(&mut self, p: &Value) -> RpcResult<Value> {
        let (_, win) = self.guard(p)?;
        let hwnd = apps::hwnd(win.hwnd);
        let el = uia::find(hwnd, &req_str(p, "ref")?)?;
        uia::set_value(&el, &req_str(p, "value")?)?;
        self.done()
    }

    fn drag(&mut self, p: &Value) -> RpcResult<Value> {
        let (_, win) = self.guard(p)?;
        let hwnd = apps::hwnd(win.hwnd);
        let (fx, fy) = point(p, "from")?;
        let (tx, ty) = point(p, "to")?;
        let shot = self.shot(p, hwnd)?;
        let from = shot.map.to_screen(fx, fy)?;
        let to = shot.map.to_screen(tx, ty)?;
        foreground::ensure(hwnd)?;
        foreground::hit_ok(hwnd, from.0, from.1)?;
        input::drag(from, to)?;
        self.done()
    }

    fn select_text(&mut self, p: &Value) -> RpcResult<Value> {
        let (_, win) = self.guard(p)?;
        let hwnd = apps::hwnd(win.hwnd);
        let el = uia::find(hwnd, &req_str(p, "ref")?)?;
        let text = str_of(p, "text");
        let start = p.get("start").and_then(Value::as_i64).map(|n| n as i32);
        let length = p.get("length").and_then(Value::as_i64).map(|n| n as i32);
        uia::select_text(&el, text.as_deref(), start, length)?;
        self.done()
    }

    /// 动作后等界面稳定一下，再让主进程取树算差异
    fn done(&self) -> RpcResult<Value> {
        std::thread::sleep(Duration::from_millis(400));
        Ok(json!({}))
    }
}

fn str_of(p: &Value, key: &str) -> Option<String> {
    p.get(key).and_then(Value::as_str).map(str::to_string)
}

fn req_str(p: &Value, key: &str) -> RpcResult<String> {
    str_of(p, key).filter(|s| !s.is_empty()).ok_or_else(|| fail!(Invalid, "{key} is required"))
}

/// 截图号：主进程把助手给的号原样带回，字符串或数字都认
fn shot_id(p: &Value) -> RpcResult<String> {
    match p.get("screenshotId") {
        Some(Value::String(s)) if !s.is_empty() => Ok(s.clone()),
        Some(Value::Number(n)) => Ok(n.to_string()),
        _ => Err(fail!(Invalid, "screenshotId is required")),
    }
}

fn req_f64(p: &Value, key: &str) -> RpcResult<f64> {
    p.get(key).and_then(Value::as_f64).ok_or_else(|| fail!(Invalid, "{key} is required"))
}

fn window_id(p: &Value) -> Option<isize> {
    p.get("windowId").and_then(Value::as_i64).map(|n| n as isize)
}

fn modifier_list(p: &Value) -> Vec<String> {
    p.get("modifiers")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

fn point(p: &Value, key: &str) -> RpcResult<(f64, f64)> {
    let obj = p.get(key).ok_or_else(|| fail!(Invalid, "{key} is required"))?;
    let x = obj.get("x").and_then(Value::as_f64);
    let y = obj.get("y").and_then(Value::as_f64);
    match (x, y) {
        (Some(x), Some(y)) => Ok((x, y)),
        _ => Err(fail!(Invalid, "{key} must have x and y")),
    }
}
