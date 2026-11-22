import { useQuery } from '@tanstack/react-query'
import { outletsControllerListOutlets } from '#/api/generated/clients/outletsControllerListOutlets'
import { outletKeys } from './keys'

/** The outlet list shared by the Outlets page and the assignment dialog. */
export function useOutlets() {
  return useQuery({
    queryKey: outletKeys.list(),
    queryFn: () => outletsControllerListOutlets(),
  })
}
