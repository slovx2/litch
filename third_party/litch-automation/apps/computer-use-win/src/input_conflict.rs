// 前台动作只关心当前按住的输入和动作开始后的目标输入；后台语义动作不受影响。
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, PartialEq)]
pub enum Kind { Down, Up, Observe }
pub struct InputConflict {
    revisions: BTreeMap<isize, u64>,
    held: BTreeSet<u32>,
    pub sequence: u64,
    pub interactions: u64,
}
impl InputConflict {
    pub const fn new() -> Self { Self { revisions: BTreeMap::new(), held: BTreeSet::new(), sequence: 0, interactions: 0 } }
    pub fn note(&mut self, kind: Kind, hwnd: isize, code: u32) {
        self.sequence += 1;
        match kind {
            Kind::Down => { self.held.insert(code); self.interactions += 1; *self.revisions.entry(hwnd).or_default() += 1; }
            Kind::Up => { self.held.remove(&code); }
            Kind::Observe => {}
        }
    }
    pub fn revision(&self, hwnd: isize) -> u64 { *self.revisions.get(&hwnd).unwrap_or(&0) }
    pub fn pointer_held(&self) -> bool { self.held.iter().any(|code| *code >= 256) }
    pub fn blocked(&self, background: bool, composing: bool) -> bool { !background && (!self.held.is_empty() || composing) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn viewing_moving_scrolling_and_other_windows_do_not_collide() {
        let mut s = InputConflict::new();
        s.note(Kind::Observe, 1, 0);
        assert_eq!(s.interactions, 0);
        s.note(Kind::Down, 2, 65);
        assert_eq!(s.revision(1), 0);
        assert!(s.blocked(false, false));
        s.note(Kind::Up, 2, 65);
        assert!(!s.blocked(false, false));
    }
    #[test]
    fn target_click_changes_current_step_but_next_step_can_retry() {
        let mut s = InputConflict::new();
        let before = s.revision(1);
        s.note(Kind::Down, 1, 256);
        assert_ne!(before, s.revision(1));
        s.note(Kind::Up, 1, 256);
        let next = s.revision(1);
        assert_eq!(next, s.revision(1));
        assert!(!s.blocked(false, false));
    }
    #[test]
    fn background_ignores_held_input_and_composition() {
        let mut s = InputConflict::new();
        s.note(Kind::Down, 1, 256);
        assert!(!s.blocked(true, true));
        assert!(s.blocked(false, false));
        s.note(Kind::Up, 1, 256);
        assert!(s.blocked(false, true));
    }
}
