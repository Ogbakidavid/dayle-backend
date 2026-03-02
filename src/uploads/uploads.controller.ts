import { Controller, Post, Body } from '@nestjs/common';
import { UploadsService } from './uploads.service';
import { GetPresignedUrlDto } from './dto/get-presigned-url.dto';

@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post('presigned-url')
  async getPresignedUrl(@Body() dto: GetPresignedUrlDto) {
    return this.uploadsService.getPresignedUrl(dto);
  }
}
