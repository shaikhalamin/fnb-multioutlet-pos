import { SetMetadata, type CustomDecorator } from '@nestjs/common';

export const PUBLIC_KEY = 'fnb:isPublic';

/**
 * Marks a route as reachable without authentication (e.g. `POST /auth/login`,
 * health probes). Everything else behind `JwtAuthGuard` requires a valid
 * outlet user access token (PRD §9).
 */
export const Public: () => CustomDecorator<string> = () => SetMetadata(PUBLIC_KEY, true);
