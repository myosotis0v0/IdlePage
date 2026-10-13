import type { BookshelfPage } from '../domain/bookshelf';
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export function bookshelfPreview(page: BookshelfPage): string {
  const scope = page.strategy === 'unconfirmed' ? '当前页候选书单：尚未确认书架容器，可能混入页面其他书目。' : '当前页书单：已限定书架容器，仍需核对书名、数量和链接。';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:20px}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:8px;border-bottom:1px solid var(--vscode-panel-border)}code{overflow-wrap:anywhere}p{line-height:1.7}
</style></head><body><h2>IdlePage：当前页书单核对</h2><p>${scope}</p><p>本页 ${page.books.length} 本${page.truncated ? '（达到本轮数量或传输限制，结果已截断）' : ''}；提取方式 ${page.strategy}；分页信号 ${page.pagination}。本次不翻页，不获取目录或正文。</p><table><thead><tr><th>序号</th><th>书名</th><th>书籍 ID</th><th>规范化链接</th></tr></thead><tbody>${page.books.map((book, index) => `<tr><td>${index + 1}</td><td>${escape(book.title)}</td><td>${escape(book.id)}</td><td><code>${escape(book.url)}</code></td></tr>`).join('')}</tbody></table><p>结果仅在本机内存和此核对页中显示；共享进度文件不包含书名或书架明细。</p></body></html>`;
}