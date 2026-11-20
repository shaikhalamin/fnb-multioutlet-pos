-- HQ PostgreSQL init (runs once on first volume creation).
-- pgcrypto is enabled by the migration baseline as well; keep the extension
-- present from the start so fresh environments are consistent.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
