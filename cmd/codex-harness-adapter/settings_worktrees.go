package main

// 工作树（协议扩展 worktrees，protocol/extensions/worktrees.json）的三项设置。
// 建、删、恢复工作树都在设备进程里（packages/device/src/worktrees.mts），这一层只管设置。
// 设备进程每次建工作树时从经控制通道推过去的设置现状里按键读（device.mts 的 worktreeSettings），
// 改了下一次建就用新值，不重启任何东西；已经建好的工作树不挪。

const (
	worktreeGroup     = "worktrees"
	worktreeRootKey   = "worktrees.root"
	worktreePrefixKey = "worktrees.branchPrefix"
	worktreeFetchKey  = "worktrees.fetchFirst"
	// 和设备进程那边的默认值（WORKTREE_DEFAULTS）一样。
	worktreePrefixDefault = "litch/"
)

func worktreeSettings() (settingGroup, []settingSpec) {
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
		}
}
