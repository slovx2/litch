// 界面树的一个节点（09 号 9.2 节的 WinNode）。编号、差异、文字化在主进程的 ax-text.mts 里做，助手只给结构。
use crate::geometry::Frame;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WinNode {
    /// UIA RuntimeId 用 "." 连起来；同一窗口后续的动作凭它找回元素
    #[serde(rename = "ref")]
    pub reference: String,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub automation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub class_name: Option<String>,
    pub states: Vec<&'static str>,
    pub actions: Vec<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame: Option<Frame>,
    pub children: Vec<WinNode>,
}

/// 空字符串当没有
pub fn non_empty(text: String) -> Option<String> {
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// 树里一共几个节点
pub fn count(node: &WinNode) -> usize {
    1 + node.children.iter().map(count).sum::<usize>()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn json_shape() {
        let node = WinNode {
            reference: "42.1.7".into(),
            role: "Button".into(),
            name: Some("保存".into()),
            value: None,
            automation_id: Some("SaveButton".into()),
            class_name: None,
            states: vec!["focused"],
            actions: vec!["invoke"],
            frame: Some(Frame { x: 1, y: 2, width: 3, height: 4 }),
            children: vec![],
        };
        assert_eq!(
            serde_json::to_value(&node).unwrap(),
            json!({
                "ref": "42.1.7", "role": "Button", "name": "保存", "automationId": "SaveButton",
                "states": ["focused"], "actions": ["invoke"],
                "frame": { "x": 1, "y": 2, "width": 3, "height": 4 }, "children": []
            })
        );
        let parent = WinNode { children: vec![node.clone(), node], ..WinNode {
            reference: "1".into(), role: "Window".into(), name: None, value: None, automation_id: None,
            class_name: None, states: vec![], actions: vec![], frame: None, children: vec![],
        } };
        assert_eq!(count(&parent), 3);
        assert_eq!(non_empty("  ".into()), None);
        assert_eq!(non_empty(" a ".into()), Some("a".into()));
    }
}
