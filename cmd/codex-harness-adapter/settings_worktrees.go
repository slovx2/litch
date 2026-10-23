package main

// 工作树（协议扩展 worktrees，protocol/extensions/worktrees.json）的设置：建在哪、怎么起分支，和清理。
// 建、删、恢复工作树都在设备进程里（packages/device/src/worktrees.mts），这一层只管设置。
// 设备进程每次建工作树时从经控制通道推过去的设置现状里按键读（device.mts 的 worktreeSettings），
// 改了下一次建就用新值，不重启任何东西；已经建好的工作树不挪。

const (
	worktreeGroup     = "worktrees"
	worktreeRootKey   = "worktrees.root"
	worktreePrefixKey = "worktrees.branchPrefix"
	worktreeFetchKey  = "worktrees.fetchFirst"
	worktreeCleanKey  = "worktrees.autoCleanup"
	worktreeKeepKey   = "worktrees.keepCount"
	worktreeDaysKey   = "worktrees.keptDays"
	// 和设备进程那边的默认值（WORKTREE_DEFAULTS）一样。
	worktreePrefixDefault = "litch/"
	worktreeKeepDefault   = 15
	worktreeDaysDefault   = 30
)

func worktreeSettings() (settingGroup, []settingSpec) {
	keepMin, keepMax := 1, 200
	daysMin, daysMax := 7, 365
	description := both(
		"新会话可以开在自己的工作树里：设备服务在会话所在的机器上用 git 从仓库切一份新检出、建一个新分支，改动不碰原来那份。下面几项改了从下一个工作树起生效，已经建好的不挪。",
		"A new session can start in its own worktree: the device service uses git on the session's machine to check out a fresh copy of the repository on a new branch, so changes stay off the original checkout. Changes below apply from the next worktree; existing ones are not moved.",
	)
	return settingGroup{
			ID: worktreeGroup, Scope: deviceScope, Description: &description,
			Title: both("工作树", "Worktrees"),
		}, []settingSpec{
			{
				Key: worktreeRootKey, Group: worktreeGroup, Type: settingPath, Scope: deviceScope, Restart: restartNone,
				Default: "", Title: both("存放位置", "Location"),
				Description: both(
					"工作树都建在这个目录下，按仓库分子目录。空着时放在设备服务的状态目录里的 worktrees 下。",
					"Worktrees are created under this directory, one subdirectory per repository. When empty they go under worktrees in the device service's state directory.",
				),
			},
			{
				Key: worktreePrefixKey, Group: worktreeGroup, Type: settingString, Scope: deviceScope, Restart: restartNone,
				Default: worktreePrefixDefault, Title: both("分支前缀", "Branch prefix"),
				Description: both(
					"新分支名的开头，后面接会话标题转成的短名和一段随机串。默认 litch/，清空就回到默认。",
					"Start of each new branch name, followed by a short name from the session title and a random suffix. Default litch/; clearing it restores the default.",
				),
			},
			{
				Key: worktreeFetchKey, Group: worktreeGroup, Type: settingBoolean, Scope: deviceScope, Restart: restartNone,
				Default: false, Title: both("先拉取默认分支", "Fetch the default branch first"),
				Description: both(
					"从默认分支切时先 git fetch 一次 origin 上的那个分支，拉不到不算错。关着时只用本地已有的，本地与 origin 那份哪个新用哪个。",
					"When branching from the default branch, run git fetch for that branch on origin first; a failed fetch is not an error. While off, only what is already local is used, picking whichever of the local and origin copies is newer.",
				),
			},
			{
				Key: worktreeCleanKey, Group: worktreeGroup, Type: settingBoolean, Scope: deviceScope, Restart: restartNone,
				Default: true, Title: both("自动清理", "Clean up automatically"),
				Description: both(
					"工作树超过保留个数时，删会话已归档的，按最后活动从旧到新；有改动的先存快照，都能从列表里恢复。会话没归档的不删，所以可能超过保留个数；置顶的、正在运行的、一小时内建的也不删。",
					"When there are more worktrees than the number to keep, remove those whose session is archived, least recently active first. Changes are saved as a snapshot first, and every one can be restored from the list. Worktrees of sessions that are not archived are never removed, so the count can go over; pinned, running and recently created ones are kept too.",
				),
			},
			{
				Key: worktreeKeepKey, Group: worktreeGroup, Type: settingInteger, Scope: deviceScope, Restart: restartNone,
				Default: worktreeKeepDefault, Minimum: &keepMin, Maximum: &keepMax, Title: both("保留个数", "Worktrees to keep"),
			},
			{
				Key: worktreeDaysKey, Group: worktreeGroup, Type: settingInteger, Scope: deviceScope, Restart: restartNone,
				Default: worktreeDaysDefault, Minimum: &daysMin, Maximum: &daysMax, Title: both("改动保留天数", "Days to keep changes"),
				Description: both(
					"归档会话时，工作树里有未提交的改动就先原样保留；过了这么多天存成快照再删除目录。",
					"When a session is archived and its worktree has uncommitted changes, the worktree is kept as it is; after this many days the changes are saved as a snapshot and the folder is removed.",
				),
			},
		}
}
