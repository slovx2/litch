// 读线程登记动作并处理取消，执行线程只读原子标记。排队中的动作也必须能取消；
// 完成后只留弱引用，迟到的取消不影响下一次调用，也不积攒取消编号。
use crate::wire::RpcResult;
use serde_json::Value;
use std::cell::RefCell;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, Weak,
};
use std::time::{Duration, Instant};

#[derive(Default, Clone)]
pub struct Actions(Arc<Mutex<Vec<Weak<Action>>>>);

pub struct Action {
    id: Option<String>,
    session: String,
    turn: Option<String>,
    app: String,
    cancelled: AtomicBool,
}

impl Action {
    pub fn check(&self) -> RpcResult<()> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(crate::fail!(
                Stopped,
                "the action was cancelled; it may be partially completed"
            ));
        }
        Ok(())
    }
}

impl Actions {
    pub fn register(&self, method: &str, params: &Value) -> Option<Arc<Action>> {
        if !matches!(
            method,
            "getAppState"
                | "click"
                | "typeText"
                | "pressKey"
                | "scroll"
                | "setValue"
                | "drag"
                | "selectText"
        ) {
            return None;
        }
        let string = |key: &str| params.get(key).and_then(Value::as_str).map(str::to_owned);
        let action = Arc::new(Action {
            id: string("actionId"),
            session: string("session").unwrap_or_default(),
            turn: string("turnId"),
            app: string("appId").unwrap_or_default(),
            cancelled: AtomicBool::new(false),
        });
        let mut all = self.0.lock().unwrap_or_else(|e| e.into_inner());
        all.retain(|one| one.strong_count() > 0);
        all.push(Arc::downgrade(&action));
        Some(action)
    }

    fn cancel(&self, matches: impl Fn(&Action) -> bool) {
        let all = self.0.lock().unwrap_or_else(|e| e.into_inner());
        for action in all.iter().filter_map(Weak::upgrade) {
            if matches(&action) {
                action.cancelled.store(true, Ordering::Release);
            }
        }
    }

    pub fn cancel_id(&self, id: &str) {
        self.cancel(|a| a.id.as_deref() == Some(id));
    }
    pub fn cancel_session(&self, session: &str, turn: Option<&str>) {
        self.cancel(|a| {
            a.session == session
                && (turn.is_none() || a.turn.is_none() || a.turn.as_deref() == turn)
        });
    }
    pub fn cancel_app(&self, session: &str, app: &str) {
        self.cancel(|a| a.session == session && a.app.eq_ignore_ascii_case(app));
    }
    pub fn cancel_all(&self) {
        self.cancel(|_| true);
    }
}

thread_local! {
    static CURRENT: RefCell<Option<Arc<Action>>> = const { RefCell::new(None) };
}

pub struct Scope(Option<Arc<Action>>);
impl Scope {
    pub fn enter(action: Option<Arc<Action>>) -> Self {
        Self(CURRENT.with(|current| current.replace(action)))
    }
}
impl Drop for Scope {
    fn drop(&mut self) {
        CURRENT.with(|current| current.replace(self.0.take()));
    }
}

pub fn check() -> RpcResult<()> {
    CURRENT.with(|current| current.borrow().as_ref().map_or(Ok(()), |a| a.check()))
}

/// 等待期间仍每 10ms 响应停止；不能中断已经进入的单次系统调用。
pub fn sleep(duration: Duration) -> RpcResult<()> {
    let end = Instant::now() + duration;
    loop {
        check()?;
        let left = end.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Ok(());
        }
        std::thread::sleep(left.min(Duration::from_millis(10)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn params(id: &str, session: &str, turn: &str, app: &str) -> Value {
        json!({ "actionId": id, "session": session, "turnId": turn, "appId": app })
    }

    #[test]
    fn cancels_queued_actions_without_poisoning_future_calls() {
        let actions = Actions::default();
        let first = actions
            .register("drag", &params("a", "s", "t", "editor"))
            .unwrap();
        let queued = actions
            .register("typeText", &params("b", "s", "t", "editor"))
            .unwrap();
        actions.cancel_id("b");
        assert!(first.check().is_ok());
        assert!(queued.check().is_err());
        drop(queued);
        actions.cancel_id("b");
        let next = actions
            .register("typeText", &params("b", "s", "u", "editor"))
            .unwrap();
        assert!(next.check().is_ok());
    }

    #[test]
    fn turn_and_escape_are_scoped() {
        let actions = Actions::default();
        let old = actions
            .register("pressKey", &params("a", "s", "t", "Editor"))
            .unwrap();
        let next = actions
            .register("pressKey", &params("b", "s", "u", "Editor"))
            .unwrap();
        let other = actions
            .register("drag", &params("c", "other", "t", "Editor"))
            .unwrap();
        actions.cancel_session("s", Some("t"));
        assert!(old.check().is_err());
        assert!(next.check().is_ok());
        assert!(other.check().is_ok());
        actions.cancel_app("s", "EDITOR");
        assert!(next.check().is_err());
        assert!(other.check().is_ok());
        actions.cancel_all();
        assert!(other.check().is_err());
    }

    #[test]
    fn old_requests_without_action_id_still_work_and_stop_at_turn_end() {
        let actions = Actions::default();
        let action = actions
            .register("click", &json!({ "session": "s" }))
            .unwrap();
        let _scope = Scope::enter(Some(action));
        check().unwrap();
        actions.cancel_session("s", Some("t"));
        assert!(sleep(Duration::from_secs(5)).is_err());
    }
}
