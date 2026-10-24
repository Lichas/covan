// main/notificationText.ts — system notification copy is data-only, never raw Markdown.
export function notificationBody(markdown: string, limit = 140): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_~`>#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}
