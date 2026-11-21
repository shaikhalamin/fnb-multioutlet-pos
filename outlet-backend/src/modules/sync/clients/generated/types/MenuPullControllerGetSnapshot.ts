/* Backend-only machine client (PRD §11); never ship to a browser bundle. */

import type { MenuSnapshotResponse } from './MenuSnapshotResponse.js'

export type MenuPullControllerGetSnapshotStatus200 = MenuSnapshotResponse;

export type MenuPullControllerGetSnapshotStatus401 = unknown;

export type MenuPullControllerGetSnapshotStatus403 = unknown;

export type MenuPullControllerGetSnapshotOptions = {
  body?: never;
  path?: never;
  query?: never;
  headers?: never;
};

export type MenuPullControllerGetSnapshotResponses = {
  '200': MenuPullControllerGetSnapshotStatus200;
  '401': MenuPullControllerGetSnapshotStatus401;
  '403': MenuPullControllerGetSnapshotStatus403;
};

/**
 * @description Union of all possible responses
 */
export type MenuPullControllerGetSnapshotResponse = MenuPullControllerGetSnapshotStatus200;
