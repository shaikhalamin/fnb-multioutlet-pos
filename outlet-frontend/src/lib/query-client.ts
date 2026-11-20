import { QueryClient } from '@tanstack/react-query'
import { ApiError } from '#/api/axios'

/**
 * Shared QueryClient factory (PRD §11). Financial data (sales, stock) must
 * never refetch blindly into stale UI: keep network retries minimal and let
 * each feature opt into its own invalidation strategy.
 */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        gcTime: 5 * 60_000,
        retry: (failureCount, error) => {
          // Retry transient failures only; never retry business rejections.
          if (
            error instanceof ApiError &&
            error.status !== undefined &&
            error.status < 500
          ) {
            return false
          }
          return failureCount < 1
        },
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  })
}
