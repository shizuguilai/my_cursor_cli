import { PrismAsyncLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c'
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp'
import csharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp'
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css'
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff'
import docker from 'react-syntax-highlighter/dist/esm/languages/prism/docker'
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go'
import graphql from 'react-syntax-highlighter/dist/esm/languages/prism/graphql'
import ini from 'react-syntax-highlighter/dist/esm/languages/prism/ini'
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java'
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx'
import kotlin from 'react-syntax-highlighter/dist/esm/languages/prism/kotlin'
import lua from 'react-syntax-highlighter/dist/esm/languages/prism/lua'
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown'
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup'
import objectivec from 'react-syntax-highlighter/dist/esm/languages/prism/objectivec'
import perl from 'react-syntax-highlighter/dist/esm/languages/prism/perl'
import php from 'react-syntax-highlighter/dist/esm/languages/prism/php'
import powershell from 'react-syntax-highlighter/dist/esm/languages/prism/powershell'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import r from 'react-syntax-highlighter/dist/esm/languages/prism/r'
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby'
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust'
import scala from 'react-syntax-highlighter/dist/esm/languages/prism/scala'
import scss from 'react-syntax-highlighter/dist/esm/languages/prism/scss'
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql'
import swift from 'react-syntax-highlighter/dist/esm/languages/prism/swift'
import toml from 'react-syntax-highlighter/dist/esm/languages/prism/toml'
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx'
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript'
import vim from 'react-syntax-highlighter/dist/esm/languages/prism/vim'
import wasm from 'react-syntax-highlighter/dist/esm/languages/prism/wasm'
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml'
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'

const langs: [string, typeof python][] = [
  ['bash', bash],
  ['c', c],
  ['cpp', cpp],
  ['csharp', csharp],
  ['css', css],
  ['diff', diff],
  ['docker', docker],
  ['go', go],
  ['graphql', graphql],
  ['ini', ini],
  ['java', java],
  ['javascript', javascript],
  ['json', json],
  ['jsx', jsx],
  ['kotlin', kotlin],
  ['lua', lua],
  ['markdown', markdown],
  ['markup', markup],
  ['objectivec', objectivec],
  ['perl', perl],
  ['php', php],
  ['powershell', powershell],
  ['python', python],
  ['r', r],
  ['ruby', ruby],
  ['rust', rust],
  ['scala', scala],
  ['scss', scss],
  ['sql', sql],
  ['swift', swift],
  ['toml', toml],
  ['tsx', tsx],
  ['typescript', typescript],
  ['vim', vim],
  ['wasm', wasm],
  ['yaml', yaml],
]

for (const [name, mod] of langs) {
  SyntaxHighlighter.registerLanguage(name, mod)
}

/** 已注册到 PrismAsyncLight 的语言 id（normalize 后必须落在此集合或经别名映射到此集合） */
const REGISTERED = new Set(langs.map(([n]) => n))

/** 围栏常见别名 / 变体 → Prism 注册名 */
const ALIAS: Record<string, string> = {
  py: 'python',
  python3: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  terminal: 'bash',
  yml: 'yaml',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  'c++': 'cpp',
  cxx: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  cs: 'csharp',
  rs: 'rust',
  kt: 'kotlin',
  kts: 'kotlin',
  rb: 'ruby',
  ps1: 'powershell',
  pwsh: 'powershell',
  dockerfile: 'docker',
  objc: 'objectivec',
  'objective-c': 'objectivec',
  md: 'markdown',
  plist: 'markup',
  text: 'markup',
  plaintext: 'markup',
  txt: 'markup',
  env: 'bash',
}

export function normalizePrismLanguage(raw: string): string {
  const id = raw.toLowerCase().trim()
  if (!id) return 'markup'
  const viaAlias = ALIAS[id]
  if (viaAlias && REGISTERED.has(viaAlias)) return viaAlias
  if (REGISTERED.has(id)) return id
  return 'markup'
}

/** 浅色主题，与白底代码块一致；避免 vscDarkPlus 配白底时对比度差 */
export { SyntaxHighlighter, oneLight as prismCodeStyle }
