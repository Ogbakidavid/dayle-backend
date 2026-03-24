import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CryptoService } from './crypto.service';

describe('CryptoService', () => {
  let service: CryptoService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CryptoService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string) => {
              if (key === 'ENCRYPTION_KEY') {
                return '785541e2a1527b3b47a49f0e40362e82a7f31580a8917235603eaa0b34fa7108';
              }
              return null;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<CryptoService>(CryptoService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should encrypt and decrypt a string correctly', () => {
    const originalText = '12345678901';
    const encrypted = service.encrypt(originalText);
    
    expect(encrypted).toBeDefined();
    expect(encrypted).toContain(':');
    
    const decrypted = service.decrypt(encrypted);
    expect(decrypted).toBe(originalText);
  });

  it('should never return the original text in encrypted form', () => {
    const originalText = '12345678901';
    const encrypted = service.encrypt(originalText);
    
    expect(encrypted).not.toContain(originalText);
  });

  it('should produce different encrypted output for the same input (due to IV)', () => {
    const text = 'test-string';
    const enc1 = service.encrypt(text);
    const enc2 = service.encrypt(text);
    
    expect(enc1).not.toBe(enc2);
  });
});
