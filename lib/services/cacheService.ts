import { revalidateTag, revalidatePath } from 'next/cache';
import { invalidateByTag } from '@vercel/functions';
import { getSupabaseAdmin } from '@/lib/supabase-server';
import { buildSlugPath } from '@/lib/page-utils';
import type { Page, PageFolder } from '@/types';

/**
 * Maximum number of routes to warm in a single invalidation event.
 *
 * Warming is a best-effort optimisation, not a correctness requirement —
 * the long tail of routes will self-warm on their first real visit. The
 * cap protects against runaway cost when a dynamic page expands to
 * hundreds of CMS items, and against Vercel function timeout limits.
 */
const MAX_ROUTES_TO_WARM = 50;

type SupabaseAdmin = NonNullable<Awaited<ReturnType<typeof getSupabaseAdmin>>>;

const SUPABASE_IN_LIMIT = 500;

/** Split an array into chunks safe for Supabase `.in()` queries. */
function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Cache Invalidation Service
 *
 * Handles CDN cache invalidation for published pages using Next.js revalidation.
 * Supports both full-site invalidation and selective per-page invalidation.
 */

/**
 * Invalidate cache for a specific page by route path.
 *
 * On Vercel: uses invalidateByTag exclusively, which talks directly to Vercel's
 * CDN purge API and covers all three cache layers (CDN, Runtime, Data). We
 * deliberately avoid revalidateTag here because Next.js bug #63509 causes it
 * to cascade-invalidate other tags consumed by the page render, breaking
 * selective invalidation on Vercel.
 *
 * On self-hosted (no Vercel runtime): invalidateByTag no-ops, so we fall
 * back to revalidateTag to clear the in-process Next.js data cache.
 *
 * @param routePath - Route path (without leading slash for tag, with for path)
 */
export async function invalidatePage(routePath: string): Promise<boolean> {
  const tag = `route-/${routePath}`;
  try {
    if (process.env.VERCEL === '1') {
      await invalidateByTag(tag);
    } else {
      revalidateTag(tag, { expire: 0 });
    }
    return true;
  } catch (error) {
    console.error('❌ [Cache] Invalidation error:', error);
    return false;
  }
}

/**
 * Invalidate cache for multiple pages.
 * Uses Vercel's batched invalidateByTag on Vercel, revalidateTag elsewhere.
 *
 * @param routePaths - Array of route paths
 */
export async function invalidatePages(routePaths: string[]): Promise<boolean> {
  if (routePaths.length === 0) return true;
  try {
    const tags = routePaths.map((p) => `route-/${p}`);
    if (process.env.VERCEL === '1') {
      await invalidateByTag(tags);
    } else {
      for (const tag of tags) {
        revalidateTag(tag, { expire: 0 });
      }
    }
    return true;
  } catch (error) {
    console.error('❌ [Cache] Invalidation error:', error);
    return false;
  }
}

/**
 * Clear all cache (full site invalidation)
 * Invalidates the root layout which cascades to all pages
 */
export async function clearAllCache(): Promise<void> {
  try {
    if (process.env.VERCEL === '1') {
      // Vercel: direct CDN purge by the 'all-pages' tag set on every page
      // response. Covers CDN, Runtime, and Data caches in one call. Avoids
      // revalidateTag's cascade bug (#63509).
      await invalidateByTag('all-pages');
    } else {
      // Self-hosted: clear Next.js's in-process caches.
      revalidateTag('all-pages', { expire: 0 });
      revalidatePath('/', 'layout');
    }
  } catch (error) {
    console.error('❌ [Cache] Clear all error:', error);
    throw new Error('Failed to clear all cache');
  }
}

/**
 * Resolve published page IDs to their route paths (for cache invalidation).
 * Returns all URL paths each page can be reached at, including locale variants.
 *
 * For dynamic pages, enumerates actual collection item slugs rather than
 * returning a {slug} placeholder (which would never match a real cache tag).
 */
export async function getRoutePathsForPages(pageIds: string[]): Promise<string[]> {
  if (pageIds.length === 0) return [];

  const client = await getSupabaseAdmin();
  if (!client) return [];

  const [
    { data: pages },
    { data: folders },
    { data: locales },
    { data: translations },
  ] = await Promise.all([
    client.from('pages').select('*').in('id', pageIds).eq('is_published', true).is('deleted_at', null),
    client.from('page_folders').select('*').eq('is_published', true).is('deleted_at', null),
    client.from('locales').select('*').is('deleted_at', null),
    client.from('translations').select('*').eq('is_published', true).is('deleted_at', null),
  ]);

  if (!pages || !folders) return [];

  const routePaths: string[] = [];
  const dynamicPages: Page[] = [];

  // Build translations lookup
  const translationsMap: Record<string, Record<string, string>> = {};
  if (translations) {
    for (const t of translations) {
      if (!translationsMap[t.locale_id]) translationsMap[t.locale_id] = {};
      const key = `${t.source_type}:${t.source_id}:${t.content_key}`;
      translationsMap[t.locale_id][key] = t.content_value;
    }
  }

  for (const page of pages as Page[]) {
    if (page.is_dynamic) {
      dynamicPages.push(page);
      continue;
    }

    // Default locale path
    const defaultPath = buildSlugPath(page, folders as PageFolder[], 'page');
    const trimmed = defaultPath.slice(1); // Remove leading "/"

    if (page.is_index && page.page_folder_id === null) {
      routePaths.push('');
    } else if (trimmed) {
      routePaths.push(trimmed);
    }

    // Locale variant paths
    if (locales) {
      for (const locale of locales) {
        if (locale.is_default) continue;
        const localeTranslations = translationsMap[locale.id] || {};

        const slugParts: string[] = [locale.code];

        let currentFolderId = page.page_folder_id;
        const folderSegments: string[] = [];
        while (currentFolderId) {
          const folder = (folders as PageFolder[]).find(f => f.id === currentFolderId);
          if (!folder) break;
          const tKey = `folder:${folder.id}:slug`;
          folderSegments.unshift(localeTranslations[tKey] || folder.slug);
          currentFolderId = folder.page_folder_id;
        }
        slugParts.push(...folderSegments);

        if (!page.is_index && page.slug) {
          const pageKey = `page:${page.id}:slug`;
          slugParts.push(localeTranslations[pageKey] || page.slug);
        }

        const localePath = slugParts.filter(Boolean).join('/');
        if (localePath) routePaths.push(localePath);
      }
    }
  }

  // Resolve actual URLs for dynamic pages by enumerating collection item slugs
  if (dynamicPages.length > 0) {
    const dynamicRoutes = await resolveDynamicPageRoutes(
      client, dynamicPages, folders as PageFolder[], locales || [], translationsMap,
    );
    routePaths.push(...dynamicRoutes);
  }

  return [...new Set(routePaths)];
}

/**
 * Enumerate all published instance URLs for dynamic (CMS-driven) pages.
 * Each dynamic page is bound to a collection; we look up the slug field
 * values of published items to build the real URL paths.
 */
async function resolveDynamicPageRoutes(
  client: SupabaseAdmin,
  dynamicPages: Page[],
  folders: PageFolder[],
  locales: Array<{ id: string; code: string; is_default: boolean }>,
  translationsMap: Record<string, Record<string, string>>,
): Promise<string[]> {
  const routes: string[] = [];

  for (const page of dynamicPages) {
    const collectionId = (page.settings as any)?.cms?.collection_id;
    if (!collectionId) continue;

    const { data: slugField } = await client
      .from('collection_fields')
      .select('id')
      .eq('collection_id', collectionId)
      .eq('key', 'slug')
      .is('deleted_at', null)
      .limit(1)
      .single();

    if (!slugField) continue;

    const { data: items } = await client
      .from('collection_items')
      .select('id')
      .eq('collection_id', collectionId)
      .eq('is_published', true)
      .is('deleted_at', null);

    if (!items || items.length === 0) continue;

    const itemIds = items.map(i => i.id);
    const slugValues: Array<{ item_id: string; value: unknown }> = [];
    for (const idChunk of chunk(itemIds, SUPABASE_IN_LIMIT)) {
      const { data } = await client
        .from('collection_item_values')
        .select('item_id, value')
        .eq('field_id', slugField.id)
        .eq('is_published', true)
        .is('deleted_at', null)
        .in('item_id', idChunk);
      if (data) slugValues.push(...data);
    }

    if (slugValues.length === 0) continue;

    // Folder base path (everything before the {slug} segment)
    const basePath = buildSlugPath(page, folders, 'page', '').slice(1).replace(/\/$/, '');

    for (const sv of slugValues) {
      if (!sv.value) continue;
      const itemSlug = sv.value as string;
      const fullPath = basePath ? `${basePath}/${itemSlug}` : itemSlug;
      routes.push(fullPath);

      // Locale variant paths for each item
      for (const locale of locales) {
        if (locale.is_default) continue;
        const lt = translationsMap[locale.id] || {};

        const slugParts: string[] = [locale.code];
        let currentFolderId = page.page_folder_id;
        const folderSegments: string[] = [];
        while (currentFolderId) {
          const folder = folders.find(f => f.id === currentFolderId);
          if (!folder) break;
          folderSegments.unshift(lt[`folder:${folder.id}:slug`] || folder.slug);
          currentFolderId = folder.page_folder_id;
        }
        slugParts.push(...folderSegments);
        slugParts.push(itemSlug);

        const localePath = slugParts.filter(Boolean).join('/');
        if (localePath) routes.push(localePath);
      }
    }
  }

  return routes;
}

/**
 * Build route paths for deleted CMS items from their old slug values.
 * Maps each collection's deleted slugs to the dynamic pages that use that
 * collection, constructing the full URL paths that should be invalidated.
 *
 * @param deletedSlugs - Map of collectionId → array of deleted item slug values
 */
export async function getRoutePathsForDeletedCollectionItems(
  deletedSlugs: Map<string, string[]>,
): Promise<string[]> {
  if (deletedSlugs.size === 0) return [];

  const client = await getSupabaseAdmin();
  if (!client) return [];

  const routes: string[] = [];

  const [
    { data: dynamicPages },
    { data: folders },
    { data: locales },
  ] = await Promise.all([
    client.from('pages').select('*').eq('is_published', true).eq('is_dynamic', true).is('deleted_at', null),
    client.from('page_folders').select('*').eq('is_published', true).is('deleted_at', null),
    client.from('locales').select('*').is('deleted_at', null),
  ]);

  if (!dynamicPages || !folders) return [];

  for (const page of dynamicPages as Page[]) {
    const collectionId = (page.settings as any)?.cms?.collection_id;
    if (!collectionId) continue;

    const slugs = deletedSlugs.get(collectionId);
    if (!slugs || slugs.length === 0) continue;

    const basePath = buildSlugPath(page, folders as PageFolder[], 'page', '').slice(1).replace(/\/$/, '');

    for (const itemSlug of slugs) {
      const fullPath = basePath ? `${basePath}/${itemSlug}` : itemSlug;
      routes.push(fullPath);

      // Locale-prefixed paths
      if (locales) {
        for (const locale of locales) {
          if (locale.is_default) continue;
          const slugParts: string[] = [locale.code];
          let currentFolderId = page.page_folder_id;
          const folderSegments: string[] = [];
          while (currentFolderId) {
            const folder = (folders as PageFolder[]).find(f => f.id === currentFolderId);
            if (!folder) break;
            folderSegments.unshift(folder.slug);
            currentFolderId = folder.page_folder_id;
          }
          slugParts.push(...folderSegments);
          slugParts.push(itemSlug);
          const localePath = slugParts.filter(Boolean).join('/');
          if (localePath) routes.push(localePath);
        }
      }
    }
  }

  return [...new Set(routes)];
}

export interface SelectiveInvalidationResult {
  strategy: 'selective' | 'full';
  invalidatedRoutes: string[];
  reason?: string;
}

/**
 * Perform selective cache invalidation based on what actually changed.
 *
 * Receives the exact page IDs that were modified during publish (content_hash
 * changed, new page, or folder moved) — no guessing via timestamps.
 * Falls back to full invalidation when global resources changed.
 *
 * @param changedPageIds - Page IDs that actually changed during publish (from publishPages)
 * @param globalChanged - Whether global resources changed (triggers full nuke)
 * @param indirectlyAffectedPageIds - Page IDs affected by component, style, or collection changes
 */
export async function selectiveInvalidation(
  changedPageIds: string[],
  globalChanged: boolean,
  indirectlyAffectedPageIds: string[] = [],
): Promise<SelectiveInvalidationResult> {
  if (globalChanged) {
    await clearAllCache();
    return { strategy: 'full', invalidatedRoutes: [], reason: 'global resources changed' };
  }

  const allAffectedIds = [...new Set([...changedPageIds, ...indirectlyAffectedPageIds])];

  if (allAffectedIds.length === 0) {
    return { strategy: 'selective', invalidatedRoutes: [], reason: 'no pages changed' };
  }

  const routePaths = await getRoutePathsForPages(allAffectedIds);

  if (routePaths.length > 0) {
    await invalidatePages(routePaths);
  }

  return { strategy: 'selective', invalidatedRoutes: routePaths };
}

/**
 * Resolve every URL the public site currently serves from published pages.
 * Includes static pages, locale variants, and every dynamic-page instance
 * (one URL per published CMS item).
 *
 * Used to warm the cache after a full invalidation so the first real
 * visitor doesn't pay the cold-cache cost.
 */
export async function getAllPublishedRoutes(): Promise<string[]> {
  const client = await getSupabaseAdmin();
  if (!client) return [];

  const { data: pages } = await client
    .from('pages')
    .select('id')
    .eq('is_published', true)
    .is('deleted_at', null);

  if (!pages || pages.length === 0) return [];

  return getRoutePathsForPages(pages.map((p) => p.id));
}

/**
 * Background-warm a set of routes by issuing GET requests to them, so the
 * next real visitor sees x-vercel-cache: HIT instead of STALE/MISS.
 *
 * Uses Vercel's waitUntil so warming runs AFTER the response is sent: zero
 * added latency on the triggering request. Capped at MAX_ROUTES_TO_WARM
 * to bound cost and stay within Vercel function lifetime limits — long
 * tail of routes self-warms on first real visit.
 *
 * Vercel-only: warming via internal fetch only makes sense when there's a
 * CDN in front of the function. No-ops elsewhere.
 *
 * @returns null if not on Vercel, no host header, no routes, or warming
 *   failed to schedule. Otherwise reports how many were warmed vs total.
 */
export async function warmRoutes(
  routes: string[],
  request: Request,
): Promise<{ warmed: number; total: number } | null> {
  if (process.env.VERCEL !== '1' || routes.length === 0) return null;

  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (!host) return null;

  const proto = request.headers.get('x-forwarded-proto') ?? 'https';
  const baseUrl = `${proto}://${host}`;
  const toWarm = routes.slice(0, MAX_ROUTES_TO_WARM);

  try {
    const { waitUntil } = await import('@vercel/functions');
    waitUntil(
      Promise.allSettled(
        toWarm.map((route) =>
          fetch(`${baseUrl}/${route}`, {
            signal: AbortSignal.timeout(15000),
          }).catch(() => null),
        ),
      ),
    );
    return { warmed: toWarm.length, total: routes.length };
  } catch {
    return null;
  }
}
