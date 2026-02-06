import { tool } from 'ai';
import { z } from 'zod';
import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { logAudit } from '../utils';

// ERC-8004 Registry Addresses - CORRECT OFFICIAL DEPLOYMENTS
// Source: https://github.com/8004registry/8004-contracts
const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const REPUTATION_REGISTRY = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';

const IDENTITY_ABI = parseAbi([
    'function getRegistrationByOwner(address owner) view returns (uint256 tokenId, string registrationUrl)',
    'function hasAgent(address owner) view returns (bool)',
    'function register(string registrationUrl) public',
    'function ownerOf(uint256 tokenId) view returns (address owner)'
]);

export const baseTools = {
    getAgentAddress: tool({
        description: 'Get the EVM address associated with the agents private key. Use this to find the address for registration or checking status.',
        inputSchema: z.object({}),
        execute: async () => {
            console.log(`[SYNTROPY] Tool: getAgentAddress`);
            const privateKey = process.env.EVM_PRIVATE_KEY;
            if (!privateKey) {
                return { error: "EVM_PRIVATE_KEY not set in environment." };
            }
            try {
                const account = privateKeyToAccount(privateKey as `0x${string}`);
                return { address: account.address };
            } catch (error: any) {
                return { error: `Failed to derive address: ${error.message}` };
            }
        }
    }),

    checkERC8004Status: tool({
        description: 'Check the registration status of an agent on the ERC-8004 Identity Registry on Base.',
        inputSchema: z.object({
            address: z.string().describe('The EVM address to check. If not provided, will attempt to use the current agents address.')
        }),
        execute: async ({ address }) => {
            console.log(`[SYNTROPY] Tool: checkERC8004Status (address=${address})`);

            let targetAddress = address;
            if (!targetAddress) {
                const privateKey = process.env.EVM_PRIVATE_KEY;
                if (privateKey) {
                    targetAddress = privateKeyToAccount(privateKey as `0x${string}`).address;
                } else {
                    return { error: "No address provided and EVM_PRIVATE_KEY not set." };
                }
            }

            const rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
            const client = createPublicClient({
                chain: base,
                transport: http(rpcUrl)
            });

            try {
                // Try hasAgent first as it returns bool and is less likely to revert
                let isRegistered = false;
                try {
                    isRegistered = await client.readContract({
                        address: IDENTITY_REGISTRY as `0x${string}`,
                        abi: parseAbi(['function hasAgent(address) view returns (bool)']),
                        functionName: 'hasAgent',
                        args: [targetAddress as `0x${string}`]
                    }) as boolean;
                } catch (e) {
                    console.warn('[SYNTROPY] hasAgent check failed, falling back to getRegistrationByOwner');
                }

                const [tokenId, registrationUrl] = await client.readContract({
                    address: IDENTITY_REGISTRY as `0x${string}`,
                    abi: IDENTITY_ABI,
                    functionName: 'getRegistrationByOwner',
                    args: [targetAddress as `0x${string}`]
                }) as [bigint, string];

                if (tokenId === 0n && !isRegistered) {
                    return {
                        isRegistered: false,
                        address: targetAddress,
                        message: "Agent not found on registry."
                    };
                }

                return {
                    isRegistered: true,
                    address: targetAddress,
                    tokenId: tokenId.toString(),
                    registrationUrl,
                    message: "Agent is registered on Base."
                };
            } catch (error: any) {
                // If it reverts, it likely means NOT registered (some contracts revert on empty mapping)
                if (error.message.includes('revert')) {
                    return {
                        isRegistered: false,
                        address: targetAddress,
                        message: "Agent not found (contract reverted, likely unregistered)."
                    };
                }
                return { error: `Failed to check registry: ${error.message}` };
            }
        }
    }),

    registerAgentOnBase: tool({
        description: 'Register the agent on the ERC-8004 Identity Registry on Base Mainnet.',
        inputSchema: z.object({
            registrationUrl: z.string().describe('The URL to the agents registration metadata (e.g. /agent-registration.json). Defaults to https://pixel.xx.kg/agent-registration.json')
        }),
        execute: async ({ registrationUrl = 'https://pixel.xx.kg/agent-registration.json' }) => {
            console.log(`[SYNTROPY] Tool: registerAgentOnBase (url=${registrationUrl})`);

            let privateKey = process.env.EVM_PRIVATE_KEY;
            if (!privateKey) {
                return { error: "EVM_PRIVATE_KEY is not set. Registration requires gas and a signature." };
            }
            // Normalize private key
            privateKey = privateKey.trim().replace(/^"|"$/g, '');
            if (!privateKey.startsWith('0x')) {
                privateKey = '0x' + privateKey;
            }

            const rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
            const account = privateKeyToAccount(privateKey as `0x${string}`);

            const publicClient = createPublicClient({
                chain: base,
                transport: http(rpcUrl)
            });

            const walletClient = createWalletClient({
                account,
                chain: base,
                transport: http(rpcUrl)
            });

            try {
                // Bypass simulation which seems flaky for this proxy
                const data = encodeFunctionData({
                    abi: parseAbi(['function register(string registrationUrl) payable']),
                    functionName: 'register',
                    args: [registrationUrl]
                });


                const hash = await walletClient.sendTransaction({
                    account,
                    to: IDENTITY_REGISTRY as `0x${string}`,
                    data,
                    value: 0n
                });

                return {
                    success: true,
                    transactionHash: hash,
                    message: `Registration transaction submitted. Monitor at: https://basescan.org/tx/${hash}`
                };
            } catch (error: any) {
                return { error: `Registration failed: ${error.message}` };
            }
        }
    })
};
