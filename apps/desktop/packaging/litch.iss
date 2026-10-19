; Windows 安装包（Inno Setup 6.7.1）。scripts/make-installer.mjs 在 Windows 上照这份编出 Litch-<版本>-windows-x64-setup.exe。
; 要传进来的值（ISCC 的 /D）：
;   AppVersion  版本号
;   SourceDir   打包器出来的应用目录（out\Litch-win32-x64）
;   OutputDir   安装包放在哪
;   OutputName  安装包的文件名（不带 .exe）
;   IconFile    安装程序自己的图标（assets\icon.ico）
;
; 只给当前用户装，不要管理员权限：默认装到 %LOCALAPPDATA%\Programs\Litch，开始菜单里放一个快捷方式。
; 安装界面有英文和简体中文，照系统的界面语言选（不弹选语言的对话框），别的语言的系统上是英文。
; 简体中文的文案 ChineseSimplified.isl 是同目录下的一份：Inno Setup 6.7.1 自带的语言里没有它，
; 取自 https://github.com/kira-96/Inno-Setup-Chinese-Simplified-Translation （MIT，许可全文在 ChineseSimplified.isl.LICENSE）。
; 应用本身照系统语言显示。
; 应用目录整个装进去，其中 resources\computer-use\litch-computer-use.exe 是 Computer Use 的助手
; （scripts/pack.mjs 放进去的，make-installer.mjs 编之前核对过它在）。
; 升级、卸载时，内置适配器的常驻服务要是还在跑，它的文件被占着，安装程序会照 Windows 的“重启管理器”
; 问要不要先关掉占着文件的程序。助手是 Litch 的子进程，Litch 退出它就跟着退，不另外处理。
; 应用自己的更新（src/updater.mts、src/main.mts）在退出时先请常驻服务闲着的话停下，再带
; /VERYSILENT /SUPPRESSMSGBOXES /NORESTART 静默跑这个安装程序；用户点的是“重启以更新”的话再带上
; /LITCHRELAUNCH，装完把应用重新打开（见 [Run] 和 [Code]）。
#ifndef AppVersion
  #error 要用 /DAppVersion=<版本号> 指定版本
#endif

[Setup]
; 这个编号认的是“同一个应用”，升级、卸载都靠它。定下之后不要改
AppId={{86165537-655A-4F60-847F-94A1A6C622F4}
AppName=Litch
AppVersion={#AppVersion}
AppVerName=Litch {#AppVersion}
AppPublisher=slovx2
AppPublisherURL=https://github.com/slovx2/litch
AppSupportURL=https://github.com/slovx2/litch/issues
VersionInfoVersion={#AppVersion}
DefaultDirName={autopf}\Litch
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename={#OutputName}
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\Litch.exe
UninstallDisplayName=Litch
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; 照系统的界面语言选，不弹对话框；升级时也不沿用上一次装的语言（以前的安装包只有英文，沿用的话一直是英文）
ShowLanguageDialog=no
LanguageDetectionMethod=uilanguage
UsePreviousLanguage=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Litch"; Filename: "{app}\Litch.exe"
Name: "{autodesktop}\Litch"; Filename: "{app}\Litch.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Litch.exe"; Description: "{cm:LaunchProgram,Litch}"; Flags: nowait postinstall skipifsilent
Filename: "{app}\Litch.exe"; Flags: nowait; Check: RelaunchAfterUpdate

[Code]
// 应用里点了“重启以更新”：静默安装，命令行带 /LITCHRELAUNCH，装完把应用重新打开
function RelaunchAfterUpdate: Boolean;
begin
  Result := WizardSilent and (Pos('/LITCHRELAUNCH', Uppercase(GetCmdTail)) > 0);
end;
