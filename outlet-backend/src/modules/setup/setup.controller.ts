import { Body, Controller, Get, Header, HttpCode, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/auth/public.decorator.js';
import {
  CreateOutletIdentityRequest,
  HqConnectionResponse,
  SaveHqConnectionRequest,
  SetupIdentityResponse,
  SetupStatusResponse,
} from './dto/setup.dto.js';
import { SetupService } from './setup.service.js';

/**
 * First-run terminal setup (PRD §8.7 bootstrap, §9.2 secure provisioning
 * channel): public ONLY while the terminal is unprovisioned — each write
 * endpoint seals permanently once its row exists (403 FORBIDDEN from then
 * on), so a provisioned terminal can never be re-provisioned or re-keyed
 * through this surface. Responses carry `no-store`: provisioning state and
 * the once-visible pairing results must never sit in shared caches.
 */
@ApiTags('Setup')
@Controller('setup')
export class SetupController {
  constructor(private readonly setupService: SetupService) {}

  @Get('status')
  @Public()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Terminal provisioning state (drives the setup wizard).' })
  @ApiOkResponse({ type: SetupStatusResponse })
  async getStatus(): Promise<SetupStatusResponse> {
    return this.setupService.getStatus();
  }

  @Post('identity')
  @Public()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  // Tight brute-force budget on top of the global limiter: this route is
  // only reachable before any account exists, and seals itself after use.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Setup step 1: save the HQ-issued outlet ID + code and create the first admin.' })
  @ApiCreatedResponse({ type: SetupIdentityResponse })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED' })
  @ApiResponse({ status: 403, description: 'FORBIDDEN — identity already provisioned (sealed)' })
  @ApiResponse({ status: 429, description: 'RATE_LIMITED' })
  async createIdentity(@Body() body: CreateOutletIdentityRequest): Promise<SetupIdentityResponse> {
    return this.setupService.createIdentity(body);
  }

  @Post('hq-connection')
  @Public()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Setup step 2: validate the HQ key live and pair this terminal with HQ.' })
  @ApiCreatedResponse({ type: HqConnectionResponse })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED' })
  @ApiResponse({ status: 401, description: 'UNAUTHENTICATED — HQ rejected the key or it belongs to another outlet' })
  @ApiResponse({ status: 403, description: 'FORBIDDEN — connection already paired (sealed)' })
  @ApiResponse({ status: 409, description: 'CONFLICT — identity (step 1) not provisioned yet' })
  @ApiResponse({ status: 429, description: 'RATE_LIMITED' })
  @ApiResponse({ status: 503, description: 'SYNC_TEMPORARILY_UNAVAILABLE — HQ unreachable at that URL' })
  async saveHqConnection(@Body() body: SaveHqConnectionRequest): Promise<HqConnectionResponse> {
    return this.setupService.saveHqConnection(body);
  }
}
