import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetPresignedUrlDto } from './dto/get-presigned-url.dto';
import { randomUUID } from 'crypto';

@Injectable()
export class UploadsService {
  private s3Client: S3Client;
  private bucketName: string;

  constructor(private configService: ConfigService) {
    this.s3Client = new S3Client({
      region: this.configService.get<string>('AWS_REGION')!,
      credentials: {
        accessKeyId: this.configService.get<string>('AWS_ACCESS_KEY_ID')!,
        secretAccessKey: this.configService.get<string>(
          'AWS_SECRET_ACCESS_KEY',
        )!,
      },
    });
    this.bucketName = this.configService.get<string>('AWS_S3_BUCKET')!;
  }

  async getPresignedUrl(dto: GetPresignedUrlDto) {
    const { fileName, fileType, purpose } = dto;
    const fileId = randomUUID();
    const extension = fileName.split('.').pop();
    const key = `${purpose}/${fileId}.${extension}`;

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      ContentType: fileType,
    });

    // Valid for 5 minutes (300 seconds)
    const uploadUrl = await getSignedUrl(this.s3Client as any, command as any, {
      expiresIn: 300,
    });

    // This is the public-ish URL we'll store, but it will require signed access for private buckets
    const fileUrl = `https://${this.bucketName}.s3.${this.configService.get('AWS_REGION')}.amazonaws.com/${key}`;

    return {
      url: uploadUrl,
      fileUrl,
      key, // We should store the key in DB for easy download URL generation later
      expiresIn: 300,
    };
  }

  /**
   * Generates a temporary download URL for a private S3 object
   */
  async getDownloadUrl(key: string, expiresInSeconds = 3600) {
    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    });

    return await getSignedUrl(this.s3Client as any, command as any, {
      expiresIn: expiresInSeconds,
    });
  }
}
