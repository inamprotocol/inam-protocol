/** Shared by both runtimes' `/agents/search` and `/jobs/search` routes.
 *  Neither endpoint had any limit on result-set size (SPEC.md round-2 item
 *  7) -- the Worker's D1 query had no LIMIT clause at all, so a large
 *  result set risked a response-size 500 rather than a bounded page. */
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

export interface PageParams {
  limit: number;
  offset: number;
}

export function parsePageParams(rawLimit: string | undefined, rawOffset: string | undefined): PageParams {
  let limit = rawLimit !== undefined ? Number(rawLimit) : DEFAULT_PAGE_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_PAGE_LIMIT;
  limit = Math.min(Math.floor(limit), MAX_PAGE_LIMIT);

  let offset = rawOffset !== undefined ? Number(rawOffset) : 0;
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  offset = Math.floor(offset);

  return { limit, offset };
}

/** Applied AFTER any post-fetch filtering (job visibility, min_reputation)
 *  so the page reflects what the caller actually sees, not raw storage
 *  rows -- a page can come back shorter than `limit` near the end of the
 *  result set even while `hasMore` is false. */
export function paginate<T>(items: T[], { limit, offset }: PageParams): { page: T[]; hasMore: boolean } {
  return { page: items.slice(offset, offset + limit), hasMore: offset + limit < items.length };
}
