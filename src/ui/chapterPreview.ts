import type { ChapterResult } from '../domain/chapter';
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const chapterFailureMessage = { locked: '正文暂不可获取：页面要求订阅或解锁。', 'needs-login': '正文暂不可获取：请重新登录。', 'access-blocked': '正文暂不可获取：网站访问验证，已停止本次获取。', 'page-error': '正文暂不可获取：网页返回错误。', 'content-not-found': '正文暂不可获取：未识别到正文。', 'unsupported-content': '正文暂不可获取：内容格式尚未支持。', timeout: '正文暂不可获取：加载或传输超时。' };
export function chapterPreview(result: ChapterResult): string {
  const content = result.status === 'available' ? `<h2>${escape(result.title)}</h2><p>已获取 ${result.text.length} 个字符。请核对是否与官方正文一致、无漏段或乱码。</p><article>${escape(result.text)}</article>` : `<h2>正文不可获取</h2><p>${chapterFailureMessage[result.reason]}</p>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{font-family:var(--vscode-font-family);padding:20px}article{white-space:pre-wrap;line-height:1.9;max-width:850px}</style></head><body>${content}</body></html>`;
}
