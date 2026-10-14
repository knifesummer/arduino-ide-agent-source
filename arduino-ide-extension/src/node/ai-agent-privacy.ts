/** Redact diagnostics only; never rewrite sketch code or user conversation input. */
export function redactAiDiagnostic(
  message: string,
  secrets: readonly string[] = []
): string {
  let result = message;
  const variants = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    variants.add(secret);
    variants.add(encodeURIComponent(secret));
    variants.add(JSON.stringify(secret).slice(1, -1));
  }
  for (const secret of [...variants].sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join('[已脱敏]');
  }
  result = result
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [已脱敏]')
    .replace(
      /\b(?:sk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g,
      '[已脱敏]'
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|password|authorization|cookie|set-cookie)["']?\s*[:=]\s*["']?)([^\s"'&,}\r\n]+)/gi,
      '$1[已脱敏]'
    )
    .replace(
      /([?&](?:key|token|secret|api[_-]?key|access[_-]?token)=)[^&#\s]+/gi,
      '$1[已脱敏]'
    )
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://[已脱敏]@');
  return result.length > 1600
    ? result.slice(0, 1600) + '…（诊断内容已截短）'
    : result;
}
