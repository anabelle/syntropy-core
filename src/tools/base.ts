import { tool } from 'ai';
import { z } from 'zod';
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { logAudit } from '../utils';

// ERC-8004 Registry Addresses
const IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const REPUTATION_REGISTRY = '0x8004B663056A597Dffe9eCcC1965A193B7388713';

const IDENTITY_ABI = parseAbi([
    'function registerAgent(string calldata registrationUrl) external',
    'function getAgentByOwner(address owner) external view returns (uint256 tokenId, string memory registrationUrl)',
    'function ownerOf(uint256 tokenId) external view returns (address)'
]);

export const baseTools = {
    checkERC8004Status: tool({
        description: 'Check the registration status of an agent on the ERC-8004 Identity Registry on Base.',
        inputSchema: z.object({
            address: z.string().describe('The EVM address to check. If not provided, uses the current agent address.')
        }),
        execute: async ({ address }) => {
            console.log(`[SYNTROPY] Tool: checkERC8004Status (address=${address})`);

            const rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
            const client = createPublicClient({
                chain: base,
                transport: http(rpcUrl)
            });

            try {
                const [tokenId, registrationUrl] = await client.readContract({
                    address: IDENTITY_REGISTRY as `0x${string}`,
                    abi: IDENTITY_ABI,
                    functionName: 'getAgentByOwner',
                    args: [address as `0x${string}`]
                }) as [bigint, string];

                if (tokenId === 0n) {
                    return { registered: false, message: "No agent registered for this address." };
                }

                return {
                    registered: true,
                    tokenId: tokenId.toString(),
                    registrationUrl,
                    message: `Agent registered with Token ID ${tokenId}.`
                };
            } catch (error: any) {
                await logAudit({ type: 'base_error', error: error.message });
                return { error: `Failed to check registry: ${error.message}` };
            }
        }
    }),

    registerAgentOnBase: tool({
        description: 'Register the agent in the ERC-8004 Identity Registry on Base. Requires an EVM_PRIVATE_KEY with some ETH on Base for gas.',
        inputSchema: z.object({
            registrationUrl: z.string().describe('The URL to the agent registration JSON file (e.g., https://pixel.xx.kg/agent-registration.json)')
        }),
        execute: async ({ registrationUrl }) => {
            console.log(`[SYNTROPY] Tool: registerAgentOnBase`);

            const privateKey = process.env.EVM_PRIVATE_KEY;
            if (!privateKey) {
                return { error: "EVM_PRIVATE_KEY not set in environment." };
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
                const { request } = await publicClient.simulateContract({
                    account,
                    address: IDENTITY_REGISTRY as `0x${string}`,
                    abi: IDENTITY_ABI,
                    functionName: 'registerAgent',
                    args: [registrationUrl]
                });

                const hash = await walletClient.writeContract(request);

                await logAudit({ type: 'base_registration_sent', hash });

                return {
                    success: true,
                    hash,
                    message: "Registration transaction sent. Monitor on BaseScan: https://basescan.org/tx/" + hash
                };
            } catch (error: any) {
                await logAudit({ type: 'base_registration_error', error: error.message });
                return { error: `Registration failed: ${error.message}` };
            }
        }
    })
};
