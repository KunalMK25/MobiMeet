// Shared HTML-escaping helpers. Every string that originates outside the
// codebase (user input, OSM place names, LLM output) must pass through
// escapeHtml() before being placed in an innerHTML template.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ESC[c]);
}

// Chat formatter: escape first, THEN apply the tiny trusted markup subset
// (newline -> <br>, **bold** -> <strong>). Escaping first means no input
// can introduce tags or attributes.
export function formatChatText(text) {
  return escapeHtml(text)
    .replace(/\n/g, '<br>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
}
