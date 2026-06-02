// Deploy FaucetEgress on Hadrian + live-prove the primitive: drop an SPL mint
// into a FRESH Solana wallet's OWN ATA (owned by the wallet pubkey, visible in
// Phantom), signed by the operator (deployer, which holds the supply). This is
// the test — precompile contracts only run on a real Rome node.
//
//   ETH_PK=$(jq -r .privateKey ~/rome/.secrets/hadrian/deployer.json) \
//     ETHERSCAN_KEY=stub SNOWTRACE_KEY=stub MAINNET_QUICKNODE_LINK=stub \
//     UNICHAIN_QUICKNODE_LINK=stub LINEA_QUICKNODE_LINK=stub \
//     npx hardhat run scripts/faucet-egress/deploy-and-drive.ts --network hadrian
import { ethers } from 'hardhat';
import type { Contract } from 'ethers';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { deployContract } from '../_lib/gas';

const SOLANA_RPC = 'https://node1.devnet-eu-sol-api.devnet.romeprotocol.xyz';
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

// wBTC wrapper -> its underlying SPL mint (verified: 2gsErzRC...).
const WBTC_WRAPPER = '0xa000137fFcB2808aB6D2094c6f7Db5830c437883';
const MINT_ID_ABI = ['function mint_id() view returns (bytes32)'];
const DROP_AMOUNT = 1_000_000_000n; // 1 token @ 9 decimals

const LEGACY = { type: 0, gasPrice: 0n };
const b32 = (pk: PublicKey) => '0x' + Buffer.from(pk.toBytes()).toString('hex');
const ata = (mint: PublicKey, owner: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];

async function main() {
  const [operator] = await ethers.getSigners();
  console.log('operator (EVM):', operator.address);

  // Underlying mint of wBTC.
  const wrapper = new ethers.Contract(WBTC_WRAPPER, MINT_ID_ABI, operator);
  const mintHex: string = await wrapper.mint_id();
  const mint = new PublicKey(Buffer.from(mintHex.slice(2), 'hex'));
  console.log('mint:', mint.toBase58());

  // Fresh recipient Solana wallet (we only need its pubkey).
  const recipient = Keypair.generate().publicKey;
  const toAta = ata(mint, recipient);
  console.log('recipient (Phantom wallet):', recipient.toBase58());
  console.log('recipient ATA:', toAta.toBase58());

  const conn = new Connection(SOLANA_RPC, 'confirmed');
  const balBefore = await conn.getTokenAccountBalance(toAta).then((r) => r.value.amount).catch(() => null);
  console.log(`[RED] recipient ATA balance before: ${balBefore ?? '(no ATA)'}`);

  // 1. Deploy FaucetEgress (or reuse via EGRESS env to skip redeploy).
  const Egress = await ethers.getContractFactory('FaucetEgress', operator);
  let egress: Contract;
  if (process.env.EGRESS) {
    egress = Egress.attach(process.env.EGRESS) as Contract;
    console.log('FaucetEgress (reused):', egress.address);
  } else {
    egress = await deployContract<Contract>(Egress, [], { gasLimit: 20_000_000n, ...LEGACY });
    console.log('FaucetEgress (deployed):', egress.address);
  }

  // 2. drop(recipient, toAta, mint, amount) — one operator-signed tx.
  console.log(`drop(${DROP_AMOUNT} of wBTC -> recipient wallet)...`);
  const tx = await egress.drop(b32(recipient), b32(toAta), b32(mint), DROP_AMOUNT, { gasLimit: 6_000_000n, ...LEGACY });
  const rcpt = await tx.wait();
  console.log('  drop tx:', rcpt.transactionHash);

  // 3. GREEN: balance lands + ATA is owned by the recipient's own pubkey.
  const balAfter = await conn.getTokenAccountBalance(toAta).then((r) => r.value.amount).catch(() => null);
  const acct = await conn.getParsedAccountInfo(toAta);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const owner = (acct.value?.data as any)?.parsed?.info?.owner;
  console.log(`[GREEN] recipient ATA balance after: ${balAfter}`);
  console.log(`[GREEN] ATA owner: ${owner} (expect == recipient ${recipient.toBase58()})`);

  if (balAfter !== DROP_AMOUNT.toString()) throw new Error(`FAIL: balance ${balAfter} != ${DROP_AMOUNT}`);
  if (owner !== recipient.toBase58()) throw new Error(`FAIL: ATA owner ${owner} != recipient (not the user's own wallet!)`);
  console.log('\nPASS — SPL landed in the user\'s OWN Phantom wallet ATA, one operator tx, recipient signed nothing.');
}

main().catch((e) => { console.error(e); process.exit(1); });
