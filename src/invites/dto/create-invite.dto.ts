import { IsEmail, IsUUID, IsInt, Min, Max, IsOptional } from "class-validator";

export class CreateInviteDto {
  @IsUUID()
  vaultId: string;

  @IsEmail()
  email: string;

  @IsInt()
  @Min(1)
  @Max(30)
  @IsOptional()
  expiresInDays?: number;
}
