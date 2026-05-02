import type { Components } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { normalizePrismLanguage, prismCodeStyle, SyntaxHighlighter } from '../lib/prismSetup'

type Props = {
  /** 原始 Markdown 文本 */
  content: string
  /** 外层额外 class */
  className?: string
}

/**
 * 与 Cursor / VS Code 深色主题接近的 Markdown 渲染（GFM：表格、删除线、任务列表等）
 */
export default function MarkdownBody({ content, className = '' }: Props) {
  return (
    <div
      className={`markdown-body text-sm text-[#d4d4d4] font-sans antialiased ${className}`}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  )
}

const markdownComponents: Components = {
  h1: ({ children, ...props }) => (
    <h1 className="mt-3 mb-2 text-xl font-semibold text-[#cccccc] border-b border-[#3c3c3c] pb-1" {...props}>
      {children}
    </h1>
  ),
  h2: ({ children, ...props }) => (
    <h2 className="mt-3 mb-2 text-lg font-semibold text-[#cccccc]" {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3 className="mt-2 mb-1.5 text-base font-semibold text-[#cccccc]" {...props}>
      {children}
    </h3>
  ),
  h4: ({ children, ...props }) => (
    <h4 className="mt-2 mb-1 text-sm font-semibold text-[#cccccc]" {...props}>
      {children}
    </h4>
  ),
  p: ({ children, ...props }) => (
    <p className="my-2 leading-relaxed last:mb-0" {...props}>
      {children}
    </p>
  ),
  ul: ({ children, ...props }) => (
    <ul className="my-2 list-disc pl-5 space-y-1" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol className="my-2 list-decimal pl-5 space-y-1" {...props}>
      {children}
    </ol>
  ),
  li: ({ children, ...props }) => (
    <li className="leading-relaxed" {...props}>
      {children}
    </li>
  ),
  blockquote: ({ children, ...props }) => (
    <blockquote
      className="my-2 border-l-4 border-[#007acc] bg-[#252526]/80 pl-3 py-1 text-[#b8b8b8]"
      {...props}
    >
      {children}
    </blockquote>
  ),
  a: ({ children, href, ...props }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[#4ec9b0] underline decoration-[#4ec9b0]/50 hover:decoration-[#4ec9b0]"
      {...props}
    >
      {children}
    </a>
  ),
  hr: (props) => <hr className="my-4 border-[#3c3c3c]" {...props} />,
  strong: ({ children, ...props }) => (
    <strong className="font-semibold text-[#e0e0e0]" {...props}>
      {children}
    </strong>
  ),
  em: ({ children, ...props }) => (
    <em className="italic text-[#d4d4d4]" {...props}>
      {children}
    </em>
  ),
  del: ({ children, ...props }) => (
    <del className="text-[#858585]" {...props}>
      {children}
    </del>
  ),
  table: ({ children, ...props }) => (
    <div className="my-3 overflow-x-auto rounded border border-[#3c3c3c]">
      <table className="min-w-full border-collapse text-xs" {...props}>
        {children}
      </table>
    </div>
  ),
  thead: ({ children, ...props }) => (
    <thead className="bg-[#2d2d30]" {...props}>
      {children}
    </thead>
  ),
  tbody: ({ children, ...props }) => <tbody {...props}>{children}</tbody>,
  tr: ({ children, ...props }) => (
    <tr className="border-b border-[#3c3c3c] last:border-0" {...props}>
      {children}
    </tr>
  ),
  th: ({ children, ...props }) => (
    <th className="border border-[#3c3c3c] px-2 py-1.5 text-left font-semibold text-[#cccccc]" {...props}>
      {children}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td className="border border-[#3c3c3c] px-2 py-1.5 align-top" {...props}>
      {children}
    </td>
  ),
  input: ({ type, checked, ...props }) => {
    if (type === 'checkbox') {
      return (
        <input
          type="checkbox"
          checked={checked}
          readOnly
          className="mr-1 align-middle accent-[#007acc]"
          {...props}
        />
      )
    }
    return <input type={type} {...props} />
  },
  /** 避免与 SyntaxHighlighter 的 PreTag 套双层 <pre> */
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children, ...props }) => {
    const text = String(children).replace(/\n$/, '')
    const fence = /language-([\w+#.-]+)/.exec(className ?? '')
    const explicitFence = Boolean(fence?.[1])
    const isBlock = explicitFence || text.includes('\n')

    if (isBlock) {
      const lang = explicitFence ? normalizePrismLanguage(fence![1]!) : 'markup'
      return (
        <SyntaxHighlighter
          language={lang}
          style={prismCodeStyle}
          PreTag="div"
          className="markdown-syntax-block font-mono"
          customStyle={{
            margin: '0.75rem 0',
            padding: '0.75rem',
            borderRadius: '0.375rem',
            border: '1px solid #d0d7de',
            background: '#ffffff',
            fontSize: '0.75rem',
            lineHeight: 1.625,
          }}
        >
          {text}
        </SyntaxHighlighter>
      )
    }
    return (
      <code
        className="rounded bg-[#3c3c3c] px-1.5 py-0.5 font-mono text-[#ce9178] text-[0.85em]"
        {...props}
      >
        {children}
      </code>
    )
  },
}
