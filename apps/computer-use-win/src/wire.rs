// 和主进程之间的线上格式：每帧 4 字节大端的长度，后面是 UTF-8 的 JSON-RPC 2.0（和 macOS 助手同一套帧）。
// 主进程那一头在 apps/desktop/src/computer-use/wire.mts，常量和错误分类两边要一致。
use serde_json::{json, Value};
use std::io::{self, Read, Write};

/// Windows 版的通道协议版本（两个平台各自计数），握手时对不上就拒绝
pub const PROTOCOL: u64 = 1;
/// 单帧上限
pub const MAX_FRAME: usize = 32 * 1024 * 1024;

/// 错误的分类，主进程按 `data.kind` 认（wire.mts 的 HelperErrorKind）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// 没握手、版本不对
    Unauthorized,
    /// 参数不对、引用不存在、坐标出了截图
    Invalid,
    /// 找不到应用或窗口
    NotFound,
    /// 用户在这个回合里按 Esc 停掉了这个应用
    Stopped,
    /// 用户正在动这个窗口
    UserActive,
    /// 截图之后窗口变了，要先重新取状态
    Stale,
    /// 系统接口出错
    Failed,
    /// 目标窗口的完整性级别高于助手（以管理员身份运行）
    Elevated,
    /// 输入桌面不是 Default（锁屏、UAC 提示），或前台是锁屏
    Locked,
    /// 切不到前台
    Foreground,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Unauthorized => "unauthorized",
            Kind::Invalid => "invalid",
            Kind::NotFound => "notFound",
            Kind::Stopped => "stopped",
            Kind::UserActive => "userActive",
            Kind::Stale => "stale",
            Kind::Failed => "failed",
            Kind::Elevated => "elevated",
            Kind::Locked => "locked",
            Kind::Foreground => "foreground",
        }
    }

    /// JSON-RPC 的错误码：-32602 参数错、-32001 没授权，其余 -32000
    pub fn code(self) -> i64 {
        match self {
            Kind::Invalid => -32602,
            Kind::Unauthorized => -32001,
            _ => -32000,
        }
    }
}

/// 回给主进程的错误；`message` 是写给模型看的英文
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcError {
    pub kind: Kind,
    pub message: String,
}

impl RpcError {
    pub fn new(kind: Kind, message: impl Into<String>) -> Self {
        RpcError { kind, message: message.into() }
    }

    pub fn json(&self) -> Value {
        json!({ "code": self.kind.code(), "message": self.message, "data": { "kind": self.kind.as_str() } })
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.kind.as_str(), self.message)
    }
}

pub type RpcResult<T> = Result<T, RpcError>;

/// 便捷写法：`fail!(Invalid, "x is required")`
#[macro_export]
macro_rules! fail {
    ($kind:ident, $($arg:tt)*) => {
        $crate::wire::RpcError::new($crate::wire::Kind::$kind, format!($($arg)*))
    };
}

/// 编一帧
pub fn encode(value: &Value) -> io::Result<Vec<u8>> {
    let body = serde_json::to_vec(value).map_err(io::Error::other)?;
    if body.len() > MAX_FRAME {
        return Err(io::Error::other(format!("frame too large: {}", body.len())));
    }
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(&body);
    Ok(out)
}

/// 写一帧并刷出去
pub fn write_frame(out: &mut dyn Write, value: &Value) -> io::Result<()> {
    out.write_all(&encode(value)?)?;
    out.flush()
}

/// 读一帧。对面正常关掉（帧与帧之间读到结尾）回 None；帧读到一半断了、超长、不是 JSON 都是错误
pub fn read_frame(input: &mut dyn Read) -> io::Result<Option<Value>> {
    let mut head = [0u8; 4];
    let mut got = 0;
    while got < 4 {
        let n = input.read(&mut head[got..])?;
        if n == 0 {
            if got == 0 {
                return Ok(None);
            }
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "frame header cut short"));
        }
        got += n;
    }
    let length = u32::from_be_bytes(head) as usize;
    if length > MAX_FRAME {
        return Err(io::Error::other(format!("frame too large: {length}")));
    }
    let mut body = vec![0u8; length];
    input.read_exact(&mut body)?;
    serde_json::from_slice(&body).map(Some).map_err(io::Error::other)
}

/// 收到的一条消息
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    Request { id: Value, method: String, params: Value },
    Notification { method: String, params: Value },
}

impl Incoming {
    /// 解析一帧。不是请求或通知（比如对面发来的应答）时回 None
    pub fn parse(value: Value) -> Option<Incoming> {
        let Value::Object(mut fields) = value else { return None };
        let method = fields.get("method")?.as_str()?.to_string();
        let params = match fields.remove("params") {
            Some(Value::Null) | None => json!({}),
            Some(p) => p,
        };
        match fields.remove("id") {
            Some(Value::Null) | None => Some(Incoming::Notification { method, params }),
            Some(id) => Some(Incoming::Request { id, method, params }),
        }
    }
}

pub fn response(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

pub fn error_response(id: &Value, error: &RpcError) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": error.json() })
}

pub fn notification(method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "method": method, "params": params })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn round_trip() {
        let value = json!({ "jsonrpc": "2.0", "id": 1, "method": "hello", "params": { "protocol": 1, "text": "你好" } });
        let mut bytes = encode(&value).unwrap();
        assert_eq!(&bytes[..4], &((bytes.len() - 4) as u32).to_be_bytes());
        bytes.extend(encode(&json!({ "id": 2 })).unwrap());
        let mut cursor = Cursor::new(bytes);
        assert_eq!(read_frame(&mut cursor).unwrap(), Some(value));
        assert_eq!(read_frame(&mut cursor).unwrap(), Some(json!({ "id": 2 })));
        assert_eq!(read_frame(&mut cursor).unwrap(), None);
    }

    #[test]
    fn rejects_bad_frames() {
        let mut too_big = Cursor::new(((MAX_FRAME + 1) as u32).to_be_bytes().to_vec());
        assert!(read_frame(&mut too_big).is_err());
        let mut cut = Cursor::new(vec![0, 0, 0, 10, b'{']);
        assert!(read_frame(&mut cut).is_err());
        let mut half_head = Cursor::new(vec![0, 0]);
        assert!(read_frame(&mut half_head).is_err());
        let mut not_json = Cursor::new([&3u32.to_be_bytes()[..], b"abc"].concat());
        assert!(read_frame(&mut not_json).is_err());
    }

    #[test]
    fn parses_messages() {
        let request = Incoming::parse(json!({ "jsonrpc": "2.0", "id": 7, "method": "listApps" })).unwrap();
        assert_eq!(request, Incoming::Request { id: json!(7), method: "listApps".into(), params: json!({}) });
        let note = Incoming::parse(json!({ "jsonrpc": "2.0", "method": "x", "params": { "a": 1 } })).unwrap();
        assert_eq!(note, Incoming::Notification { method: "x".into(), params: json!({ "a": 1 }) });
        assert_eq!(Incoming::parse(json!({ "jsonrpc": "2.0", "id": 1, "result": {} })), None);
    }

    #[test]
    fn error_shape() {
        let error = RpcError::new(Kind::Elevated, "admin window");
        assert_eq!(error.json(), json!({ "code": -32000, "message": "admin window", "data": { "kind": "elevated" } }));
        assert_eq!(Kind::Invalid.code(), -32602);
        assert_eq!(Kind::Unauthorized.code(), -32001);
        let line = error_response(&json!(3), &error);
        assert_eq!(line["id"], json!(3));
        assert_eq!(line["error"]["data"]["kind"], json!("elevated"));
    }
}
