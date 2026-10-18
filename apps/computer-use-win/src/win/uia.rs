// UI Automation：读界面树和按元素的动作。
// 取树：一次 BuildUpdatedCache 取整棵子树（比逐节点取快）；出错时退回 ControlView 的 TreeWalker
// 逐节点取、到上限截断。Chromium/Electron 被问到时才打开无障碍树，第一次取到的太小就等一下再取一次。
use super::apps;
use crate::fail;
use crate::geometry::{Rect, ShotMap};
use crate::roles;
use crate::tree::{non_empty, WinNode};
use crate::wire::{RpcError, RpcResult};
use std::cell::RefCell;
use std::ffi::c_void;
use std::time::Duration;
use windows::core::BSTR;
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER, SAFEARRAY};
use windows::Win32::System::Ole::{SafeArrayAccessData, SafeArrayDestroy, SafeArrayGetLBound, SafeArrayGetUBound, SafeArrayUnaccessData};
use windows::Win32::UI::Accessibility::*;

thread_local! {
    static AUTOMATION: RefCell<Option<IUIAutomation>> = const { RefCell::new(None) };
}

/// 本线程的 IUIAutomation（COM 已在主线程按 MULTITHREADED 初始化）
fn automation() -> RpcResult<IUIAutomation> {
    AUTOMATION.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            let created: windows::core::Result<IUIAutomation> =
                unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) };
            *slot = Some(created.map_err(|e| sys("start UI Automation", e))?);
        }
        Ok(slot.as_ref().expect("automation").clone())
    })
}

/// UIA 能不能用（诊断里的 uia 字段）
pub fn available() -> bool {
    automation().is_ok()
}

fn sys(what: &str, e: windows::core::Error) -> RpcError {
    fail!(Failed, "UI Automation failed to {what}: {e}")
}

/// 要缓存的属性和模式：读 WinNode 要的一切，一次性取回
fn cache_request(auto: &IUIAutomation, scope: TreeScope) -> RpcResult<IUIAutomationCacheRequest> {
    unsafe {
        let req = auto.CreateCacheRequest().map_err(|e| sys("prepare cache", e))?;
        req.SetAutomationElementMode(AutomationElementMode_Full).ok();
        req.SetTreeScope(scope).ok();
        if let Ok(control) = auto.ControlViewCondition() {
            req.SetTreeFilter(&control).ok();
        }
        for prop in [
            UIA_NamePropertyId,
            UIA_ControlTypePropertyId,
            UIA_AutomationIdPropertyId,
            UIA_ClassNamePropertyId,
            UIA_BoundingRectanglePropertyId,
            UIA_HasKeyboardFocusPropertyId,
            UIA_IsEnabledPropertyId,
            UIA_IsOffscreenPropertyId,
            UIA_IsPasswordPropertyId,
            // 模式对象的 Cached* 值要单独把对应属性缓存进来：光 AddPattern 只让 GetCachedPattern 拿到模式本身，
            // 不缓存它的值。少了这几项，ValuePattern.CachedValue、TogglePattern.CachedToggleState 等会取不到，
            // 结果 value / readonly / checked / unchecked / selected / expanded / collapsed 全读不出来。
            UIA_ValueValuePropertyId,
            UIA_ValueIsReadOnlyPropertyId,
            UIA_ToggleToggleStatePropertyId,
            UIA_SelectionItemIsSelectedPropertyId,
            UIA_ExpandCollapseExpandCollapseStatePropertyId,
        ] {
            req.AddProperty(prop).ok();
        }
        for pattern in [
            UIA_InvokePatternId,
            UIA_TogglePatternId,
            UIA_SelectionItemPatternId,
            UIA_ExpandCollapsePatternId,
            UIA_ValuePatternId,
            UIA_ScrollPatternId,
            UIA_TextPatternId,
            UIA_LegacyIAccessiblePatternId,
        ] {
            req.AddPattern(pattern).ok();
        }
        Ok(req)
    }
}

fn bstr(result: windows::core::Result<BSTR>) -> Option<String> {
    result.ok().and_then(|b| non_empty(b.to_string()))
}

fn flag(result: windows::core::Result<windows::core::BOOL>) -> bool {
    result.map(|b| b.as_bool()).unwrap_or(false)
}

/// RuntimeId（SAFEARRAY of i4）→ Vec<i32>，用完销毁
unsafe fn runtime_id(el: &IUIAutomationElement) -> Vec<i32> {
    let psa: *mut SAFEARRAY = match el.GetRuntimeId() {
        Ok(p) if !p.is_null() => p,
        _ => return vec![],
    };
    let mut out = vec![];
    if let (Ok(lbound), Ok(ubound)) = (SafeArrayGetLBound(psa, 1), SafeArrayGetUBound(psa, 1)) {
        let mut data: *mut c_void = std::ptr::null_mut();
        if SafeArrayAccessData(psa, &mut data).is_ok() {
            let len = (ubound - lbound + 1).max(0) as usize;
            out = std::slice::from_raw_parts(data as *const i32, len).to_vec();
            let _ = SafeArrayUnaccessData(psa);
        }
    }
    let _ = SafeArrayDestroy(psa);
    out
}

fn reference_of(id: &[i32]) -> String {
    id.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(".")
}

/// 一个元素（属性已缓存）→ 不含孩子的 WinNode
fn node_of(el: &IUIAutomationElement, map: &ShotMap) -> WinNode {
    let control_type = unsafe { el.CachedControlType() }.map(|c| c.0).unwrap_or(0);
    let password = flag(unsafe { el.CachedIsPassword() });
    let mut states: Vec<&'static str> = vec![];
    let mut actions: Vec<&'static str> = vec![];

    if flag(unsafe { el.CachedHasKeyboardFocus() }) {
        states.push("focused");
    }
    if !unsafe { el.CachedIsEnabled() }.map(|b| b.as_bool()).unwrap_or(true) {
        states.push("disabled");
    }
    if flag(unsafe { el.CachedIsOffscreen() }) {
        states.push("offscreen");
    }
    if password {
        states.push("password");
    }

    if unsafe { el.GetCachedPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) }.is_ok() {
        actions.push("invoke");
    }
    if let Ok(toggle) = unsafe { el.GetCachedPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId) } {
        actions.push("toggle");
        match unsafe { toggle.CachedToggleState() } {
            Ok(s) if s == ToggleState_On => states.push("checked"),
            Ok(s) if s == ToggleState_Off => states.push("unchecked"),
            _ => {}
        }
    }
    if unsafe { el.GetCachedPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId) }
        .map(|s| flag(unsafe { s.CachedIsSelected() }))
        .unwrap_or(false)
    {
        states.push("selected");
    }
    if unsafe { el.GetCachedPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId) }.is_ok() {
        actions.push("select");
    }
    if let Ok(ec) = unsafe { el.GetCachedPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId) } {
        if let Ok(s) = unsafe { ec.CachedExpandCollapseState() } {
            if s == ExpandCollapseState_Expanded {
                states.push("expanded");
                actions.push("collapse");
            } else if s == ExpandCollapseState_Collapsed {
                states.push("collapsed");
                actions.push("expand");
            } else if s == ExpandCollapseState_PartiallyExpanded {
                actions.push("expand");
                actions.push("collapse");
            }
        }
    }
    let value = unsafe { el.GetCachedPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }.ok().and_then(|vp| {
        if flag(unsafe { vp.CachedIsReadOnly() }) {
            states.push("readonly");
        } else {
            actions.push("setValue");
        }
        if password {
            None
        } else {
            // 超长的值（比如整篇文档）截断，免得把树撑大；完整文本走 TextPattern
            bstr(unsafe { vp.CachedValue() }).map(|v| crate::text::clip(&v, 2000))
        }
    });
    if unsafe { el.GetCachedPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId) }.is_ok() {
        actions.push("scroll");
    }
    if unsafe { el.GetCachedPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) }.is_ok() {
        actions.push("text");
    }

    let frame = unsafe { el.CachedBoundingRectangle() }.ok().and_then(|r| map.to_frame(&rect_of(r)));

    WinNode {
        reference: reference_of(&unsafe { runtime_id(el) }),
        role: roles::role(control_type).to_string(),
        name: bstr(unsafe { el.CachedName() }),
        value,
        automation_id: bstr(unsafe { el.CachedAutomationId() }),
        class_name: bstr(unsafe { el.CachedClassName() }),
        states,
        actions,
        frame,
        children: vec![],
    }
}

fn rect_of(r: RECT) -> Rect {
    Rect::new(r.left, r.top, r.right, r.bottom)
}

/// 遍历已缓存子树建树，到上限就不再往下
fn from_cached(el: &IUIAutomationElement, map: &ShotMap, depth: u32, max_depth: u32, count: &mut usize, max_nodes: usize, truncated: &mut bool) -> WinNode {
    *count += 1;
    let mut node = node_of(el, map);
    let children = unsafe { el.GetCachedChildren() }.ok();
    let len = children.as_ref().and_then(|a| unsafe { a.Length() }.ok()).unwrap_or(0);
    if len > 0 && depth >= max_depth {
        *truncated = true;
        return node;
    }
    if let Some(arr) = children {
        for i in 0..len {
            if *count >= max_nodes {
                *truncated = true;
                break;
            }
            if let Ok(child) = unsafe { arr.GetElement(i) } {
                node.children.push(from_cached(&child, map, depth + 1, max_depth, count, max_nodes, truncated));
            }
        }
    }
    node
}

/// 退路：ControlView 的 TreeWalker 逐节点走，每个节点单独建一次缓存
fn from_walker(
    auto: &IUIAutomation,
    walker: &IUIAutomationTreeWalker,
    live: &IUIAutomationElement,
    one: &IUIAutomationCacheRequest,
    map: &ShotMap,
    depth: u32,
    max_depth: u32,
    count: &mut usize,
    max_nodes: usize,
    truncated: &mut bool,
) -> RpcResult<WinNode> {
    *count += 1;
    let cached = unsafe { live.BuildUpdatedCache(one) }.map_err(|e| sys("read a node", e))?;
    let mut node = node_of(&cached, map);
    if depth >= max_depth {
        if unsafe { walker.GetFirstChildElement(live) }.is_ok() {
            *truncated = true;
        }
        return Ok(node);
    }
    let mut child = unsafe { walker.GetFirstChildElement(live) }.ok();
    while let Some(c) = child {
        if *count >= max_nodes {
            *truncated = true;
            break;
        }
        node.children.push(from_walker(auto, walker, &c, one, map, depth + 1, max_depth, count, max_nodes, truncated)?);
        child = unsafe { walker.GetNextSiblingElement(&c) }.ok();
    }
    Ok(node)
}

/// Electron/Chromium 的顶层窗口类，第一次取的无障碍树往往不全
fn is_chromium(root: HWND) -> bool {
    apps::class(root) == "Chrome_WidgetWin_1"
}

/// 读窗口的界面树。回 (树, 是否截断)
pub fn read_tree(root: HWND, map: &ShotMap, max_nodes: usize, max_depth: u32, notes: &mut Vec<String>) -> RpcResult<(WinNode, bool)> {
    let auto = automation()?;
    let element = unsafe { auto.ElementFromHandle(root) }.map_err(|e| sys("find the window", e))?;
    let subtree = cache_request(&auto, TreeScope_Subtree)?;

    let mut build = |element: &IUIAutomationElement| -> RpcResult<(WinNode, bool)> {
        let mut count = 0usize;
        let mut truncated = false;
        match unsafe { element.BuildUpdatedCache(&subtree) } {
            Ok(cached) => Ok((from_cached(&cached, map, 0, max_depth, &mut count, max_nodes, &mut truncated), truncated)),
            Err(_) => {
                notes.push("Read the UI tree node by node after a bulk read failed.".into());
                let walker = unsafe { auto.ControlViewWalker() }.map_err(|e| sys("walk the tree", e))?;
                let one = cache_request(&auto, TreeScope_Element)?;
                let tree = from_walker(&auto, &walker, element, &one, map, 0, max_depth, &mut count, max_nodes, &mut truncated)?;
                Ok((tree, truncated))
            }
        }
    };

    let (mut tree, mut truncated) = build(&element)?;
    // Chromium/Electron：第一次树太小就等一下再取一次
    if is_chromium(root) && crate::tree::count(&tree) < 25 {
        std::thread::sleep(Duration::from_millis(500));
        let (again, trunc2) = build(&element)?;
        if crate::tree::count(&again) > crate::tree::count(&tree) {
            tree = again;
            truncated = trunc2;
            notes.push("Waited for the app to expose its accessibility tree.".into());
        }
    }
    Ok((tree, truncated))
}

/// 在窗口里按 ref（RuntimeId）找回元素，供后续动作用
pub fn find(root: HWND, reference: &str) -> RpcResult<IUIAutomationElement> {
    let auto = automation()?;
    let element = unsafe { auto.ElementFromHandle(root) }.map_err(|e| sys("find the window", e))?;
    let walker = unsafe { auto.ControlViewWalker() }.map_err(|e| sys("walk the tree", e))?;
    let mut stack = vec![element];
    let mut budget = 20_000u32;
    while let Some(cur) = stack.pop() {
        budget -= 1;
        if budget == 0 {
            break;
        }
        if reference_of(&unsafe { runtime_id(&cur) }) == reference {
            return Ok(cur);
        }
        let mut child = unsafe { walker.GetFirstChildElement(&cur) }.ok();
        while let Some(c) = child {
            let next = unsafe { walker.GetNextSiblingElement(&c) }.ok();
            stack.push(c);
            child = next;
        }
    }
    Err(fail!(Invalid, "element {reference} is no longer on screen; read the window state again to get fresh references"))
}

/// 屏幕物理像素里的元素中心（真实点击的退路用）
pub fn element_center(el: &IUIAutomationElement) -> RpcResult<(i32, i32)> {
    let r = unsafe { el.CurrentBoundingRectangle() }.map_err(|e| sys("read the element bounds", e))?;
    let rect = rect_of(r);
    if rect.is_empty() {
        return Err(fail!(Invalid, "the element has no on-screen area to click; it may be hidden"));
    }
    Ok(rect.center())
}

/// 把焦点放到元素上（type_text 带 ref 时）
pub fn set_focus(el: &IUIAutomationElement) -> RpcResult<()> {
    unsafe { el.SetFocus() }.map_err(|e| sys("focus the element", e))
}

/// 实时读元素的文本值（粘贴后确认“值变了没有”用）：优先 ValuePattern.CurrentValue，退回 CurrentName。
/// 只为前后对比，读不到就回 None（对比不出变化，调用方会等满超时再恢复剪贴板）。
pub fn snapshot_value(el: &IUIAutomationElement) -> Option<String> {
    unsafe {
        if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) {
            if let Some(v) = bstr(p.CurrentValue()) {
                return Some(v);
            }
        }
        bstr(el.CurrentName())
    }
}

/// 用 UIA 模式“激活”元素：Invoke → 默认动作 → 选择 → 开合 → 勾选。都没有回 false，让调用方改真实点击
pub fn activate(el: &IUIAutomationElement) -> RpcResult<bool> {
    unsafe {
        if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) {
            return p.Invoke().map(|_| true).map_err(|e| sys("invoke the element", e));
        }
        if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(UIA_LegacyIAccessiblePatternId) {
            if p.DoDefaultAction().is_ok() {
                return Ok(true);
            }
        }
        if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId) {
            return p.Select().map(|_| true).map_err(|e| sys("select the item", e));
        }
        if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId) {
            let state = p.CurrentExpandCollapseState().unwrap_or(ExpandCollapseState_LeafNode);
            let open = state == ExpandCollapseState_Collapsed || state == ExpandCollapseState_PartiallyExpanded;
            let r = if open { p.Expand() } else { p.Collapse() };
            return r.map(|_| true).map_err(|e| sys("expand or collapse the element", e));
        }
        if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId) {
            return p.Toggle().map(|_| true).map_err(|e| sys("toggle the element", e));
        }
    }
    Ok(false)
}

/// 设值：ValuePattern，退回 LegacyIAccessible。都没有回不支持
pub fn set_value(el: &IUIAutomationElement, value: &str) -> RpcResult<()> {
    let text = BSTR::from(value);
    unsafe {
        if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) {
            if flag(p.CurrentIsReadOnly()) {
                return Err(fail!(Invalid, "this field is read-only"));
            }
            return p.SetValue(&text).map_err(|e| sys("set the value", e));
        }
        if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(UIA_LegacyIAccessiblePatternId) {
            return p.SetValue(&text).map_err(|e| sys("set the value", e));
        }
    }
    Err(fail!(Invalid, "this element does not support setting a value; type into it instead"))
}

/// 按元素滚动：ScrollPattern。没有回 false，让调用方在坐标处发滚轮
pub fn scroll(el: &IUIAutomationElement, direction: &str, amount: i32) -> RpcResult<bool> {
    let times = amount.clamp(1, 50);
    unsafe {
        let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId) else {
            return Ok(false);
        };
        let (h, v) = match direction {
            "up" => (ScrollAmount_NoAmount, ScrollAmount_SmallDecrement),
            "down" => (ScrollAmount_NoAmount, ScrollAmount_SmallIncrement),
            "left" => (ScrollAmount_SmallDecrement, ScrollAmount_NoAmount),
            "right" => (ScrollAmount_SmallIncrement, ScrollAmount_NoAmount),
            _ => return Err(fail!(Invalid, "direction must be up, down, left or right")),
        };
        for _ in 0..times {
            if p.Scroll(h, v).is_err() {
                break;
            }
        }
    }
    Ok(true)
}

/// 选文字：TextPattern。给了 text 就找它并选中；只给范围就从头按字符移动；都没有选全部。没有 TextPattern 回不支持
pub fn select_text(el: &IUIAutomationElement, text: Option<&str>, start: Option<i32>, length: Option<i32>) -> RpcResult<()> {
    unsafe {
        let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) else {
            return Err(fail!(Invalid, "this element has no selectable text"));
        };
        if let Some(needle) = text.map(str::trim).filter(|s| !s.is_empty()) {
            let doc = p.DocumentRange().map_err(|e| sys("read the text", e))?;
            let range = doc.FindText(&BSTR::from(needle), false, true).map_err(|_| fail!(NotFound, "text \"{needle}\" was not found in this element"))?;
            return range.Select().map_err(|e| sys("select the text", e));
        }
        let range = p.DocumentRange().map_err(|e| sys("read the text", e))?.Clone().map_err(|e| sys("read the text", e))?;
        if let Some(start) = start {
            range.MoveEndpointByUnit(TextPatternRangeEndpoint_Start, TextUnit_Character, start).ok();
            range.MoveEndpointByUnit(TextPatternRangeEndpoint_End, TextUnit_Character, start).ok();
            if let Some(len) = length {
                range.MoveEndpointByUnit(TextPatternRangeEndpoint_End, TextUnit_Character, len).ok();
            } else {
                range.MoveEndpointByUnit(TextPatternRangeEndpoint_End, TextUnit_Character, i32::MAX).ok();
            }
        }
        range.Select().map_err(|e| sys("select the text", e))
    }
}
