// 正在被操作的应用的登记表（全进程一份），照 macOS 助手的 Activity：
// 一项是“哪个会话在操作哪个应用的哪个窗口”。屏幕提示按它显示；用户按物理 Esc 时，表里每一项都记成“本回合停了”
// 并通知主进程；回合结束撤掉对应会话的项和停止记录。
use crate::copy::{self, Language};
use serde_json::json;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 最后一个动作之后，屏幕提示再留多久（09 号 9.2 节：5 秒没有动作就撤）
const SHOW_FOR: Duration = Duration::from_secs(5);

struct Entry {
    session: String,
    app_id: String,
    name: String,
    hwnd: isize,
}

struct State {
    entries: Vec<Entry>,
    /// 本回合被 Esc 停掉的 (会话, 应用号小写)
    stopped: Vec<(String, String)>,
    last_action: Option<Instant>,
    /// 最近一次操作的窗口（提示框跟着它）
    target: isize,
    language: Language,
}

static STATE: Mutex<State> =
    Mutex::new(State { entries: vec![], stopped: Vec::new(), last_action: None, target: 0, language: Language::En });

fn state() -> std::sync::MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn set_language(language: Language) {
    state().language = language;
    super::overlay::wake();
}

/// 取状态或动作开始：登记，提示框移到这个窗口上
pub fn begin(session: &str, app_id: &str, name: &str, hwnd: isize) {
    {
        let mut s = state();
        s.entries.retain(|e| !(e.session == session && e.app_id.eq_ignore_ascii_case(app_id)));
        s.entries.push(Entry { session: session.into(), app_id: app_id.into(), name: name.into(), hwnd });
        s.last_action = Some(Instant::now());
        s.target = hwnd;
    }
    super::overlay::wake();
}

pub fn is_stopped(session: &str, app_id: &str) -> bool {
    state().stopped.contains(&(session.to_string(), app_id.to_lowercase()))
}

/// 回合结束：撤掉这个会话的项和停止记录
pub fn end_session(session: &str) {
    {
        let mut s = state();
        s.entries.retain(|e| e.session != session);
        s.stopped.retain(|(sess, _)| sess != session);
        if s.entries.is_empty() {
            s.last_action = None;
        }
    }
    super::overlay::wake();
}

/// 用户按了物理 Esc：表里每一项都记成停了、通知主进程，然后清空。表是空的就什么都不做（不是我们在操作时按的 Esc）
pub fn stop_all() {
    let stopped: Vec<Entry> = {
        let mut s = state();
        let all: Vec<Entry> = std::mem::take(&mut s.entries);
        for e in &all {
            let key = (e.session.clone(), e.app_id.to_lowercase());
            if !s.stopped.contains(&key) {
                s.stopped.push(key);
            }
        }
        s.last_action = None;
        all
    };
    if stopped.is_empty() {
        return;
    }
    for e in &stopped {
        super::server::notify("stopped", json!({ "session": e.session, "appId": e.app_id }));
    }
    super::system::log(format!("用户按了 Esc，停止了 {} 项操作", stopped.len()));
    super::overlay::wake();
}

/// 屏幕提示现在该不该显示：显示的话给出跟着的窗口和文字
pub fn overlay_target() -> Option<(isize, String)> {
    let s = state();
    let recent = s.last_action.is_some_and(|t| t.elapsed() < SHOW_FOR);
    if !recent || s.entries.is_empty() {
        return None;
    }
    let mut names: Vec<String> = vec![];
    for e in &s.entries {
        if !names.contains(&e.name) {
            names.push(e.name.clone());
        }
    }
    let target = if s.entries.iter().any(|e| e.hwnd == s.target) { s.target } else { s.entries[s.entries.len() - 1].hwnd };
    Some((target, copy::banner(s.language, &names)))
}
