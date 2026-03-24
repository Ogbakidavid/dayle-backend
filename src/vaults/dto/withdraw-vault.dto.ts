import { IsString, IsNotEmpty } from 'class-validator';

export class WithdrawVaultDto {
  @IsString()
  @IsNotEmpty()
  accountNumber: string;

  @IsString()
  @IsNotEmpty()
  bankCode: string;

  @IsString()
  @IsNotEmpty()
  accountName: string;
}
