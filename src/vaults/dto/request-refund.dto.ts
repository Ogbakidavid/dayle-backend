import { IsString, IsNotEmpty, IsObject } from 'class-validator';

export class RequestRefundDto {
  @IsString()
  @IsNotEmpty()
  payoutMethod: string; // 'bank' | 'card'

  @IsObject()
  @IsNotEmpty()
  payoutDetails: any; // { bankName, accountNumber, etc. }
}
