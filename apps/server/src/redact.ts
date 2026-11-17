// Captured content is redacted before it is stored. Pattern-based: it catches the common shapes (and the setup
// token) but can miss a secret in an unusual format. TRANSPARENCY.md says so.
const R = '[redacted]';
const TOKENS = /AKIA[0-9A-Z]{16}|sk-ant-[A-Za-z0-9_-]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}|glpat-[A-Za-z0-9_-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|ccm_(?:inv|dev)_[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
// KEY=value, "apiKey": "value", password: value, --token value, Authorization: Bearer value
const ASSIGN = /(\b[A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|auth[_-]?key)[A-Za-z0-9_.-]*["']?\s*[:=]\s*|--(?:token|password|api-key|secret)[ =])(?!(?:Bearer|Basic)\s)(["']?)[^\s"',;]{4,}\2/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;
const URL_CREDS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi;

export function redact(text: string): string {
  return text
    .replace(PEM, R)
    .replace(TOKENS, R)
    .replace(URL_CREDS, `$1${R}@`)
    .replace(BEARER, `$1 ${R}`)
    .replace(ASSIGN, (_m, key: string, q: string) => `${key}${q}${R}${q}`);
}
