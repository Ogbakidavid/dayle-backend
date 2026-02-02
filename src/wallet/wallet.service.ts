import { Injectable } from '@nestjs/common';
import { CreateWalletDto } from './dto/withdraw.dto';
import { UpdateWalletDto } from './dto/bank-details.dto';

@Injectable()
export class WalletService {
  create(createWalletDto: CreateWalletDto) {
    return 'This action adds a new wallet';
  }

  findAll() {
    return `This action returns all wallet`;
  }

  findOne(id: number) {
    return `This action returns a #${id} wallet`;
  }

  update(id: number, updateWalletDto: UpdateWalletDto) {
    return `This action updates a #${id} wallet`;
  }

  remove(id: number) {
    return `This action removes a #${id} wallet`;
  }
}
