import { createPublicClient, http, formatUnits } from 'viem';
import { mainnet } from 'viem/chains';

// Configuration
const VAULT_ADDRESS = process.env.VAULT_ADDRESS || '0xd53B68fB4eb907c3c1E348CD7d7bEDE34f763805';
const RPC_URL = process.env.ETH_RPC_URL || 'https://eth.llamarpc.com';

const vaultAbi = [
    {
        name: 'withdrawalQueueHead',
        type: 'function',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type: 'uint256' }],
    },
    {
        name: 'withdrawalQueueLength',
        type: 'function',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type: 'uint256' }],
    },
    {
        name: 'getWithdrawalRequest',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'requestId', type: 'uint256' }],
        outputs: [{
            components: [
                { name: 'requester', type: 'address' },
                { name: 'shares', type: 'uint256' },
                { name: 'requestTimestamp', type: 'uint256' }
            ],
            internalType: 'struct IVault.WithdrawalRequest',
            name: '',
            type: 'tuple'
        }],
    },
    {
        name: 'cooldownPeriod',
        type: 'function',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type: 'uint256' }],
    },
    {
        name: 'sharePrice',
        type: 'function',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type: 'uint256' }],
    },
    {
        name: 'pendingWithdrawals',
        type: 'function',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type: 'uint256' }],
    },
    {
        name: 'availableLiquidity',
        type: 'function',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type: 'uint256' }],
    }
];

async function checkWithdrawals() {
    console.log('='.repeat(60));
    console.log('CHECKING PENDING WITHDRAWALS');
    console.log(`Vault: ${VAULT_ADDRESS}`);
    console.log(`RPC: ${RPC_URL}`);
    console.log('='.repeat(60));

    const client = createPublicClient({
        chain: mainnet,
        transport: http(RPC_URL),
    });

    try {
        const [head, length, cooldown, sharePrice, totalPendingShares, liquidity] = await Promise.all([
            client.readContract({ address: VAULT_ADDRESS, abi: vaultAbi, functionName: 'withdrawalQueueHead' }),
            client.readContract({ address: VAULT_ADDRESS, abi: vaultAbi, functionName: 'withdrawalQueueLength' }),
            client.readContract({ address: VAULT_ADDRESS, abi: vaultAbi, functionName: 'cooldownPeriod' }),
            client.readContract({ address: VAULT_ADDRESS, abi: vaultAbi, functionName: 'sharePrice' }),
            client.readContract({ address: VAULT_ADDRESS, abi: vaultAbi, functionName: 'pendingWithdrawals' }),
            client.readContract({ address: VAULT_ADDRESS, abi: vaultAbi, functionName: 'availableLiquidity' }),
        ]);

        const currentTimestamp = Math.floor(Date.now() / 1000);
        const price = parseFloat(formatUnits(sharePrice, 6)); // Share price is 6 decimals (USDC), representing USDC value per share

        console.log(`Queue Head: ${head}`);
        console.log(`Queue Length: ${length}`);
        console.log(`Pending Requests: ${length - head}`);
        console.log(`Cooldown Period: ${Number(cooldown) / 3600} hours`);
        console.log(`Share Price: $${price.toFixed(6)}`);
        console.log(`Total Pending Shares: ${formatUnits(totalPendingShares, 18)}`);
        console.log(`Available Liquidity: $${formatUnits(liquidity, 6)}`);
        console.log('='.repeat(60));

        let foundPending = false;
        let totalUsdcPending = 0;

        for (let i = Number(head); i < Number(length); i++) {
            const request = await client.readContract({
                address: VAULT_ADDRESS,
                abi: vaultAbi,
                functionName: 'getWithdrawalRequest',
                args: [BigInt(i)],
            });

            if (request.shares > 0n) {
                foundPending = true;

                const shares = parseFloat(formatUnits(request.shares, 18));
                const usdcValue = shares * price;
                totalUsdcPending += usdcValue;

                const requestTime = Number(request.requestTimestamp);
                const matureTime = requestTime + Number(cooldown);
                const isMature = currentTimestamp >= matureTime;

                const timeToMature = matureTime - currentTimestamp;
                const hoursRemaining = timeToMature > 0 ? (timeToMature / 3600).toFixed(1) : '0.0';

                console.log(`Request #${i}:`);
                console.log(`  Requester: ${request.requester}`);
                console.log(`  Shares:    ${shares.toFixed(4)} (~$${usdcValue.toFixed(2)})`);
                console.log(`  Time:      ${new Date(requestTime * 1000).toLocaleString()}`);
                console.log(`  Status:    ${isMature ? 'MATURE (Ready to process)' : `MATURING in ${hoursRemaining} hours`}`);
                console.log(`  Maturity:  ${new Date(matureTime * 1000).toLocaleString()}`);
                console.log('-'.repeat(30));
            }
        }

        if (!foundPending) {
            console.log('No active pending withdrawals found.');
        } else {
            console.log('='.repeat(60));
            console.log(`TOTAL PENDING VALUE: ~$${totalUsdcPending.toFixed(2)}`);

            if (totalUsdcPending > parseFloat(formatUnits(liquidity, 6))) {
                console.log(`WARNING: Insufficient liquid USDC in vault! Need $${(totalUsdcPending - parseFloat(formatUnits(liquidity, 6))).toFixed(2)} more.`);
            } else {
                console.log('Liquidity sufficient for all pending withdrawals.');
            }
        }

    } catch (error) {
        console.error('Error fetching withdrawal data:', error.message);
        process.exit(1);
    }
}

checkWithdrawals();
