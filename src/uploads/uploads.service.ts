import { Injectable } from '@nestjs/common';
import { GetPresignedUrlDto } from './dto/get-presigned-url.dto';

@Injectable()
export class UploadsService {
  async getPresignedUrl(dto: GetPresignedUrlDto) {
    // Mockup presigned URL logic
    // In a real app, you'd use AWS S3 SDK here
    const fileId = Math.random().toString(36).substr(2, 9);
    const uploadUrl = `https://s3.amazonaws.com/dayle-uploads/mock-upload-${fileId}`;
    const fileUrl = uploadUrl;

    return {
      uploadUrl,
      fileUrl,
      expiresIn: 300,
    };
  }
}
