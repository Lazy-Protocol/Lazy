# LazyUSD Vault

A secure, yield-bearing USDC vault with share-based NAV accounting and async withdrawals.

## Overview

The LazyUSD Vault allows users to deposit USDC and receive shares representing their proportional ownership. Yield from external strategies is reported by the owner, and all shareholders benefit proportionally.

### Key Features

- **Share-based accounting** - 1 USDC = 1 share initially, price adjusts with yield
- **Async withdrawal queue** - FIFO processing with cooldown period
- **Share escrow** - Prevents double-spend attacks on withdrawals
- **Protocol fees** - Only charged on yield, paid via share dilution
- **Multi-role governance** - Owner, Operator roles via external RoleManager

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        LazyUSDVault                          │
│            (ERC20 shares + yield tracking + withdrawals)         │
└─────────────────────────────────────┬────────────────────────────┘
                                      │
                                      ▼
                              ┌───────────────┐
                              │  RoleManager  │
                              │  (Governance) │
                              └───────────────┘
```

### OpenZeppelin Usage

OpenZeppelin is used only for **mechanical safety guarantees**:

| Contract | OZ Module | Purpose |
|----------|-----------|---------|
| LazyUSDVault | ERC20 | Share token mechanics (vault IS the token) |
| LazyUSDVault | ReentrancyGuard | Cross-function reentrancy protection |
| LazyUSDVault | IERC20 | Standard interface for USDC |

**Not using OpenZeppelin Ownable/Pausable** - Governance is delegated to an external RoleManager to support multi-role access, three-state pause, and upgradeable governance without redeploying the vault.

## Installation

```bash
# Clone the repository
git clone https://github.com/sirmoremoney/AYP.git
cd AYP

# Install dependencies
forge install
```

## Usage

### Build

```bash
forge build
```

### Test

```bash
forge test
```

### Test with Coverage

```bash
forge coverage
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) - System design and data flows
- [Invariants](docs/INVARIANTS.md) - Formal security invariants
- [User Guide](docs/USER_GUIDE.md) - How to interact with the vault
- [Security Audit](SECURITY_AUDIT_REPORT.md) - Security analysis report

## Security

### Invariants

1. **I.1 - Conservation of Value**: USDC only exits when shares are burned at current NAV
2. **I.2 - Share Escrow Safety**: Escrowed shares cannot be double-spent
3. **I.3 - Universal NAV Application**: All shares rise and fall together
4. **I.4 - Fee Isolation**: Fees only on yield, only via share minting
5. **I.5 - Withdrawal Queue Liveness**: FIFO order, graceful degradation

### Trust Assumptions

| Entity | Trust Level | Control |
|--------|-------------|---------|
| Owner | High | Can pause, update parameters, report yield |
| Operator | Medium | Can fulfill withdrawals, pause (not unpause) |
| Multisig | Medium | Holds strategy funds |

## License

MIT
