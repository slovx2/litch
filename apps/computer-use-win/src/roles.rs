// UIA 控件类型号 → WinNode 的 role（类型名去掉 "Control"）。号段是 UIA 固定的 50000–50040。

const NAMES: [&str; 41] = [
    "Button", "Calendar", "CheckBox", "ComboBox", "Edit", "Hyperlink", "Image", "ListItem", "List", "Menu",
    "MenuBar", "MenuItem", "ProgressBar", "RadioButton", "ScrollBar", "Slider", "Spinner", "StatusBar", "Tab",
    "TabItem", "Text", "ToolBar", "ToolTip", "Tree", "TreeItem", "Custom", "Group", "Thumb", "DataGrid",
    "DataItem", "Document", "SplitButton", "Window", "Pane", "Header", "HeaderItem", "Table", "TitleBar",
    "Separator", "SemanticZoom", "AppBar",
];

pub fn role(control_type: i32) -> &'static str {
    usize::try_from(control_type - 50000).ok().and_then(|i| NAMES.get(i).copied()).unwrap_or("Unknown")
}

#[cfg(test)]
mod tests {
    use super::role;

    #[test]
    fn names() {
        assert_eq!(role(50000), "Button");
        assert_eq!(role(50004), "Edit");
        assert_eq!(role(50030), "Document");
        assert_eq!(role(50032), "Window");
        assert_eq!(role(50033), "Pane");
        assert_eq!(role(50040), "AppBar");
        assert_eq!(role(50041), "Unknown");
        assert_eq!(role(0), "Unknown");
    }
}
