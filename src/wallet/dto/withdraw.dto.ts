import {
  IsNumber,
  IsObject,
  IsUUID,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { BankDetailsDto } from "./bank-details.dto";

export class WithdrawDto {
  @IsNumber()
  @Min(1)
  amount: number;

  @IsObject()
  @ValidateNested()
  @Type(() => BankDetailsDto)
  bankDetails: BankDetailsDto;

  @IsUUID()
  idempotencyKey: string;
}