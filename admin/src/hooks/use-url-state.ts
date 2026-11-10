import { useCallback, useEffect } from 'react'
import { useSearchParams } from 'react-router'

import { DEFAULT_PAGE_SIZE, PAGE_SIZES } from '@/api'

export type UrlChanges = Record<string, string | number | null>

/**
 * Filters, search and paging live in the URL, so reload, Back and a copied link all show the
 * same list. `update` changes the named parameters and leaves every other one alone
 * (including ?mock=...). null or '' removes a parameter.
 */
export function useUrlState() {
  const [searchParams, setSearchParams] = useSearchParams()

  const update = useCallback(
    (changes: UrlChanges, options: { replace?: boolean } = {}) => {
      // Start from the address as it is at this moment, not from the last render. Two quick
      // changes in a row (pick a status, then press a toggle) would otherwise both start from
      // the same old address, and the second would undo the first.
      const next = new URLSearchParams(window.location.search)
      for (const [name, value] of Object.entries(changes)) {
        if (value === null || value === '') {
          next.delete(name)
        } else {
          next.set(name, String(value))
        }
      }
      setSearchParams(next, { replace: options.replace ?? false })
    },
    [setSearchParams],
  )

  return [searchParams, update] as const
}

/**
 * A page past the end falls back to the last page. That happens when rows were removed
 * while the admin was on the last page, or when ?page= was typed by hand.
 * `loaded` is the list answer on screen (undefined while the first one loads).
 */
export function useLastPageFallback(
  loaded: { total: number; page: number } | undefined,
  page: number,
  pageSize: number,
  update: (changes: UrlChanges, options?: { replace?: boolean }) => void,
): void {
  const total = loaded?.total
  const loadedPage = loaded?.page
  useEffect(() => {
    // Only judge an answer that belongs to the page in the URL.
    if (total === undefined || loadedPage !== page) {
      return
    }
    const lastPage = Math.max(1, Math.ceil(total / pageSize))
    if (page > lastPage) {
      update(pageChange(lastPage), { replace: true })
    }
  }, [total, loadedPage, page, pageSize, update])
}

/** ?page=, a whole number from 1. Anything else reads as 1. */
export function readPage(searchParams: URLSearchParams): number {
  const page = Number(searchParams.get('page'))
  return Number.isInteger(page) && page >= 1 ? page : 1
}

/** ?page_size=, one of the offered sizes. Anything else reads as the default. */
export function readPageSize(searchParams: URLSearchParams): number {
  const size = Number(searchParams.get('page_size'))
  return PAGE_SIZES.find((candidate) => candidate === size) ?? DEFAULT_PAGE_SIZE
}

/** The value of ?<name>= if it is one of `allowed`, otherwise undefined. */
export function readChoice<T extends string>(
  searchParams: URLSearchParams,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const raw = searchParams.get(name)
  return allowed.find((candidate) => candidate === raw)
}

/** URL changes for a new page size: back to page 1, and the default size is not spelled out. */
export function pageSizeChange(pageSize: number): UrlChanges {
  return { page_size: pageSize === DEFAULT_PAGE_SIZE ? null : pageSize, page: null }
}

/** URL changes for a new page: page 1 is not spelled out. */
export function pageChange(page: number): UrlChanges {
  return { page: page <= 1 ? null : page }
}
