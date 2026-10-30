require("@nomicfoundation/hardhat-toolbox");

// solc 0.8.24, cancun, optimizer 200, via-IR. (The live PandaFinancialVaultV2 was verified with 0.8.34,
// optimizer 200, no via-IR; this vault needs via-IR for its stack depth, so the settings deliberately differ.)
const FORK = process.env.FORK === "1";

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      viaIR: true,
      evmVersion: "cancun",
      optimizer: { enabled: true, runs: 200 }
    }
  },
  networks: {
    hardhat: FORK
      ? { forking: { url: process.env.RPC_URL || "https://mainnet.base.org", ...(process.env.FORK_BLOCK ? { blockNumber: Number(process.env.FORK_BLOCK) } : {}) }, hardfork: "cancun", chains: { 8453: { hardforkHistory: { cancun: 0 } } } }
      : { hardfork: "cancun" },
    base: {
      url: process.env.RPC_URL || "https://mainnet.base.org",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : []
    }
  },
  mocha: { timeout: 600000 }
};
