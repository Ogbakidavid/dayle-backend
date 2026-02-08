import { Controller, Get, Patch, Param, Body, Query } from "@nestjs/common";
import { AdminService } from "./admin.service";
import { Roles } from "../common/decorators/roles.decorator";
import { UserRole, DisputeStatus } from "../domain/enums";
import { ResolveDisputeDto } from "./dto/resolve-dispute.dto";

@Controller("admin")
@Roles(UserRole.ADMIN)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get("stats")
  async getStats() {
    return this.adminService.getStats();
  }

  @Get("users")
  async getUsers() {
    return this.adminService.getUsers();
  }

  @Get("vaults")
  async getVaults() {
    return this.adminService.getVaults();
  }

  @Get("disputes")
  async getDisputes() {
    return this.adminService.getDisputes();
  }

  @Patch("kyc/:userId/approve")
  async approveKyc(@Param("userId") userId: string) {
    return this.adminService.handleKyc(userId, "VERIFIED");
  }

  @Patch("kyc/:userId/reject")
  async rejectKyc(@Param("userId") userId: string, @Body("reason") reason: string) {
    return this.adminService.handleKyc(userId, "REJECTED", reason);
  }

  @Get("ledger")
  async getLedger() {
    return this.adminService.getLedger();
  }

  @Get("logs")
  async getSystemLogs(@Query("limit") limit?: number) {
    return this.adminService.getSystemLogs(limit ? Number(limit) : 10);
  }

  @Patch("disputes/:id/resolve")
  async resolveDispute(@Param("id") id: string, @Body() dto: ResolveDisputeDto) {
    return this.adminService.resolveDispute(id, dto);
  }
}
