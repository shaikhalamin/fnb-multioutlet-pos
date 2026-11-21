/* Backend-only machine client (PRD §11); never ship to a browser bundle. */

import type { CatalogChangesResponse } from './CatalogChangesResponse.js'

export type MenuPullControllerGetChangesQuery = {
  /**
   * @description Last revision the outlet applied; changes after it are returned. Decimal string.
   * @example 41
   * @type string | undefined
   */
  afterRevision?: string;
  /**
   * @maximum 500
   * @default 500
   * @example 500
   * @type number | undefined
   */
  limit?: number;
};

export type MenuPullControllerGetChangesStatus200 = CatalogChangesResponse;

export type MenuPullControllerGetChangesStatus401 = unknown;

export type MenuPullControllerGetChangesStatus403 = unknown;

export type MenuPullControllerGetChangesOptions = {
  body?: never;
  path?: never;
  query?: MenuPullControllerGetChangesQuery;
  headers?: never;
};

export type MenuPullControllerGetChangesResponses = {
  '200': MenuPullControllerGetChangesStatus200;
  '401': MenuPullControllerGetChangesStatus401;
  '403': MenuPullControllerGetChangesStatus403;
};

/**
 * @description Union of all possible responses
 */
export type MenuPullControllerGetChangesResponse = MenuPullControllerGetChangesStatus200;
