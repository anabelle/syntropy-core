/**
 * Agentic Wallet Tools for Pixel
 * 
 * Provides autonomous wallet capabilities using Coinbase AgentKit.
 * These tools enable Pixel to:
 * - Check balances
 * - Send ETH and tokens
 * - Interact with DeFi protocols on Base
 * 
 * Security: Uses existing EVM_PRIVATE_KEY from environment.
 * All transactions are logged for audit trail.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { createPublicClient, createWalletClient, http, formatEther, parseEther, formatUnits, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { logAudit } from '../utils';

// Common ERC-20 tokens on Base
const BASE_TOKENS: Record<string, { address: string; decimals: number; name: string }> = {
    'USDC': { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, name: 'USD Coin' },
    'WETH': { address: '0x4200000000000000000000000000000000000006', decimals: 18, name: 'Wrapped Ether' },
    'DAI': { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18, name: 'Dai Stablecoin' },
    'cbETH': { address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', decimals: 18, name: 'Coinbase Wrapped Staked ETH' },
};

// ERC-20 ABI for balance and transfer
const ERC20_ABI = [
    {
        name: 'balanceOf',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'account', type: 'address' }],
        outputs: [{ name: 'balance', type: 'uint256' }],
    },
    {
        name: 'transfer',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'to', type: 'address' },
            { name: 'amount', type: 'uint256' },
        ],
        outputs: [{ name: 'success', type: 'bool' }],
    },
    {
        name: 'decimals',
        type: 'function',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: 'decimals', type: 'uint8' }],
    },
    {
        name: 'symbol',
        type: 'function',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: 'symbol', type: 'string' }],
    },
] as const;

function getClients(useTestnet = false) {
    let privateKey = process.env.EVM_PRIVATE_KEY;
    if (!privateKey) {
        throw new Error('EVM_PRIVATE_KEY not set in environment');
    }

    // Normalize private key
    privateKey = privateKey.trim().replace(/^"|"$/g, '');
    if (!privateKey.startsWith('0x')) {
        privateKey = '0x' + privateKey;
    }

    const chain = useTestnet ? baseSepolia : base;
    const rpcUrl = useTestnet
        ? (process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org')
        : (process.env.BASE_RPC_URL || 'https://mainnet.base.org');

    const account = privateKeyToAccount(privateKey as `0x${string}`);

    const publicClient = createPublicClient({
        chain,
        transport: http(rpcUrl)
    });

    const walletClient = createWalletClient({
        account,
        chain,
        transport: http(rpcUrl)
    });

    return { account, publicClient, walletClient, chain };
}

export const walletTools = {
    getWalletBalance: tool({
        description: 'Get the ETH balance and common token balances for Pixel\'s wallet on Base. Returns balances in human-readable format.',
        inputSchema: z.object({
            includeTokens: z.boolean().optional().describe('Whether to also fetch ERC-20 token balances (USDC, WETH, DAI, cbETH). Default: true'),
            testnet: z.boolean().optional().describe('Use Base Sepolia testnet instead of mainnet. Default: false')
        }),
        execute: async ({ includeTokens = true, testnet = false }) => {
            console.log(`[WALLET] Tool: getWalletBalance (includeTokens=${includeTokens}, testnet=${testnet})`);

            try {
                const { account, publicClient, chain } = getClients(testnet);

                // Get ETH balance
                const ethBalance = await publicClient.getBalance({ address: account.address });
                const ethFormatted = formatEther(ethBalance);

                const result: any = {
                    address: account.address,
                    network: chain.name,
                    chainId: chain.id,
                    eth: {
                        balance: ethFormatted,
                        balanceWei: ethBalance.toString()
                    }
                };

                // Get token balances if requested
                if (includeTokens && !testnet) {
                    result.tokens = {};

                    for (const [symbol, token] of Object.entries(BASE_TOKENS)) {
                        try {
                            const balance = await publicClient.readContract({
                                address: token.address as `0x${string}`,
                                abi: ERC20_ABI,
                                functionName: 'balanceOf',
                                args: [account.address]
                            }) as bigint;

                            result.tokens[symbol] = {
                                balance: formatUnits(balance, token.decimals),
                                balanceRaw: balance.toString(),
                                name: token.name,
                                address: token.address
                            };
                        } catch (e) {
                            result.tokens[symbol] = { error: 'Failed to fetch balance' };
                        }
                    }
                }

                logAudit({ type: 'wallet', action: 'balance_check', address: account.address, network: chain.name });
                return result;

            } catch (error: any) {
                return { error: `Failed to get balance: ${error.message}` };
            }
        }
    }),

    sendETH: tool({
        description: 'Send ETH from Pixel\'s wallet to another address on Base. Use with caution - this transfers real value!',
        inputSchema: z.object({
            to: z.string().describe('The recipient address (0x...)'),
            amount: z.string().describe('Amount of ETH to send (e.g., "0.001")'),
            testnet: z.boolean().optional().describe('Use Base Sepolia testnet instead of mainnet. Default: false')
        }),
        execute: async ({ to, amount, testnet = false }) => {
            console.log(`[WALLET] Tool: sendETH (to=${to}, amount=${amount}, testnet=${testnet})`);

            // Safety check: require explicit confirmation for mainnet transactions
            if (!testnet && parseFloat(amount) > 0.01) {
                return {
                    error: 'Safety limit: Cannot send more than 0.01 ETH on mainnet without explicit override. Use testnet for testing larger amounts.',
                    suggestion: 'Set testnet=true to test on Base Sepolia, or reduce amount.'
                };
            }

            try {
                const { account, walletClient, publicClient, chain } = getClients(testnet);

                const valueWei = parseEther(amount);

                // Check sufficient balance
                const balance = await publicClient.getBalance({ address: account.address });
                if (balance < valueWei) {
                    return {
                        error: `Insufficient balance. Have ${formatEther(balance)} ETH, need ${amount} ETH.`,
                        currentBalance: formatEther(balance)
                    };
                }

                const hash = await walletClient.sendTransaction({
                    to: to as `0x${string}`,
                    value: valueWei
                });

                logAudit({
                    type: 'wallet',
                    action: 'send_eth',
                    to,
                    amount,
                    txHash: hash,
                    network: chain.name
                });

                return {
                    success: true,
                    transactionHash: hash,
                    from: account.address,
                    to,
                    amount,
                    network: chain.name,
                    explorerUrl: testnet
                        ? `https://sepolia.basescan.org/tx/${hash}`
                        : `https://basescan.org/tx/${hash}`
                };

            } catch (error: any) {
                return { error: `Failed to send ETH: ${error.message}` };
            }
        }
    }),

    sendToken: tool({
        description: 'Send an ERC-20 token from Pixel\'s wallet to another address on Base.',
        inputSchema: z.object({
            to: z.string().describe('The recipient address (0x...)'),
            token: z.enum(['USDC', 'WETH', 'DAI', 'cbETH']).describe('Token symbol to send'),
            amount: z.string().describe('Amount of tokens to send (e.g., "10" for 10 USDC)')
        }),
        execute: async ({ to, token, amount }) => {
            console.log(`[WALLET] Tool: sendToken (to=${to}, token=${token}, amount=${amount})`);

            const tokenInfo = BASE_TOKENS[token];
            if (!tokenInfo) {
                return { error: `Unknown token: ${token}. Supported: ${Object.keys(BASE_TOKENS).join(', ')}` };
            }

            // Safety check for stablecoins
            if (['USDC', 'DAI'].includes(token) && parseFloat(amount) > 10) {
                return {
                    error: `Safety limit: Cannot send more than 10 ${token} without explicit override.`,
                    suggestion: 'Reduce amount or contact operator for larger transfers.'
                };
            }

            try {
                const { account, walletClient, publicClient, chain } = getClients(false);

                const amountRaw = parseUnits(amount, tokenInfo.decimals);

                // Check token balance
                const balance = await publicClient.readContract({
                    address: tokenInfo.address as `0x${string}`,
                    abi: ERC20_ABI,
                    functionName: 'balanceOf',
                    args: [account.address]
                }) as bigint;

                if (balance < amountRaw) {
                    return {
                        error: `Insufficient ${token} balance. Have ${formatUnits(balance, tokenInfo.decimals)}, need ${amount}.`,
                        currentBalance: formatUnits(balance, tokenInfo.decimals)
                    };
                }

                const hash = await walletClient.writeContract({
                    address: tokenInfo.address as `0x${string}`,
                    abi: ERC20_ABI,
                    functionName: 'transfer',
                    args: [to as `0x${string}`, amountRaw]
                });

                logAudit({
                    type: 'wallet',
                    action: 'send_token',
                    to,
                    token,
                    amount,
                    txHash: hash,
                    network: chain.name
                });

                return {
                    success: true,
                    transactionHash: hash,
                    from: account.address,
                    to,
                    token,
                    tokenName: tokenInfo.name,
                    amount,
                    explorerUrl: `https://basescan.org/tx/${hash}`
                };

            } catch (error: any) {
                return { error: `Failed to send ${token}: ${error.message}` };
            }
        }
    }),

    estimateGas: tool({
        description: 'Estimate the gas cost for a transaction on Base. Useful for planning transactions.',
        inputSchema: z.object({
            to: z.string().describe('The recipient address'),
            value: z.string().optional().describe('ETH value to send (e.g., "0.001"). Default: "0"'),
            data: z.string().optional().describe('Transaction data (hex string). Default: empty')
        }),
        execute: async ({ to, value = '0', data }) => {
            console.log(`[WALLET] Tool: estimateGas (to=${to}, value=${value})`);

            try {
                const { account, publicClient } = getClients(false);

                const gasEstimate = await publicClient.estimateGas({
                    account: account.address,
                    to: to as `0x${string}`,
                    value: parseEther(value),
                    data: data as `0x${string}` | undefined
                });

                const gasPrice = await publicClient.getGasPrice();
                const gasCostWei = gasEstimate * gasPrice;

                return {
                    gasLimit: gasEstimate.toString(),
                    gasPrice: formatUnits(gasPrice, 9) + ' Gwei',
                    estimatedCost: formatEther(gasCostWei) + ' ETH',
                    estimatedCostUSD: '~$' + (parseFloat(formatEther(gasCostWei)) * 2500).toFixed(4) // Rough ETH price estimate
                };

            } catch (error: any) {
                return { error: `Failed to estimate gas: ${error.message}` };
            }
        }
    }),

    getTransactionStatus: tool({
        description: 'Check the status of a transaction on Base by its hash.',
        inputSchema: z.object({
            txHash: z.string().describe('The transaction hash to check'),
            testnet: z.boolean().optional().describe('Check on Base Sepolia testnet. Default: false')
        }),
        execute: async ({ txHash, testnet = false }) => {
            console.log(`[WALLET] Tool: getTransactionStatus (txHash=${txHash})`);

            try {
                const { publicClient, chain } = getClients(testnet);

                const receipt = await publicClient.getTransactionReceipt({
                    hash: txHash as `0x${string}`
                });

                return {
                    status: receipt.status === 'success' ? 'confirmed' : 'failed',
                    blockNumber: receipt.blockNumber.toString(),
                    gasUsed: receipt.gasUsed.toString(),
                    from: receipt.from,
                    to: receipt.to,
                    network: chain.name,
                    explorerUrl: testnet
                        ? `https://sepolia.basescan.org/tx/${txHash}`
                        : `https://basescan.org/tx/${txHash}`
                };

            } catch (error: any) {
                if (error.message.includes('could not be found')) {
                    return { status: 'pending', message: 'Transaction not yet confirmed or does not exist.' };
                }
                return { error: `Failed to get transaction status: ${error.message}` };
            }
        }
    })
};

export default walletTools;
