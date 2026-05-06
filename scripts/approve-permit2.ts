import dotenv from "dotenv";
import { createPermit2ApprovalTx } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, formatUnits, getContract, http } from "viem";
import { base, baseSepolia } from "viem/chains";

dotenv.config();

const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;
const ERC20_READ_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value.trim();
}

function getNetwork(): "eip155:8453" | "eip155:84532" {
  const configured = process.env.X402_NETWORK?.trim();
  return configured === "eip155:84532" ? "eip155:84532" : "eip155:8453";
}

function getRpcUrl(network: "eip155:8453" | "eip155:84532"): string {
  const configured = process.env.BUYER_RPC_URL?.trim();
  if (configured) {
    return configured;
  }

  return network === "eip155:84532" ? "https://sepolia.base.org" : "https://mainnet.base.org";
}

function getUsdcAddress(network: "eip155:8453" | "eip155:84532"): `0x${string}` {
  if (network === "eip155:84532") {
    return "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  }

  return "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
}

async function main(): Promise<void> {
  const buyerPrivateKey = requireEnv("BUYER_PRIVATE_KEY") as `0x${string}`;
  const network = getNetwork();
  const rpcUrl = getRpcUrl(network);
  const tokenAddress = getUsdcAddress(network);

  const account = privateKeyToAccount(buyerPrivateKey);
  const chain = network === "eip155:84532" ? baseSepolia : base;

  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });

  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  });

  const token = getContract({
    address: tokenAddress,
    abi: ERC20_READ_ABI,
    client: publicClient,
  });

  const [balanceBefore, allowanceBefore] = await Promise.all([
    token.read.balanceOf([account.address]),
    token.read.allowance([account.address, PERMIT2_ADDRESS]),
  ]);

  console.log("Buyer address:", account.address);
  console.log("Network:", network);
  console.log("RPC URL:", rpcUrl);
  console.log("USDC token:", tokenAddress);
  console.log("Permit2 spender:", PERMIT2_ADDRESS);
  console.log("USDC balance (atomic):", balanceBefore.toString());
  console.log("USDC balance:", formatUnits(balanceBefore, 6));
  console.log("Permit2 allowance before (atomic):", allowanceBefore.toString());
  console.log("Permit2 allowance before:", formatUnits(allowanceBefore, 6));

  const approvalTx = createPermit2ApprovalTx(tokenAddress);

  const txHash = await walletClient.sendTransaction({
    to: approvalTx.to,
    data: approvalTx.data,
  });

  console.log("Approval transaction hash:", txHash);
  console.log("Waiting for confirmation...");

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  console.log("Approval confirmed in block:", receipt.blockNumber.toString());

  const allowanceAfter = await token.read.allowance([account.address, PERMIT2_ADDRESS]);

  console.log("Permit2 allowance after (atomic):", allowanceAfter.toString());
  console.log("Permit2 allowance after:", formatUnits(allowanceAfter, 6));
}

main().catch((error) => {
  console.error("Permit2 approval failed");
  console.error(error);
  process.exitCode = 1;
});
