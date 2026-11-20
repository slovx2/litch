package main

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"strings"
	"unicode/utf16"
)

type windowsAutostart struct {
	run             autostartCommand
	powershell, sid string
}

func (windowsAutostart) name() string { return "taskScheduler" }

func autoWindowsArg(s string) string {
	// CommandLineToArgvW 的引号与反斜杠规则。命令路径单独放在 XML 的 Command 中。
	var out strings.Builder
	out.WriteByte('"')
	backslashes := 0
	for _, c := range s {
		if c == '\\' {
			backslashes++
			continue
		}
		if c == '"' {
			out.WriteString(strings.Repeat("\\", backslashes+1))
		}
		out.WriteString(strings.Repeat("\\", backslashes))
		backslashes = 0
		out.WriteRune(c)
	}
	out.WriteString(strings.Repeat("\\", backslashes*2))
	out.WriteByte('"')
	return out.String()
}

func autoWindowsArgs(args []string) string {
	out := make([]string, len(args))
	for i, arg := range args {
		out[i] = autoWindowsArg(arg)
	}
	return strings.Join(out, " ")
}

func taskDescription(id string) string { return "Litch device autostart: " + id }

func (b windowsAutostart) taskXML(id string, s autostartSpec, args []string, worker bool) string {
	triggers, restart, duration := "", "", "PT4M"
	if !worker {
		triggers = "<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>" + b.sid + "</UserId></LogonTrigger></Triggers>"
		restart = "<RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>"
		duration = "PT0S"
	}
	return `<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<RegistrationInfo><Description>` + autoXML(taskDescription(id)) + `</Description></RegistrationInfo>` + triggers + `
<Principals><Principal id="LitchUser"><UserId>` + b.sid + `</UserId><LogonType>InteractiveToken</LogonType>
<RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowStartOnDemand>true</AllowStartOnDemand>
<Enabled>true</Enabled><ExecutionTimeLimit>` + duration + `</ExecutionTimeLimit>` + restart + `</Settings>
<Actions Context="LitchUser"><Exec><Command>` + autoXML(s.Executable) + `</Command><Arguments>` + autoXML(autoWindowsArgs(args)) +
		`</Arguments><WorkingDirectory>` + autoXML(s.Root) + `</WorkingDirectory></Exec></Actions></Task>`
}

type autoScheduledElement struct {
	XMLName   xml.Name
	Enabled   string `xml:"Enabled"`
	UserID    string `xml:"UserId"`
	Command   string `xml:"Command"`
	Arguments string `xml:"Arguments"`
	Directory string `xml:"WorkingDirectory"`
}

type autoTaskXML struct {
	Description string `xml:"RegistrationInfo>Description"`
	TriggerBox  struct {
		Items []autoScheduledElement `xml:",any"`
	} `xml:"Triggers"`
	ActionBox struct {
		Items []autoScheduledElement `xml:",any"`
	} `xml:"Actions"`
	Principals []struct {
		UserID   string `xml:"UserId"`
		Logon    string `xml:"LogonType"`
		RunLevel string `xml:"RunLevel"`
	} `xml:"Principals>Principal"`
	MultipleInstances string `xml:"Settings>MultipleInstancesPolicy"`
}

func (b windowsAutostart) checkTask(raw, id string, s autostartSpec, args []string, worker bool) bool {
	var task autoTaskXML
	err := xml.Unmarshal([]byte(raw), &task)
	actions, triggers := task.ActionBox.Items, task.TriggerBox.Items
	return err == nil && task.Description == taskDescription(id) &&
		len(task.Principals) == 1 && task.Principals[0].UserID == b.sid && task.Principals[0].Logon == "InteractiveToken" &&
		task.Principals[0].RunLevel == "LeastPrivilege" && task.MultipleInstances == "IgnoreNew" &&
		len(actions) == 1 && actions[0].XMLName.Local == "Exec" && actions[0].Command == s.Executable &&
		actions[0].Arguments == autoWindowsArgs(args) && actions[0].Directory == s.Root &&
		((worker && len(triggers) == 0) || (!worker && len(triggers) == 1 && triggers[0].XMLName.Local == "LogonTrigger" &&
			triggers[0].UserID == b.sid && triggers[0].Enabled != "false"))
}

func autoPSString(s string) string {
	return "[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + base64.StdEncoding.EncodeToString([]byte(s)) + "'))"
}

func autoEncodedCommand(s string) string {
	units := utf16.Encode([]rune(s))
	bytes := make([]byte, len(units)*2)
	for i, u := range units {
		binary.LittleEndian.PutUint16(bytes[i*2:], u)
	}
	return base64.StdEncoding.EncodeToString(bytes)
}

func (b windowsAutostart) call(ctx context.Context, id, script string) (string, error) {
	// 只运行固定操作；路径、XML 和服务标识的数据都从 Base64 解码，不是脚本。
	prefix := `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$svc = New-Object -ComObject 'Schedule.Service'
$svc.Connect()
$folder = $svc.GetFolder('\')
$name = ` + autoPSString(id) + "\n"
	return b.run(ctx, b.powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", autoEncodedCommand(prefix+script))
}

type autoTaskInfo struct {
	XML            string
	Enabled        bool
	State          int
	LastTaskResult int64
}

func (b windowsAutostart) query(ctx context.Context, id string) (autoTaskInfo, *autostartRepair) {
	var result autoTaskInfo
	raw, err := b.call(ctx, id, `try { $task = $folder.GetTask($name) } catch {
  $cause = $_.Exception
  while ($null -ne $cause) {
    if ($cause.HResult -eq -2147024894) { '{}' ; exit 0 }
    $cause = $cause.InnerException
  }
  throw
}
$xml = [string] $task.Xml
$xml = $xml -replace '^\s*<\?xml[^?]*\?>',''
@{XML=$xml;Enabled=[bool]$task.Enabled;State=[int]$task.State;LastTaskResult=[long]$task.LastTaskResult} | ConvertTo-Json -Compress
`)
	if err != nil || json.Unmarshal([]byte(strings.TrimPrefix(raw, "\ufeff")), &result) != nil {
		if autoPermissionError(raw) {
			return result, autoAccess()
		}
		return result, autoRepair("managerUnavailable", "无法查询任务计划程序；请检查服务和组策略。", "Cannot query Task Scheduler. Check the service and group policy.")
	}
	return result, nil
}

func (b windowsAutostart) inspect(ctx context.Context, s autostartSpec, owned ...autostartSpec) autostartManagerState {
	m := autostartManagerState{linger: "notApplicable"}
	task, repair := b.query(ctx, s.ID)
	m.repair = repair
	if repair != nil || task.XML == "" {
		return m
	}
	m.registered, m.enabled, m.running = true, task.Enabled, task.State == 4
	m.exact = b.checkTask(task.XML, s.ID, s, s.args(), false)
	m.foreign = true
	for _, old := range owned {
		if old.ID != "" && b.checkTask(task.XML, s.ID, old, old.args(), false) {
			m.foreign = false
			break
		}
	}
	if m.foreign {
		m.repair = autoConflict()
	} else if !m.running && task.LastTaskResult != 0 && uint32(task.LastTaskResult) != 0x41303 {
		m.issue = autoRepair("taskLastResult", "任务计划程序记录的上次运行结果：%s。请检查设备服务日志。", "Task Scheduler reports the last run result as %s. Check the device service logs.")
		code := fmt.Sprintf("0x%08X", uint32(task.LastTaskResult))
		m.issue.Text = m.issue.Text.with(code)
	}
	return m
}

func (b windowsAutostart) register(ctx context.Context, id string, s autostartSpec, args []string, worker, update bool) error {
	flags := 2 // TASK_CREATE：不覆盖同名登记。
	if update {
		flags = 6
	}
	_, err := b.call(ctx, id, `$xml = `+autoPSString(b.taskXML(id, s, args, worker))+
		fmt.Sprintf("\n$null = $folder.RegisterTask($name, $xml, %d, %s, $null, 3, $null)\n", flags, autoPSString(b.sid)))
	return err
}

func (b windowsAutostart) start(ctx context.Context, id string) error {
	// Run 的返回表示请求已提交；实例和锁由后续探针核验。
	_, err := b.call(ctx, id, "$task = $folder.GetTask($name)\n$null = $task.Run($null)\n")
	return err
}

func (b windowsAutostart) install(ctx context.Context, s autostartSpec, m autostartManagerState) error {
	if m.foreign || m.repair != nil {
		return autoManagerFailure(m.repair)
	}
	if !m.exact || !m.enabled {
		if err := b.register(ctx, s.ID, s, s.args(), false, m.registered); err != nil {
			return err
		}
	}
	if !m.running {
		return b.start(ctx, s.ID)
	}
	return nil
}

func (b windowsAutostart) remove(ctx context.Context, s autostartSpec, m autostartManagerState) error {
	if m.foreign || m.repair != nil {
		return autoManagerFailure(m.repair)
	}
	if !m.registered {
		return nil
	}
	_, err := b.call(ctx, s.ID, "$task = $folder.GetTask($name)\n$task.Enabled = $false\n$task.Stop(0)\n$folder.DeleteTask($name, 0)\n")
	return err
}

func (b windowsAutostart) quiesce(ctx context.Context, s autostartSpec) error {
	_, err := b.call(ctx, s.ID, "$task = $folder.GetTask($name)\n$task.Enabled = $false\n$task.Stop(0)\n")
	return err
}

func (windowsAutostart) linger(context.Context) error { return nil }

func (b windowsAutostart) enqueue(ctx context.Context, s autostartSpec, revision int64) error {
	id := autoWorkerID(s, revision)
	args := autoWorkerArgs(s, revision)
	old, repair := b.query(ctx, id)
	if repair != nil {
		return autoManagerFailure(repair)
	}
	if old.XML != "" && (!b.checkTask(old.XML, id, s, args, true) || old.State == 4) {
		return errors.New("autostart worker task already exists")
	}
	if err := b.register(ctx, id, s, args, true, old.XML != ""); err != nil {
		return err
	}
	if err := b.start(ctx, id); err != nil {
		b.cleanupWorker(ctx, s, revision)
		return err
	}
	return nil
}

func (b windowsAutostart) cleanupWorker(ctx context.Context, s autostartSpec, revision int64) {
	_, _ = b.call(ctx, autoWorkerID(s, revision), "$folder.DeleteTask($name, 0)\n")
}
