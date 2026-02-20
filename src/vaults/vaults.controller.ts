import { Controller, Post, Get, Param, Body, Patch } from "@nestjs/common";
import { VaultsService } from "./vaults.service";
import { CreateVaultDto } from "./dto/create-vault.dto";
import { ReleaseMilestoneDto } from "./dto/release-milestone.dto";
import { RefundMilestoneDto } from "./dto/refund-milestone.dto";
import { FundVaultDto } from "./dto/fund-vault.dto";
import { UpdateVaultStatusDto } from "./dto/update-vault-status.dto";
import { Roles } from "../common/decorators/roles.decorator";
import { User } from "../common/decorators/user.decorator";
import { UserRole } from "../domain/enums";

@Controller("vaults")
export class VaultsController {
  constructor(private vaultsService: VaultsService) {}

  @Post()
  @Roles(UserRole.CLIENT)
  async create(@Body() dto: CreateVaultDto, @User("id") userId: string, @User("role") role: UserRole) {
    return this.vaultsService.create(dto, userId, role);
  }

  @Get()
  async list(@User("id") userId: string, @User("role") role: UserRole) {
    return this.vaultsService.list(userId, role);
  }

  @Get(":id")
  async getById(@Param("id") id: string, @User("id") userId: string, @User("role") role: UserRole) {
    return this.vaultsService.getById(id, userId, role);
  }

  @Post(":id/fund")
  @Roles(UserRole.CLIENT)
  async fund(
    @Param("id") id: string,
    @Body() dto: FundVaultDto,
    @User("id") userId: string,
    @User("role") role: UserRole,
  ) {
    return this.vaultsService.fund(id, dto, userId, role);
  }

  @Post(":id/release-milestone")
  @Roles(UserRole.CLIENT)
  async releaseMilestone(
    @Param("id") vaultId: string,
    @Body() dto: ReleaseMilestoneDto,
    @User("id") userId: string,
    @User("role") role: UserRole,
  ) {
    return this.vaultsService.releaseMilestone(vaultId, dto, userId, role);
  }

  @Post(":id/refund")
  @Roles(UserRole.CLIENT)
  async refund(
    @Param("id") vaultId: string,
    @Body() dto: RefundMilestoneDto,
    @User("id") userId: string,
    @User("role") role: UserRole,
  ) {
    return this.vaultsService.refund(vaultId, dto, userId, role);
  }

  @Patch(":id/status")
  @Roles(UserRole.CLIENT)
  async updateStatus(
    @Param("id") id: string,
    @Body() dto: UpdateVaultStatusDto,
    @User("id") userId: string,
    @User("role") role: UserRole,
  ) {
    return this.vaultsService.updateStatus(id, dto, userId, role);
  }
}