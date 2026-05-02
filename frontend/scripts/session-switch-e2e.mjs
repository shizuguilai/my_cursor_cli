/**
 * 浏览器端到端：登录后切换两个会话，校验 ChatPanel 底部「会话: xxx」随选中项变化。
 * 依赖：与后端一致的 CURSOR_REMOTE_TOKEN；后端 :5000；前端 dev :5173（或 FRONTEND_URL）。
 */
import puppeteer from 'puppeteer-core'

const TOKEN = process.env.CURSOR_REMOTE_TOKEN || 'e2e-test-token-123'
const FRONTEND = process.env.FRONTEND_URL || 'http://127.0.0.1:5173'

async function pickSessionFooterId(page) {
  return page.evaluate(() => {
    const spans = [...document.querySelectorAll('span')]
    const s = spans.find((x) => (x.textContent || '').startsWith('会话: '))
    return s ? (s.textContent || '').replace(/^会话:\s*/, '').trim() : ''
  })
}

async function clickSessionRow(page, index) {
  const ok = await page.evaluate((idx) => {
    const rows = [...document.querySelectorAll('aside div.cursor-pointer')]
    const row = rows[idx]
    if (!row) return false
    row.click()
    return true
  }, index)
  if (!ok) throw new Error(`侧栏第 ${index} 个会话行不存在（需要至少 ${index + 1} 条会话）`)
  await new Promise((r) => setTimeout(r, 500))
}

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  const page = await browser.newPage()
  page.setDefaultTimeout(25000)

  await page.goto(FRONTEND, { waitUntil: 'networkidle2' })

  const loginInput = await page.$('input[type="password"]')
  if (!loginInput) {
    throw new Error('未找到登录页密码框')
  }
  await loginInput.type(TOKEN)
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('进入主界面'))
    btn?.click()
  })

  await page.waitForFunction(() => !document.body.textContent?.includes('Token 校验中'))

  const stillLogin = await page.$('input[type="password"]')
  if (stillLogin) {
    throw new Error('登录失败：检查 CURSOR_REMOTE_TOKEN 与后端、以及后端是否已启动')
  }

  await page.waitForSelector('aside div.cursor-pointer', { timeout: 15000 })

  const n = await page.$$eval('aside div.cursor-pointer', (rows) => rows.length)
  if (n < 2) throw new Error(`数据库中需至少 2 条会话做切换测试（当前 ${n}）`)

  await clickSessionRow(page, 0)
  const id0 = await pickSessionFooterId(page)
  if (!id0) throw new Error('第一次选中后会话 id 为空')

  await clickSessionRow(page, 1)
  const id1 = await pickSessionFooterId(page)
  if (!id1) throw new Error('第二次选中后会话 id 为空')
  if (id0 === id1) throw new Error(`切换后会话 id 未变化: ${id0}`)

  console.log('[e2e] 切换会话 OK:', id0, '->', id1)
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
