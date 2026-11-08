package hostplatform

import "golang.org/x/sys/windows"

// SystemLanguage 返回系统界面的首选语言（如 zh-CN），取不到时返回空串。Windows 上通常没有 LANG 这类环境变量。
func SystemLanguage() string {
	languages, err := windows.GetUserPreferredUILanguages(windows.MUI_LANGUAGE_NAME)
	if err != nil || len(languages) == 0 {
		return ""
	}
	return languages[0]
}
