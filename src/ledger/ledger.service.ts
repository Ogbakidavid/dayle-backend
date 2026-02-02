import { Injectable } from '@nestjs/common';
import { CreateLedgerDto } from './dto/create-ledger.dto';
import { UpdateLedgerDto } from './dto/update-ledger.dto';

@Injectable()
export class LedgerService {
  create(createLedgerDto: CreateLedgerDto) {
    return 'This action adds a new ledger';
  }

  findAll() {
    return `This action returns all ledger`;
  }

  findOne(id: number) {
    return `This action returns a #${id} ledger`;
  }

  update(id: number, updateLedgerDto: UpdateLedgerDto) {
    return `This action updates a #${id} ledger`;
  }

  remove(id: number) {
    return `This action removes a #${id} ledger`;
  }
}
