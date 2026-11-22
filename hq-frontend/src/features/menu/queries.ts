import { useQuery } from '@tanstack/react-query'
import { menuControllerListItems } from '#/api/generated/clients/menuControllerListItems'
import { menuControllerListItemsStatus200Schema } from '#/api/generated/schemas/menuControllerListItemsSchema'
import type { MenuItemResponse } from '#/api/generated/types/MenuItemResponse'
import { menuKeys } from './keys'

export type { MenuItemResponse }

/**
 * The master-items list every "browse / pick items" surface shares (AGENTS
 * §4.2): one query key, and the money-bearing payload (defaultPriceMinor) is
 * parsed with the generated Zod schema before it reaches render.
 */
export function useMenuItems() {
  return useQuery({
    queryKey: menuKeys.items({ status: undefined }),
    queryFn: async () =>
      menuControllerListItemsStatus200Schema.parse(
        await menuControllerListItems({ query: { limit: 200 } }),
      ),
  })
}

/** `status` guard: archived items exist in the list but can't be assigned. */
export function isAssignable(item: MenuItemResponse): boolean {
  return item.status === 'ACTIVE'
}
