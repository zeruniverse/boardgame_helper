/**
 * HTML 安全工具函数
 * 用于防止 XSS 攻击，清理用户输入的 HTML 内容
 */

// 允许的标签白名单
const ALLOWED_TAGS = ['span', 'b', 'i', 'strong', 'em', 'br'];
// 允许的属性白名单
const ALLOWED_ATTRS = ['style', 'class'];
// 允许的 CSS 属性白名单
const ALLOWED_CSS_PROPS = [
  'color', 'background-color', 'background', 'padding',
  'border-radius', 'font-weight', 'font-size', 'border-left',
  'margin-left', 'opacity', 'text-align', 'font-style'
];

/**
 * 基础的 HTML 转义函数
 * 将 < > " ' & 等字符转义为实体，防止 XSS
 */
export function escapeHtml(text: string): string {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * 清理 HTML，只保留白名单中的标签和属性
 * 在 formatMessage 之后作为第二层防护使用
 */
export function sanitizeHtml(html: string): string {
  if (!html) return '';

  const div = document.createElement('div');
  div.innerHTML = html;

  const cleanNode = (node: Node): Node | null => {
    // 文本节点直接返回
    if (node.nodeType === Node.TEXT_NODE) {
      return node.cloneNode();
    }

    // 元素节点需要清理
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const tagName = el.tagName.toLowerCase();

      // 不在白名单中的标签：提取文本内容
      if (!ALLOWED_TAGS.includes(tagName)) {
        return document.createTextNode(el.textContent || '');
      }

      // 创建新元素，只复制白名单属性
      const newEl = document.createElement(tagName);
      ALLOWED_ATTRS.forEach(attr => {
        if (el.hasAttribute(attr)) {
          const value = el.getAttribute(attr) || '';
          if (attr === 'style') {
            // 过滤 style 中的 CSS 属性
            const safeStyles = value.split(';').filter(s => {
              const prop = s.split(':')[0].trim().toLowerCase();
              return prop && ALLOWED_CSS_PROPS.includes(prop);
            }).join(';');
            if (safeStyles) {
              newEl.setAttribute('style', safeStyles);
            }
          } else {
            newEl.setAttribute(attr, value);
          }
        }
      });

      // 递归处理子节点
      Array.from(el.childNodes).forEach(child => {
        const cleaned = cleanNode(child);
        if (cleaned) {
          newEl.appendChild(cleaned);
        }
      });

      return newEl;
    }

    return null;
  };

  // 清理所有子节点
  const fragment = document.createDocumentFragment();
  Array.from(div.childNodes).forEach(child => {
    const cleaned = cleanNode(child);
    if (cleaned) {
      fragment.appendChild(cleaned);
    }
  });

  div.innerHTML = '';
  div.appendChild(fragment);
  return div.innerHTML;
}

/**
 * 安全的 HTML 渲染函数
 * 先通过 formatMessage 格式化，再通过 sanitizeHtml 清理
 * 用于替代直接使用 v-html="userInput"
 */
export function safeHtml(html: string): string {
  return sanitizeHtml(html);
}
