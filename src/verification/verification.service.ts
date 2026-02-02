import { Injectable } from '@nestjs/common';

@Injectable()
export class VerificationService {
  async verify(id: string) {
    throw new Error("Method not implemented.");
  }
}
