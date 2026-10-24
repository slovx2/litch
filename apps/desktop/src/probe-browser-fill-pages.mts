// Litch 代填真实窗口自检（probe-browser-fill.mts）用的测试网页。都在回环的 http 上（本机回环算安全，能代填）。
// SPA_* 是单页应用：拦下提交、用 fetch 交，不换文档，再各自干一件“把密码漏出去”的事。

const FIELDS = `<input id="user" name="user" type="email" autocomplete="username" style="display:block;width:240px;height:28px">
<input id="pass" name="pass" type="password" autocomplete="current-password" style="display:block;width:240px;height:28px;margin-top:8px">`

/** 普通登录表单，POST 交给 /welcome（换文档） */
export const PLAIN = `<!doctype html><title>Sign in</title>
<form method="post" action="/welcome" style="margin:20px">${FIELDS}<button id="go">Sign in</button></form>`

/** 用 GET 交密码的表单 */
export const GET_FORM = `<!doctype html><title>Sign in</title>
<form method="get" action="/welcome" style="margin:20px">${FIELDS}<button>Sign in</button></form>`

/** 没写 method 的表单：HTML 默认用 GET 交 */
export const NO_METHOD = `<!doctype html><title>Sign in</title>
<form action="/welcome" style="margin:20px">${FIELDS}<button>Sign in</button></form>`

/** 表单写了 post，提交按钮的 formmethod 是 get（按这个按钮交就是 GET） */
export const BUTTON_GET = `<!doctype html><title>Sign in</title>
<form method="post" action="/welcome" style="margin:20px">${FIELDS}<button formmethod="get">Sign in</button></form>`

/** 出卡片时是 post，框里一有输入网页就把提交按钮改成 GET 交：提交前再查一次才挡得住 */
export const METHOD_FLIP = `<!doctype html><title>Sign in</title>
<form method="post" action="/welcome" style="margin:20px">${FIELDS}<button id="go">Sign in</button></form>
<script>document.addEventListener('input', () => document.getElementById('go').setAttribute('formmethod', 'get'))</script>`

/** 搜索框加登录表单：代理把编号指向搜索框 */
export const SEARCH = `<!doctype html><title>Sign in</title>
<input id="q" type="search" aria-label="Search the site" style="display:block;margin:20px;width:240px;height:28px">
<form method="post" action="/welcome" style="margin:20px">${FIELDS}<button>Sign in</button></form>`

/** 两步登录：先只有用户名 */
export const STEP1 = `<!doctype html><title>Sign in</title>
<form method="post" action="/step2" style="margin:20px"><input id="user" name="user" type="email" autocomplete="username" style="display:block;width:240px;height:28px"><button>Next</button></form>`

/** 两步登录的第二页 */
export const STEP2 = `<!doctype html><title>Password</title>
<form method="post" action="/welcome" style="margin:20px"><input id="pass" name="pass" type="password" autocomplete="current-password" style="display:block;width:240px;height:28px"><button>Sign in</button></form>`

/** 交了密码之后要验证码 */
export const OTP_LOGIN = `<!doctype html><title>Sign in</title>
<form method="post" action="/otp" style="margin:20px">${FIELDS}<button>Sign in</button></form>`

export const OTP = `<!doctype html><title>Verify</title>
<form method="post" action="/welcome" style="margin:20px"><input id="code" name="code" autocomplete="one-time-code" inputmode="numeric" style="width:120px;height:28px"><button>Verify</button></form>`

export const WELCOME = '<!doctype html><title>Welcome</title><p>Signed in</p>'

/** 单页应用的登录：leak 是提交时网页自己干的事（拿得到 pass.value） */
const spa = (leak: string, extra = '') => `<!doctype html><title>Sign in</title>
<form id="f" method="post" style="margin:20px">${FIELDS}${extra}<button id="go">Sign in</button></form>
<div id="out"></div>
<script>
document.getElementById('f').addEventListener('submit', async (event) => {
  event.preventDefault()
  const pass = document.getElementById('pass')
  ${leak}
  await fetch('/api/login', { method: 'POST', body: new URLSearchParams({ user: user.value, pass: pass.value }) })
  document.getElementById('out').textContent = 'Welcome back'
})
</script>`

/** 什么都不漏 */
export const SPA = spa('')
/** 把密码打进控制台 */
export const SPA_CONSOLE = spa(`console.log('password is ' + pass.value)`)
/** 把密码写进标题 */
export const SPA_TITLE = spa('document.title = pass.value')
/** 弹框里带着密码 */
export const SPA_ALERT = spa(`alert('Your password: ' + pass.value)`)
/** 靠弹窗登录（OAuth） */
export const SPA_POPUP = spa(`window.open('/oauth', 'oauth', 'width=400,height=400')`)
/** 表单里有个“显示密码”的按钮：点了把密码显示出来（框变成 text，旁边的字也写上） */
export const SPA_SHOW = spa(
  '',
  `<button type="button" id="show" onclick="pass.type='text'; document.getElementById('shown').textContent = pass.value">Show password</button><span id="shown"></span>`,
)
