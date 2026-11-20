import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { RequirePermissions } from '../../common/rbac/require-permissions.decorator.js';
import { withCursor } from '../../common/interceptors/envelope.interceptor.js';
import {
  CategoryResponse,
  CreateCategoryRequest,
  CreateMenuItemRequest,
  ListMenuItemsQuery,
  MenuItemResponse,
  UpdateCategoryRequest,
  UpdateMenuItemRequest,
} from './dto/menu.dto.js';
import { MenuService } from './menu.service.js';

/** Master menu governance: categories + items (PRD FR-01, §7.2). */
@ApiTags('Menu')
@ApiSecurity('bearer-jwt')
@Controller()
export class MenuController {
  constructor(private readonly menuService: MenuService) {}

  // ---- Categories -----------------------------------------------------------

  @Get('categories')
  @RequirePermissions('menu.read')
  @ApiOperation({ summary: 'List menu categories.' })
  @ApiOkResponse({ type: [CategoryResponse] })
  async listCategories(): Promise<CategoryResponse[]> {
    return this.menuService.listCategories();
  }

  @Post('categories')
  @RequirePermissions('menu.write')
  @ApiOperation({ summary: 'Create a menu category.' })
  @ApiCreatedResponse({ type: CategoryResponse })
  @ApiResponse({ status: 409, description: 'CONFLICT — duplicate name' })
  async createCategory(
    @Body() body: CreateCategoryRequest,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<CategoryResponse> {
    return this.menuService.createCategory(body, actor.id);
  }

  @Get('categories/:id')
  @RequirePermissions('menu.read')
  @ApiOperation({ summary: 'Read one category.' })
  @ApiOkResponse({ type: CategoryResponse })
  @ApiResponse({ status: 404, description: 'NOT_FOUND' })
  async getCategory(@Param('id', ParseUUIDPipe) id: string): Promise<CategoryResponse> {
    return this.menuService.getCategory(id);
  }

  @Patch('categories/:id')
  @RequirePermissions('menu.write')
  @ApiOperation({ summary: 'Rename, reorder, or archive a category.' })
  @ApiOkResponse({ type: CategoryResponse })
  @ApiResponse({ status: 404, description: 'NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'CONFLICT — duplicate name' })
  @ApiResponse({ status: 422, description: 'UNPROCESSABLE_ENTITY — active items still present' })
  async updateCategory(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCategoryRequest,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<CategoryResponse> {
    return this.menuService.updateCategory(id, body, actor.id);
  }

  // ---- Master items ---------------------------------------------------------

  @Get('menu-items')
  @RequirePermissions('menu.read')
  @ApiOperation({ summary: 'List master menu items (keyset pagination).' })
  @ApiOkResponse({ type: [MenuItemResponse] })
  async listItems(@Query() query: ListMenuItemsQuery): Promise<MenuItemResponse[]> {
    const page = await this.menuService.listItems({
      categoryId: query.categoryId,
      status: query.status,
      q: query.q,
      limit: query.limit ?? 50,
      cursor: query.cursor,
    });
    return withCursor(page.items, page.nextCursor);
  }

  @Post('menu-items')
  @RequirePermissions('menu.write')
  @ApiOperation({ summary: 'Create a master menu item.' })
  @ApiCreatedResponse({ type: MenuItemResponse })
  @ApiResponse({ status: 409, description: 'CONFLICT — duplicate SKU' })
  @ApiResponse({ status: 422, description: 'UNPROCESSABLE_ENTITY — bad category/currency/price' })
  async createItem(
    @Body() body: CreateMenuItemRequest,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<MenuItemResponse> {
    return this.menuService.createItem(body, actor.id);
  }

  @Get('menu-items/:id')
  @RequirePermissions('menu.read')
  @ApiOperation({ summary: 'Read one master item.' })
  @ApiOkResponse({ type: MenuItemResponse })
  @ApiResponse({ status: 404, description: 'NOT_FOUND' })
  async getItem(@Param('id', ParseUUIDPipe) id: string): Promise<MenuItemResponse> {
    return this.menuService.getItem(id);
  }

  @Patch('menu-items/:id')
  @RequirePermissions('menu.write')
  @ApiOperation({ summary: 'Update and/or archive a master item (fans out catalog changes).' })
  @ApiOkResponse({ type: MenuItemResponse })
  @ApiResponse({ status: 404, description: 'NOT_FOUND' })
  @ApiResponse({ status: 422, description: 'UNPROCESSABLE_ENTITY' })
  async updateItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateMenuItemRequest,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<MenuItemResponse> {
    return this.menuService.updateItem(id, body, actor.id);
  }
}
