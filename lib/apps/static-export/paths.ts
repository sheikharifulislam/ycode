/**
 * Static export — output-key computation.
 *
 * S3-friendly path layout:
 *   - homepage / folder index → `<dir>/index.html`
 *   - any other page          → `<dir>/<slug>/index.html` (clean URLs)
 *   - error pages             → `<code>.html` at root
 */

import { buildSlugPath } from '@/lib/page-utils'

import type { Page, PageFolder } from '@/types'

export function computeOutputKey(page: Page, folders: PageFolder[]): string {
  if (page.error_page !== null && page.error_page !== undefined) {
    return `${page.error_page}.html`
  }

  const slugPath = buildSlugPath(page, folders, 'page')
  const trimmed = slugPath.replace(/^\/+/, '').replace(/\/+$/, '')

  if (!trimmed) return 'index.html'
  return `${trimmed}/index.html`
}
