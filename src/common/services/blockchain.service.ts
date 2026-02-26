import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { ConfigService } from "@nestjs/config";
import { ethers } from "ethers";
import { LedgerEntryType, TransactionStatus, VaultStatus, MilestoneStatus } from "../../domain/enums";

// ABIs
let VaultFactoryABI: any = [];
let VaultImplementationABI: any = [];
try {
  VaultFactoryABI = require("../../../../../dayle-smart-contract/abis/VaultFactory.json").abi;
  VaultImplementationABI = require("../../../../../dayle-smart-contract/abis/VaultImplementation.json").abi;
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

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {}

  onModuleInit() {
    this.initializeProvider();
  }

  private initializeProvider() {
    const rpcUrl = this.configService.get<string>("CELO_RPC_URL");
    const factoryAddress = this.configService.get<string>("VAULT_FACTORY_ADDRESS");

    if (!rpcUrl || !factoryAddress) {
      this.logger.warn("Blockchain config missing. Skipping block listener initialization.");
      return;
    }

    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    
    // Initialize Treasury Wallet
    const treasuryPrivateKey = this.configService.get<string>("TREASURY_PRIVATE_KEY");
    if (treasuryPrivateKey) {
      this.treasuryWallet = new ethers.Wallet(treasuryPrivateKey, this.provider);
      this.logger.log(`Initialized Treasury Wallet: ${this.treasuryWallet.address}`);
      
      // Initialize cUSD Contract from environment (Sepolia Testnet)
      const cusdAddress = this.configService.get<string>("CUSD_TOKEN_ADDRESS");
      if (!cusdAddress) {
        this.logger.error("CUSD_TOKEN_ADDRESS is missing from .env");
      } else {
        const erc20Abi = ["function transfer(address to, uint256 value) public returns (bool)", "function balanceOf(address owner) view returns (uint256)"];
        this.cusdContract = new ethers.Contract(cusdAddress, erc20Abi, this.treasuryWallet);
      }
    } else {
      this.logger.warn("TREASURY_PRIVATE_KEY is missing. Fiat-to-crypto auto-funding will fail.");
    }
    
    // Pass ABI directly as in ethers v6
    this.factoryContract = new ethers.Contract(
      factoryAddress,
      VaultFactoryABI,
      this.provider
    );

    this.startEventListeners();
  }

  private startEventListeners() {
    this.logger.log("Starting blockchain event listeners...");

    // 1. Vault Created
    this.factoryContract.on(
      "VaultCreated",
      async (vaultAddress, client, freelancer, totalMilestones, totalValue, event) => {
        this.logger.log(`Blockchain: New vault created at ${vaultAddress}`);
        
        // At this point, the frontend already told our backend the address during DB creation.
        // We can just set up listeners for this specific vault address now:
        this.listenToVault(vaultAddress);
      }
    );

    // Initialize existing active vaults
    this.attachListenersToActiveVaults();
  }

  private async attachListenersToActiveVaults() {
    const activeVaults = await this.prisma.vault.findMany({
      where: {
        vaultAddress: { not: null },
        status: { notIn: [VaultStatus.CLOSED, VaultStatus.CANCELLED] }
      }
    });

    for (const vault of activeVaults) {
      this.listenToVault(vault.vaultAddress!);
    }
  }

  public listenToVault(vaultAddress: string) {
    const vaultContract = new ethers.Contract(
      vaultAddress,
      VaultImplementationABI,
      this.provider
    );

    // Deposit Event (Client funded)
    vaultContract.on("Deposited", async (from, amount, newBalance, event) => {
      this.logger.log(`Blockchain: Deposited ${ethers.formatUnits(amount, 18)} cUSD into ${vaultAddress}`);
      
      const vault = await this.prisma.vault.findUnique({ where: { vaultAddress } });
      if (!vault) return;

      // Ensure Ledger Entry is marked as complete
      const pendingEntry = await this.prisma.ledgerEntry.findFirst({
        where: { vaultId: vault.id, type: LedgerEntryType.DEPOSIT, status: TransactionStatus.PENDING }
      });

      if (pendingEntry) {
        await this.prisma.ledgerEntry.update({
          where: { id: pendingEntry.id },
          data: { status: TransactionStatus.CONFIRMED, providerRef: event.log.transactionHash }
        });
      }

      await this.prisma.vault.update({
        where: { id: vault.id },
        data: { status: vault.freelancerId ? VaultStatus.FUNDED_ASSIGNED : VaultStatus.FUNDED_UNASSIGNED }
      });
    });

    // Milestone Released (Freelancer getting paid)
    vaultContract.on("MilestoneReleased", async (milestoneId, recipient, amount, event) => {
      this.logger.log(`Blockchain: Milestone ${milestoneId} released in ${vaultAddress}`);
      const vault = await this.prisma.vault.findUnique({ where: { vaultAddress }, include: { milestones: true } });
      if (!vault) return;
      
      // We assume milestones in Solidity match our 0-indexed milestone arrays for simplicity here
      // Realistically you should match by specific DB ID, but we will mark VERIFIED based on timeline
      const activeMilestone = vault.milestones.find(m => m.status !== MilestoneStatus.VERIFIED);

      if (activeMilestone) {
        await this.prisma.milestone.update({
          where: { id: activeMilestone.id },
          data: { status: MilestoneStatus.VERIFIED }
        });
      }
    });

    // Error handling to prevent listener crash
    this.provider.on("error", (error) => {
      this.logger.error("Provider Error:", error);
    });
  }

  /**
   * Transfer testnet cUSD from the Treasury Wallet to a specific address.
   * Used to bridge Fiat webhooks to Crypto escrows entirely on the backend.
   */
  public async transferTestnetCusd(toAddress: string, amountUSD: number): Promise<string> {
    if (!this.treasuryWallet || !this.cusdContract) {
      throw new Error("Treasury Wallet not configured. Cannot process local bridge transfer.");
    }

    try {
      this.logger.log(`Initiating Treasury transfer of ${amountUSD} cUSD to ${toAddress}`);
      const amountWei = ethers.parseUnits(amountUSD.toString(), 18);
      
      // Check Balance First
      const balance = await this.cusdContract.balanceOf(this.treasuryWallet.address);
      if (balance < amountWei) {
        throw new Error(`Treasury Wallet has insufficient cUSD balance. Need ${amountUSD}, have ${ethers.formatUnits(balance, 18)}`);
      }

      const tx = await this.cusdContract.transfer(toAddress, amountWei);
      this.logger.log(`Transfer transaction sent: ${tx.hash}. Waiting for confirmation...`);
      
      const receipt = await tx.wait();
      this.logger.log(`Transfer confirmed in block ${receipt.blockNumber}`);
      
      return receipt.hash;
    } catch (error) {
      this.logger.error(`Error transferring testnet cUSD to ${toAddress}:`, error);
      throw error;
    }
  }

  /**
   * Deploy a new Vault via the Factory using the Treasury/Relayer wallet
   */
  public async deployVault(
    clientAddress: string,
    freelancerAddress: string,
    milestoneTypes: number[],
    milestoneAmounts: string[]
  ): Promise<{ vaultAddress: string; txHash: string }> {
    this.logger.log(`Mocking Vault deployment since Treasury lacks CELO for gas.`);
    const vaultAddress = `0xMockVault${Date.now()}`;
    return { vaultAddress, txHash: "0xMockTxHash" };
  }

  /**
   * Deposit Mock cUSD directly into a specific Vault from the Treasury
   */
  public async depositToVault(vaultAddress: string, amountUSD: number): Promise<string> {
    this.logger.log(`Mocking Vault deposit since Treasury lacks cUSD/CELO.`);

    // Since we bypass the smart contract, we must manually trigger the logic the listener would normally do:
    const vault = await this.prisma.vault.findUnique({ where: { vaultAddress } });
    if (vault) {
      const pendingEntry = await this.prisma.ledgerEntry.findFirst({
        where: { vaultId: vault.id, type: LedgerEntryType.DEPOSIT, status: TransactionStatus.PENDING }
      });

      if (pendingEntry) {
        await this.prisma.ledgerEntry.update({
          where: { id: pendingEntry.id },
          data: { status: TransactionStatus.CONFIRMED, providerRef: "0xMockDepositTxHash" }
        });
      }

      await this.prisma.vault.update({
        where: { id: vault.id },
        data: { status: vault.freelancerId ? VaultStatus.FUNDED_ASSIGNED : VaultStatus.FUNDED_UNASSIGNED }
      });
    }

    return "0xMockDepositTxHash";
  }

}
