import { IsEnum, IsString, IsNumber, IsOptional } from "class-validator";

export class LinkSmartAccountDto {
  @IsEnum(["PRIVY", "WEB3AUTH"])
  @IsOptional()
  provider?: "PRIVY" | "WEB3AUTH";

  @IsString()
  @IsOptional()
  providerUserId?: string;

  @IsString()
  address: string;

  @IsNumber()
  @IsOptional()
  chainId?: number;
}
