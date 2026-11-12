import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Transpile the pure production policy so these tests also run on Node 20,
// without adding a test runner or relying on Node's newer TS loader.
const source = await readFile(new URL('../src/lib/depositPolicy.ts', import.meta.url), 'utf8');
const {outputText} = ts.transpileModule(source, {compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
}});
const {createDepositPolicy} = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const snapshot = JSON.parse(await readFile(new URL('../src/config/grandfathered-depositors.json', import.meta.url), 'utf8'));
const invitations = JSON.parse(await readFile(new URL('../src/config/invited-depositors.json', import.meta.url), 'utf8'));
const vault = '0xd53B68fB4eb907c3c1E348CD7d7bEDE34f763805';
const newcomer = '0x1111111111111111111111111111111111111111';
const unknown = '0x2222222222222222222222222222222222222222';

test('production snapshot and invitations form a valid mainnet vault policy', () => {
  assert.equal(createDepositPolicy(snapshot, invitations, vault, 1).valid, true);
});

test('every grandfathered depositor retains access without any current-balance requirement', () => {
  const policy = createDepositPolicy(snapshot, [], vault, 1);
  for (const address of snapshot.depositors) {
    assert.equal(policy.access(address), 'allowed');
    assert.equal(policy.access(address.toLowerCase()), 'allowed');
  }
});

test('new wallets need an explicit invitation', () => {
  assert.equal(createDepositPolicy(snapshot, [], vault, 1).access(newcomer), 'invitation-required');
  const policy = createDepositPolicy(snapshot, [newcomer], vault, 1);
  assert.equal(policy.access(newcomer), 'allowed');
  assert.equal(policy.access(unknown), 'invitation-required');
});

test('disconnecting or supplying an invalid address never grants access', () => {
  const policy = createDepositPolicy(snapshot, [], vault, 1);
  assert.equal(policy.access(undefined), 'disconnected');
  assert.equal(policy.access(''), 'disconnected');
  assert.equal(policy.access('0x123'), 'invitation-required');
  assert.equal(policy.access('0x0000000000000000000000000000000000000000'), 'invitation-required');
});

test('share ownership and later deposits cannot expand the frozen policy', () => {
  const captured = structuredClone(snapshot);
  const policy = createDepositPolicy(captured, [], vault, 1);
  captured.depositors.push(newcomer);
  assert.equal(policy.access(newcomer), 'invitation-required');
});

test('malformed or missing configuration fails closed', () => {
  for (const [history, invites] of [[null, []], [snapshot, null], [snapshot, [newcomer, 'invalid']],
    [{...snapshot, depositors: []}, []], [{...snapshot, cutoffBlockHash: '0x123'}, []],
    [{...snapshot, totalDeposited: '0'}, []], [{...snapshot, depositCount: 0}, []]]) {
    const policy = createDepositPolicy(history, invites, vault, 1);
    assert.equal(policy.valid, false);
    assert.equal(policy.access(snapshot.depositors[0]), 'unavailable');
    assert.equal(policy.access(newcomer), 'unavailable');
  }
});

test('history for another chain or vault cannot authorize deposits', () => {
  assert.equal(createDepositPolicy({...snapshot, chainId: 10}, [], vault, 1).valid, false);
  assert.equal(createDepositPolicy({...snapshot, vault: unknown}, [], vault, 1).valid, false);
});
