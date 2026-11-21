/**
 * Server-side identity attached to a guarded request by `JwtAuthGuard`.
 * `outletId` is the provisioned outlet this database belongs to — it comes
 * from the token claims re-validated against the environment, never from
 * request JSON (PRD §3, §15).
 */
export type AuthenticatedUser = {
  id: string;
  email: string;
  roleCodes: string[];
  permissions: string[];
  outletId: string;
};
