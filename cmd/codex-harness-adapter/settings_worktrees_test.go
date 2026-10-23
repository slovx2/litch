package main

import "testing"

// 工作树的三项：单独一组、设备级、立刻生效；位置要写绝对路径，前缀默认 litch/，先拉取默认关。
func TestWorktreeSettingsAreDeclared(t *testing.T) {
	cfg := settingsTestConfiguration(t)
	schema := buildSettingsSchema(cfg)
	var group *settingGroup
	for index := range schema.Groups {
		if schema.Groups[index].ID == worktreeGroup {
			group = &schema.Groups[index]
		}
	}
	if group == nil || group.Scope != deviceScope || group.Title.ZH == "" || group.Title.EN == "" || group.Description == nil {
		t.Fatalf("工作树那一组没有声明全: %+v", group)
	}
	root, declared := schema.spec(worktreeRootKey)
	if !declared || root.Type != settingPath || root.Default != "" || root.Restart != restartNone || root.Scope != deviceScope {
		t.Fatalf("存放位置声明得不对: %+v", root)
	}
	prefix, declared := schema.spec(worktreePrefixKey)
	if !declared || prefix.Type != settingString || prefix.Default != worktreePrefixDefault || prefix.Restart != restartNone {
		t.Fatalf("分支前缀声明得不对: %+v", prefix)
	}
	fetch, declared := schema.spec(worktreeFetchKey)
	if !declared || fetch.Type != settingBoolean || fetch.Default != false || fetch.Restart != restartNone {
		t.Fatalf("先拉取声明得不对: %+v", fetch)
	}
	for _, spec := range []settingSpec{root, prefix, fetch} {
		if spec.Group != worktreeGroup || spec.Title.ZH == "" || spec.Title.EN == "" || spec.Description.ZH == "" || spec.Description.EN == "" {
			t.Fatalf("%s 缺分组或者中英文的标题、说明", spec.Key)
		}
	}
	if _, problem, _ := cfg.settings.apply(0, []settingEdit{edit(worktreeRootKey, "relative/dir")}, schema, cfg.validateSettings); problem == nil || problem.key != worktreeRootKey {
		t.Fatalf("相对路径应被拒绝: %+v", problem)
	}
	changed, problem, err := cfg.settings.apply(0, []settingEdit{edit(worktreeRootKey, "/srv/worktrees"), edit(worktreePrefixKey, "wt/"), edit(worktreeFetchKey, true)}, schema, cfg.validateSettings)
	if err != nil || problem != nil || len(changed) != 3 {
		t.Fatalf("写入失败: %v %+v %v", changed, problem, err)
	}
}
