import { Controller, Post, Get, Param, Body, Query } from "@nestjs/common";
import { VaultsService } from "./vaults.service";
import { CreateVaultDto } from "./dto/create-vault.dto";
import { ReleaseMilestoneDto } from "./dto/release-milestone.dto";
import { Roles } from "../common/decorators/roles.decorator";
import { User } from "../common/decorators/user.decorator";
import { UserRole } from "../domain/enums";

@Controller("vaults")
export class VaultsController {
  constructor(private vaultsService: VaultsService) {}

  @Post()
  @Roles(UserRole.CLIENT)
  async create(@Body() dto: CreateVaultDto, @User("id") userId: string) {
    return this.vaultsService.create(dto, userId);
  }

  @Get()
  async list(@User("id") userId: string, @User("role") role: UserRole) {
    return this.vaultsService.list(userId, role);
  }

  @Get(":id")
  async getById(@Param("id") id: string, @User("id") userId: string) {
    return this.vaultsService.getById(id, userId);
  }

  @Post(":id/release-milestone")
  @Roles(UserRole.CLIENT)
  async releaseMilestone(
    @Param("id") vaultId: string,
    @Body() dto: ReleaseMilestoneDto,
    @User("id") userId: string,
  ) {
    return this.vaultsService.releaseMilestone(vaultId, dto, userId);
  }
}