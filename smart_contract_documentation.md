# Dayle Smart Contract Documentation

Based on the analysis of `dayle-backend` (Vaults, Milestones, Ledger) and `dayle-frontend` (Privy/Smart Wallets), this document outlines the architecture for the Smart Contract (SC) system on the Celo blockchain.

## Overview

The Smart Contract system uses the **Factory Pattern with Minimal Proxy Clones (EIP-1167)**. This architecture ensures that:

1.  **Unique Address**: Every Vault has its own unique contract address on the Celo blockchain.
2.  **Gas Efficiency**: Deploying a clone is ~10x cheaper than a full contract deployment.
3.  **Isolation**: Funds are held in individual Vault clones, not a central pool.

**The system transacts exclusively in cUSD (Celo Dollar).**

### Core Components

1.  **VaultImplementation**: The master logic contract deployed once. Contains all functions (`deposit`, `release`, `refund`).
2.  **VaultFactory**: The entry point for creating new Vaults. It deploys "Clones" that point to the `VaultImplementation`.
3.  **Vault (Clone)**: The actual instance users interact with. It holds the state and funds for a specific job.
4.  **Arbiter**: The Dayle platform address (or multisig) for dispute resolution.

## Data Structures

### Vault State (Storage Layout)

_Note: Because we use proxies, we use an `initialize` function instead of a constructor._

```solidity
// Storage is layout-safe for upgradability if needed
bool public initialized;

enum MilestoneStatus { PENDING, FUNDED, RELEASED, REFUNDED, DISPUTED }

struct Milestone {
    uint256 id;
    uint256 amount;       // Amount in cUSD (18 decimals)
    MilestoneStatus status;
    address deliverableHash;
}

address public client;
address public freelancer;
address public arbiter;
address constant cUSD = 0x765DE816845861e75A25fCA122bb6898B8B1282a; // Celo Mainnet

mapping(uint256 => Milestone) public milestones;
uint256[] public milestoneIds;
```

## Functions

### 1. VaultFactory: Create Vault

Called by the **Client** to create a new gig.

- **Function**: `createVault(address _freelancer, address _arbiter, uint256[] _milestoneIds, uint256[] _amounts)`
- **Logic**:
  1.  Calls `Clones.clone(vaultImplementation)`.
  2.  Casts the new address to `Vault`.
  3.  Calls `Vault(newAddress).initialize(msg.sender, _freelancer, _arbiter, _milestoneIds, _amounts)`.
  4.  Emits `VaultCreated(newAddress, msg.sender, _freelancer)`.

### 2. Vault: Initialize

Called **only once** by the Factory immediately after cloning.

- **Function**: `initialize(address _client, ...)`
- **Logic**:
  - Checks `!initialized`.
  - Sets `initialized = true`.
  - Sets state variables (`client`, `freelancer`, `milestones`, etc.).

### 3. Vault: Fund (deposit)

Called by the **Client** to lock funds into the specific Vault clone.

- **Function**: `deposit(uint256 _amount)`
- **Logic**:
  - Transfers `_amount` cUSD from `msg.sender` to `address(this)`.
  - Updates internal accounting.
  - Emits `VaultFunded`.

### 4. Vault: Release Milestone (pay)

Called by **Client** or **Arbiter**.

- **Function**: `release(uint256 _milestoneId)`
- **Logic**:
  - Checks `msg.sender` authority.
  - Transfers cUSD from `address(this)` to `freelancer`.
  - Emits `MilestoneReleased`.

### 5. Vault: Refund Milestone (refund)

Called by **Freelancer** or **Arbiter**.

- **Function**: `refund(uint256 _milestoneId)`
- **Logic**:
  - Checks `msg.sender` authority.
  - Transfers cUSD from `address(this)` to `client`.
  - Emits `MilestoneRefunded`.

## Events

The backend listens to these events to sync the database.

- **From Factory**: `VaultCreated(address indexed vault, address indexed client, address indexed freelancer)`
- **From Vault**:
  - `VaultFunded(uint256 amount)`
  - `MilestoneReleased(uint256 milestoneId, address recipient, uint256 amount)`
  - `MilestoneRefunded(uint256 milestoneId, address recipient, uint256 amount)`
  - `DisputeOpened(uint256 milestoneId, address initiator)`

## Integration Flow

1.  **Frontend**: Client clicks "Fund Vault".
    - Web3 wallet triggers `token.approve(vaultAddress)` then `vault.fund()`.
2.  **Backend Listener**: Detects `VaultFunded` event.
    - Updates `Vault.status = ACTIVE`.
    - Creates `LedgerEntry` (DEPOSIT) in DB.
3.  **Frontend**: Client clicks "Approve Milestone".
    - Web3 wallet triggers `vault.release(milestoneId)`.
4.  **Backend Listener**: Detects `MilestoneReleased` event.
    - Updates `Milestone.status = VERIFIED`.
    - Creates `LedgerEntry` (RELEASE) in DB.

## Security Considerations

- **Arbiter Power**: The arbiter (Dayle) has ultimate control to resolve disputes. This is a "managed" decentralization model.
- **Reentrancy**: Use `ReentrancyGuard` on all transfer functions.
- **Token Safety**: Use `SafeERC20` for all token transfers.
