import { createPublicClient, createWalletClient, http, formatUnits, parseUnits } from 'viem';
import { mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

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
        name: 'availableLiquidity',
        type: 'function',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type: 'uint256' }],
    },
    {
        name: 'fulfillWithdrawals',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [{ name: 'count', type: 'uint256' }],
        outputs: [
            { name: 'processed', type: 'uint256' },
            { name: 'usdcPaid', type: 'uint256' }
        ],
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
    }
];

async function main() {
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
        console.error('Error: PRIVATE_KEY environment variable not set');
        process.exit(1);
    }

    // Get count from args or default to 5
    // Note: Argument is count, default seems robust enough
    const countArg = process.argv[2];
    const count = countArg ? parseInt(countArg) : 5;

    console.log('='.repeat(60));
    console.log('FULFILL WITHDRAWALS');
    console.log(`Vault: ${VAULT_ADDRESS}`);
    console.log(`RPC: ${RPC_URL}`);
    console.log('='.repeat(60));

    const account = privateKeyToAccount(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`);

    const client = createPublicClient({
        chain: mainnet,
        transport: http(RPC_URL),
    });

    const walletClient = createWalletClient({
        account,
        chain: mainnet,
        transport: http(RPC_URL),
    });

    console.log(`Operator: ${account.address}`);

    try {
        const [head, length, liquidity, cooldown] = await Promise.all([
            client.readContract({ address: VAULT_ADDRESS, abi: vaultAbi, functionName: 'withdrawalQueueHead' }),
            client.readContract({ address: VAULT_ADDRESS, abi: vaultAbi, functionName: 'withdrawalQueueLength' }),
            client.readContract({ address: VAULT_ADDRESS, abi: vaultAbi, functionName: 'availableLiquidity' }),
            client.readContract({ address: VAULT_ADDRESS, abi: vaultAbi, functionName: 'cooldownPeriod' }),
        ]);

        console.log(`Queue Head: ${head}`);
        console.log(`Queue Length: ${length}`);
        const pendingCount = Number(length) - Number(head);
        console.log(`Pending Requests: ${pendingCount}`);
        console.log(`Available Liquidity: $${formatUnits(liquidity, 6)}`);

        if (head >= length) {
            console.log('No pending active withdrawals (queue caught up).');
            return;
        }

        // Check maturity of the head request
        const nextRequest = await client.readContract({
            address: VAULT_ADDRESS,
            abi: vaultAbi,
            functionName: 'getWithdrawalRequest',
            args: [head],
        });

        // If shares is 0, it's processed, but head usually points to unprocessed.
        // However, if we fulfilled partially or head wasn't updated (should happen automatically), 
        // allow logic to handle it. fulfillWithdrawals skips 0-share requests.

        if (nextRequest.shares > 0n) {
            const currentTimestamp = Math.floor(Date.now() / 1000);
            const requestTime = Number(nextRequest.requestTimestamp);
            const matureTime = requestTime + Number(cooldown);

            if (currentTimestamp < matureTime) {
                const waitHours = (matureTime - currentTimestamp) / 3600;
                console.log(`\nNext request #${head} is NOT mature yet.`);
                console.log(`Requested: ${new Date(requestTime * 1000).toLocaleString()}`);
                console.log(`Matures:   ${new Date(matureTime * 1000).toLocaleString()} (in ${waitHours.toFixed(1)} hours)`);
                console.log('Cannot fulfill yet.');
                return;
            } else {
                console.log(`\nNext request #${head} is MATURE.`);
            }
        } else {
            console.log(`\nNext request #${head} has 0 shares (already processed). will be skipped.`);
        }

        console.log(`\nAttempting to fulfill up to ${count} withdrawals...`);

        // Simulate first
        console.log('Simulating transaction...');
        try {
            // We don't get 'result' property directly from simulateContract return in viem v2? 
            // maximize compatibility, checking return type.
            const { result } = await client.simulateContract({
                address: VAULT_ADDRESS,
                abi: vaultAbi,
                functionName: 'fulfillWithdrawals',
                args: [BigInt(count)],
                account: account.address,
            });
            console.log(`Simulation successful. Processed: ${result[0]}, USDC Paid: $${formatUnits(result[1], 6)}`);

            if (result[0] === 0n) {
                console.log('Simulation processed 0 requests. Maybe insufficient liquidity or all immature?');
                // We can still try to send if user really wants, but likely futile.
                // Check liquidity
                if (liquidity < 1000000n) { // Check against small amount or logic
                    console.log('Warning: Liquidity is very low.');
                }
            }

        } catch (e) {
            console.error('Simulation failed:', e.message);
            // Common reasons
            if (e.message.includes('InsufficientLiquidity')) {
                console.error('Reason: Insufficient Liquidity in Vault.');
            } else if (e.message.includes('QueueHeadRegression')) {
                console.error('Reason: Queue Head Regression (contract error).');
            }
            process.exit(1);
        }

        // Send transaction
        const hash = await walletClient.writeContract({
            address: VAULT_ADDRESS,
            abi: vaultAbi,
            functionName: 'fulfillWithdrawals',
            args: [BigInt(count)],
        });

        console.log(`\nTransaction sent: ${hash}`);
        console.log('Waiting for confirmation...');

        const receipt = await client.waitForTransactionReceipt({ hash });

        if (receipt.status === 'success') {
            console.log('Transaction confirmed!');
            console.log(`Block: ${receipt.blockNumber}`);
        } else {
            console.error('Transaction failed/reverted!');
        }

    } catch (error) {
        console.error('Fatal Error:', error.message);
        process.exit(1);
    }
}

main();
