import { IsEnum, IsNotEmpty, IsOptional, IsString } from "class-validator";
import { DisputeStatus, VaultStatus } from "../../domain/enums";

export class ResolveDisputeDto {
  @IsEnum(DisputeStatus)
  status: DisputeStatus; // RESOLVED | REJECTED

  @IsString()
  @IsNotEmpty()
  resolution: string;

  @IsEnum(VaultStatus)
  @IsOptional()
  nextVaultStatus?: VaultStatus; // Usually ACTIVE or CLOSED
}
