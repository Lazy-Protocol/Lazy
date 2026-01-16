import { encodeFunctionData, toHex } from 'viem';

// ============================================
// Lighter Contract Configuration
// ============================================

const LIGHTER_CONTRACT = '0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7';
const MULTISIG_ACCOUNT_INDEX = 702036;
const MULTISIG_ADDRESS = '0x0FBCe7F3678467f7F7313fcB2C9D1603431Ad666';

// ChangePubKey ABI
const changePubKeyAbi = [
  {
    inputs: [
      { name: '_accountIndex', type: 'uint48' },
      { name: '_apiKeyIndex', type: 'uint8' },
      { name: '_pubKey', type: 'bytes' },
    ],
    name: 'changePubKey',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
];

// ============================================
// Generate Safe Transaction Data
// ============================================

function generateSafeTransactionData(publicKeyHex, apiKeyIndex = 0) {
  // Encode the function call
  const calldata = encodeFunctionData({
    abi: changePubKeyAbi,
    functionName: 'changePubKey',
    args: [
      BigInt(MULTISIG_ACCOUNT_INDEX), // _accountIndex (uint48)
      apiKeyIndex, // _apiKeyIndex (uint8)
      publicKeyHex, // _pubKey (bytes)
    ],
  });

  return {
    to: LIGHTER_CONTRACT,
    value: '0',
    data: calldata,
  };
}

// ============================================
// Main
// ============================================

function main() {
  // Check if public key was provided as argument
  const publicKeyArg = process.argv[2];

  console.log('='.repeat(60));
  console.log('LIGHTER API KEY REGISTRATION FOR MULTISIG');
  console.log('='.repeat(60));
  console.log('');

  console.log('Account Configuration:');
  console.log(`  Lighter Contract: ${LIGHTER_CONTRACT}`);
  console.log(`  Account Index:    ${MULTISIG_ACCOUNT_INDEX}`);
  console.log(`  Multisig:         ${MULTISIG_ADDRESS}`);
  console.log('');

  if (!publicKeyArg) {
    console.log('='.repeat(60));
    console.log('STEP 1: Generate API Key Pair (using Lighter Python SDK)');
    console.log('='.repeat(60));
    console.log('');
    console.log('The Lighter SDK uses a proprietary key format. Generate keys with:');
    console.log('');
    console.log('  pip install git+https://github.com/elliottech/lighter-python.git');
    console.log('');
    console.log(`  python3 -c "import lighter; key = lighter.create_api_key(); print('Private:', key.private_key); print('Public:', key.public_key)"`);
    console.log('');
    console.log('='.repeat(60));
    console.log('STEP 2: Generate Safe Transaction');
    console.log('='.repeat(60));
    console.log('');
    console.log('Once you have the public key, run:');
    console.log('');
    console.log('  node scripts/lighter-api-key.js <PUBLIC_KEY_HEX>');
    console.log('');
    console.log('Example:');
    console.log('  node scripts/lighter-api-key.js 0x1234...abcd');
    console.log('');
    return;
  }

  // Generate transaction data with provided public key
  const tx = generateSafeTransactionData(publicKeyArg, 0);

  console.log('='.repeat(60));
  console.log('SAFE TRANSACTION DATA');
  console.log('='.repeat(60));
  console.log('');
  console.log('Transaction Details:');
  console.log(`  To:    ${tx.to}`);
  console.log(`  Value: ${tx.value} ETH`);
  console.log(`  Data:  ${tx.data}`);
  console.log('');

  console.log('='.repeat(60));
  console.log('INSTRUCTIONS');
  console.log('='.repeat(60));
  console.log('');
  console.log('Option A: Safe Transaction Builder');
  console.log('');
  console.log('1. Go to Safe Transaction Builder:');
  console.log(`   https://app.safe.global/eth:${MULTISIG_ADDRESS}/transactions/tx-builder`);
  console.log('');
  console.log('2. Click "Add new transaction" and enter:');
  console.log(`   - Enter Address: ${tx.to}`);
  console.log(`   - Enter ABI: (paste ABI below)`);
  console.log(`   - Method: changePubKey`);
  console.log(`   - _accountIndex: ${MULTISIG_ACCOUNT_INDEX}`);
  console.log(`   - _apiKeyIndex: 0`);
  console.log(`   - _pubKey: ${publicKeyArg}`);
  console.log('');
  console.log('3. Create batch, review, and execute');
  console.log('');

  console.log('Option B: Raw Transaction');
  console.log('');
  console.log('1. Go to New Transaction > Send custom:');
  console.log(`   https://app.safe.global/eth:${MULTISIG_ADDRESS}/transactions/queue`);
  console.log('');
  console.log('2. Enter:');
  console.log(`   - Contract: ${tx.to}`);
  console.log(`   - Value: 0`);
  console.log(`   - Data (hex): ${tx.data}`);
  console.log('');

  console.log('='.repeat(60));
  console.log('ABI FOR SAFE UI');
  console.log('='.repeat(60));
  console.log('');
  console.log(JSON.stringify(changePubKeyAbi, null, 2));
  console.log('');

  console.log('='.repeat(60));
  console.log('AFTER TRANSACTION EXECUTES');
  console.log('='.repeat(60));
  console.log('');
  console.log('Save your API credentials to .env:');
  console.log('');
  console.log('  LIGHTER_API_KEY=<your_private_key>');
  console.log(`  LIGHTER_ACCOUNT_INDEX=${MULTISIG_ACCOUNT_INDEX}`);
  console.log('  LIGHTER_API_KEY_INDEX=0');
  console.log('');
}

main();
