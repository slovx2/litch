// 控制面不进执行队列，否则长输入会挡住它自己的取消消息。
use crate::{
    action::{Action, Actions},
    wire::{self, Incoming},
};
use serde_json::{json, Value};
use std::{
    io::{self, Read},
    sync::{mpsc::Sender, Arc},
};

pub struct Request {
    pub id: Option<Value>,
    pub method: String,
    pub params: Value,
    pub action: Option<Arc<Action>>,
}

pub fn read_requests(
    input: &mut dyn Read,
    actions: &Actions,
    queue: Sender<Request>,
    mut send: impl FnMut(&Value),
) -> io::Result<()> {
    // EOF 和坏帧也取消已派发输入；不等执行线程回来才发现主进程断了。
    struct End<'a>(&'a Actions);
    impl Drop for End<'_> {
        fn drop(&mut self) {
            self.0.cancel_all();
        }
    }
    let _end = End(actions);
    while let Some(frame) = wire::read_frame(input)? {
        let Some(message) = Incoming::parse(frame) else {
            continue;
        };
        let (id, method, params) = match message {
            Incoming::Request { id, method, params } => (Some(id), method, params),
            Incoming::Notification { method, params } => (None, method, params),
        };
        if method == "cancelAction" {
            let result = match params
                .get("actionId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                Some(action_id) => {
                    actions.cancel_id(action_id);
                    Ok(json!({}))
                }
                None => Err(crate::fail!(Invalid, "actionId is required")),
            };
            if let Some(id) = id {
                send(&match result {
                    Ok(value) => wire::response(&id, value),
                    Err(error) => wire::error_response(&id, &error),
                });
            }
            continue;
        }
        if method == "turnEnded" {
            if let Some(session) = params.get("session").and_then(Value::as_str) {
                actions.cancel_session(session, params.get("turnId").and_then(Value::as_str));
            }
        } else if method == "shutdown" {
            actions.cancel_all();
        } else if id.is_none() {
            continue;
        }
        let shutdown = method == "shutdown";
        let action = actions.register(&method, &params);
        if queue
            .send(Request {
                id,
                method,
                params,
                action,
            })
            .is_err()
            || shutdown
        {
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn control_frames_cancel_while_execution_is_blocked() {
        // 用管道逐帧送数据；执行线程不取第二个请求，读线程仍须处理取消并回包。
        struct Pipe(mpsc::Receiver<Vec<u8>>, std::io::Cursor<Vec<u8>>);
        impl Read for Pipe {
            fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
                if self.1.position() as usize == self.1.get_ref().len() {
                    match self.0.recv() {
                        Ok(bytes) => self.1 = io::Cursor::new(bytes),
                        Err(_) => return Ok(0),
                    }
                }
                self.1.read(out)
            }
        }
        let actions = Actions::default();
        let (write, read) = mpsc::channel();
        let (queue, execute) = mpsc::channel();
        let (responses, replies) = mpsc::channel();
        let reader_actions = actions.clone();
        let reader = std::thread::spawn(move || {
            read_requests(
                &mut Pipe(read, io::Cursor::new(vec![])),
                &reader_actions,
                queue,
                |value| {
                    responses.send(value.clone()).unwrap();
                },
            )
        });
        let send = |value| write.send(wire::encode(&value).unwrap()).unwrap();
        send(
            json!({ "id": 1, "method": "typeText", "params": { "actionId": "a", "session": "s", "turnId": "t" } }),
        );
        let running = execute.recv().unwrap().action.unwrap();
        assert!(running.check().is_ok());
        send(json!({ "id": 2, "method": "cancelAction", "params": { "actionId": "a" } }));
        assert_eq!(
            replies
                .recv_timeout(std::time::Duration::from_secs(2))
                .unwrap()["id"],
            2
        );
        assert!(running.check().is_err());
        send(json!({ "id": 3, "method": "drag", "params": { "actionId": "b", "session": "s" } }));
        let queued = execute.recv().unwrap().action.unwrap();
        send(json!({ "method": "turnEnded", "params": { "session": "s", "turnId": "t" } }));
        assert_eq!(execute.recv().unwrap().method, "turnEnded");
        assert!(queued.check().is_err());
        send(json!({ "id": 4, "method": "drag", "params": { "actionId": "c", "session": "s" } }));
        let notified = execute.recv().unwrap().action.unwrap();
        send(json!({ "method": "cancelAction", "params": { "actionId": "c" } }));
        // 无效请求用作读线程屏障；它不能代替前一条通知取消动作。
        send(json!({ "id": 5, "method": "cancelAction", "params": {} }));
        assert_eq!(
            replies
                .recv_timeout(std::time::Duration::from_secs(2))
                .unwrap()["error"]["code"],
            -32602
        );
        assert!(notified.check().is_err());
        send(json!({ "id": 6, "method": "drag", "params": { "actionId": "d", "session": "s" } }));
        let disconnected = execute.recv().unwrap().action.unwrap();
        drop(write);
        reader.join().unwrap().unwrap();
        assert!(disconnected.check().is_err());
    }
}
