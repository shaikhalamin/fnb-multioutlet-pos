/** Server-side identity attached to a guarded request by `JwtAuthGuard`. */
export type AuthenticatedUser = {
  id: string;
  email: string;
  roleCodes: string[];
  permissions: string[];
};
