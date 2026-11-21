export const auditKeys = {
  all: ['audit'] as const,
  logs: (filters: {
    action?: string
    actorId?: string
    from?: string
    to?: string
  }) => [...auditKeys.all, 'logs', filters] as const,
}
