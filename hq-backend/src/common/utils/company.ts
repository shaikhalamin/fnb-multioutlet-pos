import type { DataSource } from 'typeorm';
import { CompanyEntity } from '../../database/entities/company.entity.js';
import { ApiException } from '../exceptions/api.exception.js';

/**
 * Resolves the operating company. V1 is single-company (PRD §6.1); the seed
 * guarantees exactly one row. Missing company = misprovisioned system.
 */
export async function resolveCompanyId(dataSource: DataSource): Promise<string> {
  const company = await dataSource.getRepository(CompanyEntity).findOne({ where: {} });
  if (!company) {
    throw new ApiException('SERVICE_UNAVAILABLE', 'Company provisioning is missing.', 503);
  }
  return company.id;
}
