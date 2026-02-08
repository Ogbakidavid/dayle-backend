import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): string {
    return `🚀 welcome to dayle backend running on http://localhost:${process.env.PORT || 4000}`;
  }
}
