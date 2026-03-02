import { IsString, IsInt, Min, Max, IsEnum } from 'class-validator';

export class GetPresignedUrlDto {
  @IsString()
  fileName: string;

  @IsString()
  fileType: string;

  @IsInt()
  @Min(1)
  @Max(104857600) // 100MB
  fileSize: number;

  @IsEnum(['kyc', 'deliverable', 'evidence'])
  purpose: 'kyc' | 'deliverable' | 'evidence';
}
