import { IsString, MinLength, MaxLength } from 'class-validator';

export class BankDetailsDto {
  @IsString()
  @MinLength(8)
  @MaxLength(17)
  accountNumber: string;

  @IsString()
  @MinLength(2)
  @MaxLength(100)
  bankName: string;

  @IsString()
  @MinLength(2)
  @MaxLength(100)
  accountName: string;
}
