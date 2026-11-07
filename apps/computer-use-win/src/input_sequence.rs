// 每个事件派发前检查停止。只有已经成功按下的输入才归本动作所有；退出时倒序释放，
// 释放不再经过停止/前台检查，否则取消恰好发生在 down/up 之间会留下卡住的键。
use crate::wire::RpcResult;

pub trait Event: Clone {
    type Held: Eq;
    /// down 返回对应的 up，up 返回 None；纯移动/滚轮不改变持有状态。
    fn transition(&self) -> Option<(Self::Held, Option<Self>)>;
}

struct Release<'a, E: Event, F: FnMut(&[E]) -> usize> {
    held: Vec<(E::Held, E)>,
    inject: &'a mut F,
}
impl<E: Event, F: FnMut(&[E]) -> usize> Drop for Release<'_, E, F> {
    fn drop(&mut self) {
        for (_, up) in self.held.iter().rev() {
            // 一个键释放失败也必须继续释放其余键；系统拒绝输入时不能保证释放成功。
            let _ = (self.inject)(std::slice::from_ref(up));
        }
    }
}

pub fn send<E: Event>(
    events: &[E],
    chunk_size: usize,
    check: impl Fn() -> RpcResult<()>,
    mut inject: impl FnMut(&[E]) -> usize,
) -> RpcResult<()> {
    let mut release = Release {
        held: vec![],
        inject: &mut inject,
    };
    for chunk in events.chunks(chunk_size.max(1)) {
        // 松开键不要求原窗口仍在前台：Enter/Alt+F4 自己就可能切换或关闭窗口。
        if !chunk
            .iter()
            .all(|event| matches!(event.transition(), Some((_, None))))
        {
            check()?;
        }
        let sent = (release.inject)(chunk).min(chunk.len());
        for event in &chunk[..sent] {
            if let Some((key, up)) = event.transition() {
                release.held.retain(|(held, _)| held != &key);
                if let Some(up) = up {
                    release.held.push((key, up));
                }
            }
        }
        if sent != chunk.len() {
            return Err(crate::fail!(Failed, "SendInput rejected input events"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        action::{Actions, Scope},
        wire::Kind,
    };
    use serde_json::json;
    use std::cell::RefCell;

    #[derive(Clone, Debug, PartialEq, Eq)]
    enum Input {
        Down(&'static str),
        Up(&'static str),
        Move(u32),
    }
    impl Event for Input {
        type Held = &'static str;
        fn transition(&self) -> Option<(Self::Held, Option<Self>)> {
            match self {
                Self::Down(key) => Some((key, Some(Self::Up(key)))),
                Self::Up(key) => Some((key, None)),
                Self::Move(_) => None,
            }
        }
    }

    fn cancelled(events: &[Input], stop_after: usize) -> Vec<Input> {
        let actions = Actions::default();
        let action = actions
            .register("typeText", &json!({ "actionId": "a" }))
            .unwrap();
        let _scope = Scope::enter(Some(action));
        let mut sent = vec![];
        let result = send(events, 1, crate::action::check, |chunk| {
            sent.extend_from_slice(chunk);
            if sent.len() == stop_after {
                actions.cancel_id("a");
            }
            chunk.len()
        });
        assert_eq!(result.unwrap_err().kind, Kind::Stopped);
        sent
    }

    #[test]
    fn long_input_stops_between_key_down_and_up() {
        let events: Vec<_> = (0..1000)
            .flat_map(|_| [Input::Down("字"), Input::Up("字")])
            .collect();
        assert_eq!(
            cancelled(&events, 3),
            vec![
                Input::Down("字"),
                Input::Up("字"),
                Input::Down("字"),
                Input::Up("字")
            ]
        );
    }

    #[test]
    fn drag_stops_before_destination_and_releases_mouse() {
        let events = [
            Input::Move(0),
            Input::Down("left"),
            Input::Move(1),
            Input::Move(2),
            Input::Move(3),
            Input::Up("left"),
        ];
        assert_eq!(
            cancelled(&events, 3),
            vec![
                Input::Move(0),
                Input::Down("left"),
                Input::Move(1),
                Input::Up("left")
            ]
        );
    }

    #[test]
    fn repeated_shortcut_releases_main_key_and_modifiers_in_reverse_order() {
        let mut events = vec![Input::Down("ctrl"), Input::Down("shift")];
        for _ in 0..50 {
            events.extend([Input::Down("t"), Input::Up("t")]);
        }
        events.extend([Input::Up("shift"), Input::Up("ctrl")]);
        assert_eq!(
            cancelled(&events, 5),
            vec![
                Input::Down("ctrl"),
                Input::Down("shift"),
                Input::Down("t"),
                Input::Up("t"),
                Input::Down("t"),
                Input::Up("t"),
                Input::Up("shift"),
                Input::Up("ctrl")
            ]
        );
    }

    #[test]
    fn failed_input_releases_only_successful_downs() {
        let mut sent = vec![];
        let result = send(
            &[Input::Down("ctrl"), Input::Down("t")],
            1,
            || Ok(()),
            |chunk| {
                if chunk[0] == Input::Down("t") {
                    return 0;
                }
                sent.extend_from_slice(chunk);
                chunk.len()
            },
        );
        assert!(result.is_err());
        assert_eq!(sent, vec![Input::Down("ctrl"), Input::Up("ctrl")]);
    }

    #[test]
    fn unicode_chunk_is_atomic_and_partial_injection_releases_accepted_keys() {
        let pair = [
            Input::Down("high"),
            Input::Up("high"),
            Input::Down("low"),
            Input::Up("low"),
        ];
        let mut calls = vec![];
        send(
            &pair,
            4,
            || Ok(()),
            |chunk| {
                calls.push(chunk.to_vec());
                chunk.len()
            },
        )
        .unwrap();
        assert_eq!(calls, vec![pair.to_vec()]);
        calls.clear();
        let result = send(
            &pair,
            4,
            || Ok(()),
            |chunk| {
                calls.push(chunk.to_vec());
                if chunk.len() == 4 {
                    3
                } else {
                    chunk.len()
                }
            },
        );
        assert!(result.is_err());
        assert_eq!(calls, vec![pair.to_vec(), vec![Input::Up("low")]]);
    }

    #[test]
    fn foreground_conflict_also_releases_and_success_never_duplicates_up() {
        let sent = RefCell::new(vec![]);
        let result = send(
            &[Input::Down("left"), Input::Move(1)],
            1,
            || {
                if sent.borrow().is_empty() {
                    Ok(())
                } else {
                    Err(crate::fail!(UserActive, "foreground changed"))
                }
            },
            |chunk| {
                sent.borrow_mut().extend_from_slice(chunk);
                chunk.len()
            },
        );
        assert!(result.is_err());
        assert_eq!(*sent.borrow(), vec![Input::Down("left"), Input::Up("left")]);
        sent.borrow_mut().clear();
        let events = [
            Input::Down("ctrl"),
            Input::Down("t"),
            Input::Up("t"),
            Input::Up("ctrl"),
        ];
        send(
            &events,
            1,
            || Ok(()),
            |chunk| {
                sent.borrow_mut().extend_from_slice(chunk);
                chunk.len()
            },
        )
        .unwrap();
        assert_eq!(*sent.borrow(), events);
    }
}
