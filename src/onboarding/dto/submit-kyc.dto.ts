import {
  IsString,
  MinLength,
  MaxLength,
  IsDateString,
  IsNotEmpty,
  IsOptional,
} from 'class-validator';

export class SubmitKycDto {
  @IsString()
  @IsOptional()
  firstName?: string;

  @IsString()
  @IsOptional()
  lastName?: string;

  @IsString()
  @IsOptional()
  country?: string;

  @IsString()
  @MinLength(2)
  @MaxLength(200)
  @IsOptional()
  fullName?: string;

  @IsDateString()
  dateOfBirth: string;

  @IsString()
  @MinLength(10)
  @MaxLength(500)
  @IsOptional()
  address?: string;

  @IsString()
  @IsNotEmpty()
  @IsOptional()
  idDocumentUrl?: string;

  @IsString()
  @IsOptional()
  proofOfAddressUrl?: string;

  @IsString()
  @IsOptional()
  idNumber?: string;

  @IsString()
  @IsOptional()
  idType?: string;
}
