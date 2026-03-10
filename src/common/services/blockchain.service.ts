import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import {
  LedgerEntryType,
  TransactionStatus,
  VaultStatus,
} from '../../domain/enums';

// ABIs
let VaultFactoryABI: any = [];
let VaultImplementationABI: any = [];
try {
  VaultFactoryABI = require('../abis/VaultFactory.json');
  VaultImplementationABI = require('../abis/VaultImplementation.json');
  // Some tools might export { abi: [...] }, others just the array
  if (VaultFactoryABI.abi) VaultFactoryABI = VaultFactoryABI.abi;
  if (VaultImplementationABI.abi)
    VaultImplementationABI = VaultImplementationABI.abi;
} catch (e) {
  // Ignore in testing environments
}

@Injectable()
export class BlockchainService implements OnModuleInit {
  private readonly logger = new Logger(BlockchainService.name);
  private provider: ethers.JsonRpcProvider;
  private factoryContract: ethers.Contract;
  private treasuryWallet: ethers.Wallet;
  private cusdContract: ethers.Contract;
  private usingWebSocket = false;
  private factoryLastProcessedBlock = 0;
  private vaultLastProcessedBlock: Map<string, number> = new Map();
  private activeVaults: Set<string> = new Set();

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {}

  onModuleInit() {
    this.initializeProvider();
  }

  private initializeProvider() {
    const rpcUrl = this.configService.get<string>('CELO_RPC_URL');
    const factoryAddress = this.configService.get<string>(
      'VAULT_FACTORY_ADDRESS',
    );

    if (!rpcUrl || !factoryAddress) {
      this.logger.warn(
        'Blockchain config missing. Skipping block listener initialization.',
      );
      return;
    }

    // Check for WebSocket URL
    const wssUrl = this.configService.get<string>('CELO_WSS_URL');

    if (wssUrl) {
      this.logger.log('Connecting to blockchain via WebSocket...');
      this.provider = new ethers.WebSocketProvider(wssUrl) as any;
      this.usingWebSocket = true;
    } else {
      this.logger.log('Connecting to blockchain via HTTP Polling...');
      this.provider = new ethers.JsonRpcProvider(rpcUrl, undefined, {
        staticNetwork: true,
      });
      this.provider.pollingInterval = 4000;
      this.usingWebSocket = false;
    }

    this.provider.on('error', (error) => {
      this.logger.error('Blockchain Provider Error:', error);
      // Logic to re-initialize listeners if the connection is lost
      setTimeout(() => this.initializeProvider(), 5000);
    });

    // Initialize Treasury Wallet
    const treasuryPrivateKey = this.configService.get<string>(
      'TREASURY_PRIVATE_KEY',
    );
    if (treasuryPrivateKey) {
      this.treasuryWallet = new ethers.Wallet(
        treasuryPrivateKey,
        this.provider,
      );
      this.logger.log(
        `Initialized Treasury Wallet: ${this.treasuryWallet.address}`,
      );
    } else {
      this.logger.warn(
        'TREASURY_PRIVATE_KEY is missing. Fiat-to-crypto auto-funding will fail.',
      );
    }

    // Pass ABI directly as in ethers v6
    this.factoryContract = new ethers.Contract(
      factoryAddress,
      VaultFactoryABI,
      this.provider,
    );

    this.startEventListeners();
  }

  private startEventListeners() {
    this.logger.log('Starting blockchain event listeners...');

    if (this.usingWebSocket) {
      // WebSocket: use contract.on which uses WS subscriptions
      this.logger.log('Using WebSocket subscriptions for events.');
      this.factoryContract.on(
        'VaultCreated',
        async (vaultAddress, client, freelancer, token, amount, event) => {
          this.logger.log(`Blockchain: New vault created at ${vaultAddress} with token ${token}`);
          this.listenToVault(vaultAddress);
        },
      );

      void this.attachListenersToActiveVaults();
    } else {
      // HTTP polling: avoid contract.on which creates ephemeral JSON-RPC filters
      this.logger.log('Using HTTP block-polling + queryFilter for events.');

      void (async () => {
        let attempts = 0;
        const maxAttempts = 3;
        while (attempts < maxAttempts) {
          try {
            const current = await this.provider.getBlockNumber();
            this.factoryLastProcessedBlock = current;
            // initialize active vaults' last block to current
            const activeVaults = await this.prisma.vault.findMany({
              where: {
                vaultAddress: { not: '' },
                status: { notIn: [VaultStatus.CANCELLED] },
              },
              select: { vaultAddress: true },
            });
            for (const v of activeVaults) {
              if (v.vaultAddress) {
                this.activeVaults.add(v.vaultAddress);
                this.vaultLastProcessedBlock.set(v.vaultAddress, current);
              }
            }
            break; // Success!
          } catch (e) {
            attempts++;
            if (attempts >= maxAttempts) {
              this.logger.error('Error initializing block polling state after retries', e);
            } else {
              this.logger.warn(`Prisma init attempt ${attempts} failed, retrying in 5s...`);
              await new Promise(resolve => setTimeout(resolve, 5000));
            }
          }
        }
      })();

      // Poll on new blocks and query logs for relevant events
      void this.provider.on('block', (blockNumber: number) => {
        void (async () => {
          try {
            // Factory VaultCreated events
            const fromFactory = this.factoryLastProcessedBlock + 1;
            if (blockNumber >= fromFactory) {
              const filter = this.factoryContract.filters.VaultCreated();
              const events = await this.factoryContract.queryFilter(
                filter,
                fromFactory,
                blockNumber,
              );
              for (const evt of events) {
                try {
                  const event = evt as ethers.EventLog;
                  const vaultAddress = event.args[0] as string;
                  const token = event.args[3] as string;
                  this.logger.log(
                    `Blockchain (polled): New vault created at ${vaultAddress} with token ${token}`,
                  );
                  this.listenToVault(vaultAddress);
                } catch (e) {
                  this.logger.error('Error processing VaultCreated event', e);
                }
              }
              this.factoryLastProcessedBlock = blockNumber;
            }

            // Per-vault events: Deposited and VaultReleased
            for (const vaultAddress of Array.from(this.activeVaults)) {
              const last =
                this.vaultLastProcessedBlock.get(vaultAddress) ?? blockNumber;
              const from = last + 1;
              if (blockNumber < from) continue;

              try {
                if (!vaultAddress || vaultAddress.trim() === '') {
                  continue;
                }
                const vaultContract = new ethers.Contract(
                  vaultAddress,
                  VaultImplementationABI as ethers.InterfaceAbi,
                  this.provider,
                );
                const depositFilter = vaultContract.filters.Deposited();
                const depositedEvents = await vaultContract.queryFilter(
                  depositFilter,
                  from,
                  blockNumber,
                );
                for (const evt of depositedEvents) {
                  const event = evt as ethers.EventLog;
                  const amount = event.args[1] as bigint;
                  
                  // Handle handles deposit
                  void (async () => {
                    const vault = await (this.prisma.vault.findUnique as any)({
                      where: { vaultAddress },
                    });
                    if (!vault) return;

                    this.logger.log(
                        `Blockchain (polled): Deposited ${ethers.formatUnits(amount, vault.tokenDecimals)} ${vault.tokenSymbol || 'token'} into ${vaultAddress}`,
                    );

                    const pendingEntry =
                      await this.prisma.ledgerEntry.findFirst({
                        where: {
                          vaultId: vault.id,
                          type: LedgerEntryType.DEPOSIT,
                          status: TransactionStatus.PENDING,
                        },
                      });

                    if (pendingEntry) {
                      await this.prisma.ledgerEntry.update({
                        where: { id: pendingEntry.id },
                        data: {
                          status: TransactionStatus.CONFIRMED,
                          providerRef: evt.transactionHash,
                        },
                      });
                    }

                    await this.prisma.vault.update({
                      where: { id: vault.id },
                      data: { status: VaultStatus.FUNDED },
                    });
                  })();
                }

                const releaseFilter = vaultContract.filters.VaultReleased();
                const releasedEvents = await vaultContract.queryFilter(
                  releaseFilter,
                  from,
                  blockNumber,
                );
                for (const evt of releasedEvents) {
                  this.logger.log(
                    `Blockchain (polled): Funds released in ${vaultAddress}`,
                  );
                  (async () => {
                    const vault = await this.prisma.vault.findUnique({
                      where: { vaultAddress },
                    });
                    if (!vault) return;
                    await this.prisma.vault.update({
                      where: { id: vault.id },
                      data: { status: VaultStatus.RELEASED },
                    });
                  })();
                }

                this.vaultLastProcessedBlock.set(vaultAddress, blockNumber);
              } catch (e) {
                this.logger.error(
                  `Error polling events for vault ${vaultAddress}`,
                  e,
                );
              }
            }
          } catch (e) {
            this.logger.error('Error in block polling handler', e);
          }
        })();
      });
    }
  }

  private async attachListenersToActiveVaults() {
    const activeVaults = await this.prisma.vault.findMany({
      where: {
        vaultAddress: { not: null },
        status: { notIn: [VaultStatus.CANCELLED] },
      },
    });

    for (const vault of activeVaults) {
      this.listenToVault(vault.vaultAddress!);
    }
  }

  public listenToVault(vaultAddress: string) {
    if (!vaultAddress || vaultAddress.trim() === '') return;
    if (this.usingWebSocket) {
      const vaultContract = new ethers.Contract(
        vaultAddress,
        VaultImplementationABI,
        this.provider,
      );

      // Deposit Event (Client funded)
      vaultContract.on('Deposited', async (from, amount, newBalance, event) => {
        const vault = await (this.prisma.vault.findUnique as any)({
          where: { vaultAddress },
        });
        if (!vault) return;

        this.logger.log(
          `Blockchain: Deposited ${ethers.formatUnits(amount, vault.tokenDecimals)} ${vault.tokenSymbol || 'token'} into ${vaultAddress}`,
        );

        const pendingEntry = await this.prisma.ledgerEntry.findFirst({
          where: {
            vaultId: vault.id,
            type: LedgerEntryType.DEPOSIT,
            status: TransactionStatus.PENDING,
          },
        });

        if (pendingEntry) {
          await this.prisma.ledgerEntry.update({
            where: { id: pendingEntry.id },
            data: {
              status: TransactionStatus.CONFIRMED,
              providerRef: event.log.transactionHash,
            },
          });
        }

        await this.prisma.vault.update({
          where: { id: vault.id },
          data: { status: VaultStatus.FUNDED },
        });
      });

      // Vault Released (Freelancer getting paid)
      vaultContract.on('VaultReleased', async (freelancer, amount, event) => {
        this.logger.log(`Blockchain: Funds released in ${vaultAddress}`);
        const vault = await this.prisma.vault.findUnique({
          where: { vaultAddress },
        });
        if (!vault) return;

        await this.prisma.vault.update({
          where: { id: vault.id },
          data: { status: VaultStatus.RELEASED },
        });
      });
    } else {
      // HTTP polling mode: register vault for block-polling processing
      this.activeVaults.add(vaultAddress);
      (async () => {
        try {
          const current = await this.provider.getBlockNumber();
          // start from current block so we don't re-process huge history by default
          this.vaultLastProcessedBlock.set(vaultAddress, current);
        } catch (e) {
          this.logger.error(
            `Error initializing poll state for vault ${vaultAddress}`,
            e,
          );
        }
      })();
    }
  }

  /**
   * Transfer testnet cUSD from the Treasury Wallet to a specific address.
   * Used to bridge Fiat webhooks to Crypto escrows entirely on the backend.
   */
  /**
   * Used to bridge Fiat webhooks to Crypto escrows entirely on the backend.
   */
  public async transferTestnetToken(
    toAddress: string,
    amountWei: bigint,
    tokenAddress: string,
  ): Promise<string> {
    if (!this.treasuryWallet) {
      throw new Error(
        'Treasury Wallet not configured. Cannot process local bridge transfer.',
      );
    }

    try {
      this.logger.log(
        `Initiating Treasury transfer of ${amountWei} atomic units of token ${tokenAddress} to ${toAddress}`,
      );

      const erc20Abi = [
        'function transfer(address to, uint256 value) public returns (bool)',
        'function balanceOf(address owner) view returns (uint256)',
      ];
      const tokenContract = new ethers.Contract(
        tokenAddress,
        erc20Abi,
        this.treasuryWallet,
      );

      // Check Balance First
      const balance = await tokenContract.balanceOf(
        this.treasuryWallet.address,
      );
      if (balance < amountWei) {
        throw new Error(
          `Treasury Wallet has insufficient token balance. Need ${amountWei}, have ${balance}`,
        );
      }

      const tx = await tokenContract.transfer(toAddress, amountWei);
      this.logger.log(
        `Transfer transaction sent: ${tx.hash}. Waiting for confirmation...`,
      );

      const receipt = await tx.wait();
      this.logger.log(`Transfer confirmed in block ${receipt.blockNumber}`);

      return receipt.hash;
    } catch (error) {
      this.logger.error(
        `Error transferring testnet token to ${toAddress}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Deploy a new Vault via the Factory using the Treasury/Relayer wallet (Arbiter)
   */
  public async deployVault(
    clientAddress: string,
    freelancerAddress: string,
    amountUSD: string,
    tokenAddress: string,
  ): Promise<{ vaultAddress: string; txHash: string }> {
    if (!this.treasuryWallet) {
      throw new Error('Treasury Wallet not configured. Cannot deploy vault.');
    }

    try {
      this.logger.log(
        `Deploying vault on-chain: Client=${clientAddress}, Freelancer=${freelancerAddress}, Amount=${amountUSD}`,
      );

      if (!this.factoryContract) {
        throw new Error('factoryContract is undefined');
      }

      const factoryWithSigner = this.factoryContract.connect(
        this.treasuryWallet,
      ) as any;
      const erc20Interface = new ethers.Interface([
        'function decimals() view returns (uint8)',
      ]);
      const tokenContract = new ethers.Contract(tokenAddress, erc20Interface, this.provider);
      const decimals = await tokenContract.decimals();
      const amountWei = ethers.parseUnits(amountUSD, decimals);

      // Call createVaultFor(address client, address freelancer, address token, uint256 amount)
      this.logger.log(
        `Calling createVaultFor: Client=${clientAddress}, Freelancer=${freelancerAddress}, Token=${tokenAddress}`,
      );
      const tx = await factoryWithSigner.createVaultFor(
        clientAddress,
        freelancerAddress,
        amountWei,
        tokenAddress,
      );
      this.logger.log(`Vault deployment transaction sent: ${tx.hash}`);

      const receipt = await tx.wait();

      // The VaultCreated event emits: (address vaultAddress, address client, address freelancer, address arbiter, address treasury, uint256 protocolFeeBps, uint256 amount)
      // In ethers v6, we look for the event in the receipt logs
      const event = receipt.logs.find((log: any) => {
        try {
          const parsed = this.factoryContract.interface.parseLog(log);
          return parsed && parsed.name === 'VaultCreated';
        } catch (e) {
          return false;
        }
      });

      if (!event) {
        throw new Error('VaultCreated event not found in transaction receipt');
      }

      const parsedEvent = this.factoryContract.interface.parseLog(event as any);
      const vaultAddress = parsedEvent!.args[0];

      this.logger.log(`Vault deployed on-chain at: ${vaultAddress}`);
      return { vaultAddress, txHash: receipt.hash };
    } catch (error) {
      this.logger.error('Error deploying vault on-chain:', error);
      throw error;
    }
  }

  /**
   * Deposit Mock token directly into a specific Vault from the Treasury (Arbiter relayer)
   */
  public async depositToVault(
    vaultAddress: string,
    amountWei: bigint,
    tokenAddress: string,
  ): Promise<string> {
    if (!this.treasuryWallet) {
      throw new Error(
        'Treasury/Arbiter Wallet not configured.',
      );
    }

    try {
      this.logger.log(
        `Backend funding vault ${vaultAddress} with ${amountWei} atomic units using sponsored gas...`,
      );

      // 1. Check if Treasury/Arbiter already has enough tokens
      const erc20Abi = [
        'function approve(address spender, uint256 value) public returns (bool)',
        'function mint(address to, uint256 amount) public',
        'function balanceOf(address owner) view returns (uint256)',
      ];
      const tokenContract = new ethers.Contract(
        tokenAddress,
        erc20Abi,
        this.treasuryWallet,
      );

      const balance = await tokenContract.balanceOf(this.treasuryWallet.address);
      this.logger.log(`Arbiter balance for token ${tokenAddress}: ${balance}`);

      if (balance < amountWei) {
        // 2. Try to mint if balance is insufficient
        this.logger.log(`Insufficient balance. Attempting to mint ${amountWei} tokens to Arbiter for funding...`);
        try {
          const mintTx = await tokenContract.mint(this.treasuryWallet.address, amountWei);
          await mintTx.wait();
          this.logger.log(`Successfully minted tokens.`);
        } catch (mintError: any) {
          this.logger.error(`Failed to mint tokens: ${mintError.message}`);
          throw new Error(
            `Arbiter wallet ${this.treasuryWallet.address} has insufficient balance (${balance}) and could not mint tokens (${tokenAddress}). Please fund the Arbiter account manually.`,
          );
        }
      } else {
        this.logger.log(`Arbiter has sufficient balance, skipping mint.`);
      }

      // 3. Approve the Vault to spend Treasury tokens
      this.logger.log(`Approving Vault ${vaultAddress} to spend Arbiter tokens...`);
      const approveTx = await tokenContract.approve(vaultAddress, amountWei);
      await approveTx.wait();

      // 4. Call deposit() on the vault (Sponsored as Arbiter)
      const vaultContract = new ethers.Contract(
        vaultAddress,
        VaultImplementationABI,
        this.treasuryWallet,
      );

      const depositTx = await vaultContract.deposit(amountWei);
      const receipt = await depositTx.wait();

      this.logger.log(
        `Vault ${vaultAddress} successfully funded on-chain: ${receipt.hash}`,
      );
      return receipt.hash;
    } catch (error) {
      this.logger.error(`Error funding vault ${vaultAddress} on-chain:`, error);
      throw error;
    }
  }

  /**
   * Release funds from a vault to the freelancer and treasury
   */
  public async releaseVault(vaultAddress: string): Promise<string> {
    if (!this.treasuryWallet) {
      throw new Error('Treasury/Arbiter Wallet not configured.');
    }

    try {
      this.logger.log(`Backend releasing vault ${vaultAddress} on-chain...`);
      const vaultContract = new ethers.Contract(
        vaultAddress,
        VaultImplementationABI,
        this.treasuryWallet,
      );

      const tx = await vaultContract.release();
      const receipt = await tx.wait();

      this.logger.log(
        `Vault ${vaultAddress} successfully released on-chain: ${receipt.hash}`,
      );
      return receipt.hash;
    } catch (error) {
      this.logger.error(
        `Error releasing vault ${vaultAddress} on-chain:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Refund funds from a vault back to the client
   */
  public async refundVault(vaultAddress: string): Promise<string> {
    if (!this.treasuryWallet) {
      throw new Error('Treasury/Arbiter Wallet not configured.');
    }

    try {
      this.logger.log(`Backend refunding vault ${vaultAddress} on-chain...`);
      const vaultContract = new ethers.Contract(
        vaultAddress,
        VaultImplementationABI,
        this.treasuryWallet,
      );

      const tx = await vaultContract.refund();
      const receipt = await tx.wait();

      this.logger.log(
        `Vault ${vaultAddress} successfully refunded on-chain: ${receipt.hash}`,
      );
      return receipt.hash;
    } catch (error) {
      this.logger.error(`Error refunding vault ${vaultAddress} on-chain:`, error);
      throw error;
    }
  }

  /**
   * Update the freelancer address on a deployed Vault (Arbiter relayer)
   */
  public async updateVaultFreelancer(
    vaultAddress: string,
    newFreelancerAddress: string,
  ): Promise<string> {
    if (!this.treasuryWallet) {
      throw new Error('Treasury/Arbiter Wallet not configured.');
    }

    try {
      this.logger.log(
        `Updating freelancer for Vault ${vaultAddress} to ${newFreelancerAddress}...`,
      );
      const vaultContract = new ethers.Contract(
        vaultAddress,
        VaultImplementationABI,
        this.treasuryWallet,
      );

      const tx = await vaultContract.updateFreelancer(newFreelancerAddress);
      const receipt = await tx.wait();

      this.logger.log(
        `Freelancer updated for Vault ${vaultAddress}: ${receipt.hash}`,
      );
      return receipt.hash;
    } catch (error) {
      this.logger.error(
        `Error updating freelancer for vault ${vaultAddress}:`,
        error,
      );
      throw error;
    }
  }
}
